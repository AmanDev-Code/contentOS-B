import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AiGatewayService } from './ai-gateway.service';

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

  constructor(private readonly aiGateway: AiGatewayService) {}

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
    const { content } = await this.aiGateway.chatCompletionRaw({
      messages,
      temperature: 0.65,
      maxTokens: options.maxTokens ?? 2048,
      jsonObject: options.jsonObject,
      timeoutMs: 60_000,
    });
    if (!content) throw new BadRequestException('Empty AI response');
    return content;
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
      nice_to_have: 'Bullet list using "- " (3–8 items). Optional strengths.',
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
      throw new BadRequestException(
        'AI returned invalid JSON for all-sections',
      );
    }
    const out = {} as Record<JobCopyField, string>;
    for (const k of ALL_FIELDS) {
      const v = parsed[k];
      out[k] =
        typeof v === 'string' ? v.trim() : v != null ? String(v).trim() : '';
    }
    return out;
  }
}
