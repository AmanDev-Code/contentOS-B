import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type JobCopyField =
  | 'summary'
  | 'description'
  | 'responsibilities'
  | 'requirements'
  | 'nice_to_have'
  | 'benefits'
  | 'team_overview'
  | 'equity_notes';

export interface JobCopyContext {
  title: string;
  category?: string;
  location?: string;
  employment_type?: string;
  remote_option?: string;
  salary_band?: string;
  visa_sponsorship?: boolean;
}

const ALL_FIELDS: JobCopyField[] = [
  'summary',
  'description',
  'responsibilities',
  'requirements',
  'nice_to_have',
  'benefits',
  'team_overview',
  'equity_notes',
];

@Injectable()
export class CareersJobCopyAiService {
  private readonly logger = new Logger(CareersJobCopyAiService.name);

  constructor(private readonly configService: ConfigService) {}

  private buildModelList(primary: string): string[] {
    const extras = (process.env.AI_REFINEMENT_FALLBACK_MODELS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return Array.from(new Set([primary, ...extras].filter(Boolean)));
  }

  private llmErrorWarrantsModelSwitch(status: number, body: string): boolean {
    if (status === 404 || status === 503) return true;
    const b = body.toLowerCase();
    return (
      b.includes('no allowed providers') ||
      b.includes('model not found') ||
      b.includes('invalid model') ||
      b.includes('does not exist')
    );
  }

  private tryParseJson(text: string): any | null {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      /* continue */
    }
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim());
      } catch {
        /* continue */
      }
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }

  private getClientConfig() {
    const enabled =
      this.configService.get<boolean>('aiRefinement.enabled') !== false &&
      (process.env.AI_REFINEMENT_ENABLED || 'true') !== 'false';
    const baseUrl =
      this.configService.get<string>('aiRefinement.baseUrl') ||
      process.env.AI_REFINEMENT_BASE_URL ||
      'https://openrouter.ai/api/v1';
    const model =
      this.configService.get<string>('aiRefinement.model') ||
      process.env.AI_REFINEMENT_MODEL ||
      (String(baseUrl).includes('openrouter.ai')
        ? 'z-ai/glm-4.5-air:free'
        : 'gpt-4.1-mini');
    const apiKey =
      this.configService.get<string>('aiRefinement.apiKey') ||
      process.env.AI_REFINEMENT_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.OPENAI_API_KEY ||
      '';
    const configured =
      Number(
        this.configService.get<number>('aiRefinement.timeoutMs') ||
          process.env.AI_REFINEMENT_TIMEOUT_MS ||
          '12000',
      ) || 12000;
    /** Careers copy can be long; never below 60s so the model has time to finish. */
    const timeoutMs = Math.max(configured, 60000);
    const referer =
      this.configService.get<string>('aiRefinement.referer') ||
      process.env.AI_REFINEMENT_REFERER ||
      '';
    const appTitle =
      this.configService.get<string>('aiRefinement.appTitle') ||
      process.env.AI_REFINEMENT_APP_TITLE ||
      'Trndinn';
    return {
      enabled,
      baseUrl,
      model,
      apiKey,
      timeoutMs,
      referer,
      appTitle,
    };
  }

  private contextBlock(ctx: JobCopyContext): string {
    return [
      `Role title: ${ctx.title || '(untitled)'}`,
      `Category / team: ${ctx.category || '—'}`,
      `Location: ${ctx.location || '—'}`,
      `Employment type: ${ctx.employment_type || '—'}`,
      `Work arrangement: ${ctx.remote_option || '—'}`,
      `Compensation / equity (recruiter notes): ${ctx.salary_band || '—'}`,
      `Visa sponsorship: ${ctx.visa_sponsorship ? 'yes' : 'no / not stated'}`,
    ].join('\n');
  }

  private systemPrompt(): string {
    return [
      'You are an expert employer-brand and talent writer for Trndinn, a SaaS product that helps creators and teams with AI-assisted social content, scheduling, and analytics.',
      'Write careers-page copy: clear, specific, inclusive, credible. No hashtags.',
      'Use plain text: short paragraphs; you may use lines starting with "- " for bullets where appropriate.',
      'Do not invent specific tools, metrics, or customers unless provided in context. You may describe realistic responsibilities for the role type.',
      'Avoid clichés ("rockstar", "ninja", "family"). Be direct and human.',
    ].join(' ');
  }

  private async chat(
    messages: { role: 'system' | 'user'; content: string }[],
    options: { jsonObject?: boolean; maxTokens?: number },
  ): Promise<string> {
    const cfg = this.getClientConfig();
    if (!cfg.enabled) {
      throw new ServiceUnavailableException('AI copy generation is disabled');
    }
    if (!cfg.apiKey) {
      throw new ServiceUnavailableException(
        'Missing API key: set OPENROUTER_API_KEY or AI_REFINEMENT_API_KEY',
      );
    }
    const endpoint = `${String(cfg.baseUrl).replace(/\/$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    };
    if (String(cfg.baseUrl).includes('openrouter.ai')) {
      if (cfg.referer) headers['HTTP-Referer'] = cfg.referer;
      if (cfg.appTitle) {
        headers['X-Title'] = cfg.appTitle;
        headers['X-OpenRouter-Title'] = cfg.appTitle;
      }
    }

    const models = this.buildModelList(cfg.model);
    const maxTokens = options.maxTokens ?? 2048;

    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      const bodyJson = (useJsonObject: boolean) =>
        JSON.stringify({
          model: m,
          temperature: 0.65,
          max_tokens: maxTokens,
          ...(useJsonObject ? { response_format: { type: 'json_object' } } : {}),
          messages,
        });

      try {
        let response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: bodyJson(Boolean(options.jsonObject)),
          signal: controller.signal,
        });

        if (!response.ok) {
          let errText = await response.text();
          if (
            response.status === 400 &&
            options.jsonObject &&
            /response_format|json_object|response format|json mode/i.test(errText)
          ) {
            response = await fetch(endpoint, {
              method: 'POST',
              headers,
              body: bodyJson(false),
              signal: controller.signal,
            });
            if (!response.ok) errText = await response.text();
          }
          if (!response.ok) {
            const canRetry =
              this.llmErrorWarrantsModelSwitch(response.status, errText) &&
              i < models.length - 1;
            this.logger.warn(
              `Careers AI HTTP ${response.status} model=${m} ${errText.slice(0, 400)}`,
            );
            if (canRetry) continue;
            throw new BadRequestException(
              `AI request failed: ${response.status} ${errText.slice(0, 200)}`,
            );
          }
        }

        const json = (await response.json()) as any;
        const text = String(json?.choices?.[0]?.message?.content || '').trim();
        if (!text) {
          if (i < models.length - 1) continue;
          throw new BadRequestException('Empty AI response');
        }
        return text;
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          if (i < models.length - 1) continue;
          throw new BadRequestException('AI request timed out');
        }
        if (e instanceof BadRequestException) throw e;
        if (i < models.length - 1) continue;
        throw new BadRequestException(e?.message || 'AI request failed');
      } finally {
        clearTimeout(timer);
      }
    }
    throw new BadRequestException('AI request failed after model fallbacks');
  }

  async generateField(
    ctx: JobCopyContext,
    field: JobCopyField,
    existingDraft?: string,
  ): Promise<{ text: string }> {
    if (!ctx.title?.trim()) {
      throw new BadRequestException('Title is required to generate copy');
    }
    const fieldGuide: Record<JobCopyField, string> = {
      summary:
        '2–4 sentences. Hook the right candidate; say what they will own and impact.',
      description:
        '3–6 short paragraphs. What the product/team does, why this role exists, how success is measured at a high level.',
      responsibilities:
        'Bullet list using "- " lines (6–12 items). Concrete, outcome-oriented tasks.',
      requirements:
        'Bullet list using "- " (5–10 items). Must-haves: skills, experience, tools mindset.',
      nice_to_have:
        'Bullet list using "- " (3–8 items). Optional strengths.',
      benefits:
        'Bullet list using "- " (5–10 items). Realistic benefits for a growing SaaS (learning, flexibility, equity if mentioned in context, etc.).',
      team_overview:
        '2–4 short paragraphs. How the team works, collaboration, expectations.',
      equity_notes:
        '2–5 sentences. Clarify equity/ownership only from recruiter notes; if notes are vague, keep language honest and non-specific.',
    };

    const user = [
      'Generate ONLY the section requested. Output plain text only (no JSON, no markdown headings).',
      `Section: ${field.replace(/_/g, ' ')}`,
      `Guidance: ${fieldGuide[field]}`,
      '',
      '--- Job context ---',
      this.contextBlock(ctx),
      '',
      existingDraft?.trim()
        ? `--- Current draft (improve, keep facts, you may restructure) ---\n${existingDraft.trim()}`
        : '--- No draft yet; write from scratch using the context above.',
    ].join('\n');

    const text = await this.chat(
      [
        { role: 'system', content: this.systemPrompt() },
        { role: 'user', content: user },
      ],
      { jsonObject: false, maxTokens: field === 'description' ? 2500 : 1800 },
    );
    return { text: text.trim() };
  }

  async generateAllSections(
    ctx: JobCopyContext,
    existing?: Partial<Record<JobCopyField, string>>,
  ): Promise<Record<JobCopyField, string>> {
    if (!ctx.title?.trim()) {
      throw new BadRequestException('Title is required to generate copy');
    }
    const existingBlock = existing
      ? ALL_FIELDS.map((k) => {
          const v = existing[k]?.trim();
          return v ? `${k}:\n${v}\n` : '';
        })
          .filter(Boolean)
          .join('\n')
      : '';

    const user = [
      'Return strict JSON only with exactly these keys:',
      '{"summary":"","description":"","responsibilities":"","requirements":"","nice_to_have":"","benefits":"","team_overview":"","equity_notes":""}',
      'Each value is a plain string (use \\n for line breaks). Use "- " bullet lines inside string values where lists are appropriate.',
      'Lengths: summary compact; description richer; responsibilities and requirements as bullet lists.',
      '',
      '--- Job context ---',
      this.contextBlock(ctx),
      existingBlock
        ? `\n--- Existing drafts (improve and align; keep factual anchors) ---\n${existingBlock}`
        : '',
    ].join('\n');

    const raw = await this.chat(
      [
        { role: 'system', content: this.systemPrompt() },
        { role: 'user', content: user },
      ],
      { jsonObject: true, maxTokens: 6000 },
    );

    const parsed = this.tryParseJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new BadRequestException('AI returned invalid JSON for all-sections');
    }
    const out = {} as Record<JobCopyField, string>;
    for (const k of ALL_FIELDS) {
      const v = parsed[k];
      out[k] = typeof v === 'string' ? v.trim() : v != null ? String(v).trim() : '';
    }
    return out;
  }
}
