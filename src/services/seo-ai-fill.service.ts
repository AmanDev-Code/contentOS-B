import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SeoAiFillInput {
  route: string;
  prompt?: string;
  primaryKeyword?: string;
}

export interface SeoAiFillResult {
  meta_title: string;
  meta_description: string;
  h1_override: string;
  og_title: string;
  og_description: string;
}

@Injectable()
export class SeoAiFillService {
  private readonly logger = new Logger(SeoAiFillService.name);

  constructor(private readonly configService: ConfigService) {}

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
    const timeoutMs =
      Number(
        this.configService.get<number>('aiRefinement.timeoutMs') ||
          process.env.AI_REFINEMENT_TIMEOUT_MS ||
          '20000',
      ) || 20000;
    const referer =
      this.configService.get<string>('aiRefinement.referer') ||
      process.env.AI_REFINEMENT_REFERER ||
      '';
    const appTitle =
      this.configService.get<string>('aiRefinement.appTitle') ||
      process.env.AI_REFINEMENT_APP_TITLE ||
      'Trndinn';
    return { enabled, baseUrl, model, apiKey, timeoutMs, referer, appTitle };
  }

  private tryParseJson(text: string): Record<string, unknown> | null {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      /* continue */
    }
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim()) as Record<string, unknown>;
      } catch {
        /* continue */
      }
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<
          string,
          unknown
        >;
      } catch {
        return null;
      }
    }
    return null;
  }

  async generateSeoFields(input: SeoAiFillInput): Promise<SeoAiFillResult> {
    const cfg = this.getClientConfig();
    if (!cfg.enabled) {
      throw new ServiceUnavailableException('AI fill is disabled');
    }
    if (!cfg.apiKey) {
      throw new ServiceUnavailableException(
        'Missing API key: set OPENROUTER_API_KEY or AI_REFINEMENT_API_KEY',
      );
    }

    const systemPrompt =
      'You are an SEO expert. Generate optimized SEO metadata for a SaaS product called Trndinn ' +
      '(AI social media content platform, trndinn.com). ' +
      'Return valid JSON only with exactly these fields: ' +
      'meta_title (max 60 chars), meta_description (max 160 chars), ' +
      'h1_override (natural H1 containing primary keyword), og_title, og_description. ' +
      'Do not include structured_data_json unless asked. Output JSON only, no prose.';

    const userPrompt =
      input.prompt?.trim() ||
      [
        `Generate SEO fields for the page at route ${input.route}.`,
        `The page is about: [describe the page].`,
        input.primaryKeyword ? `Target keyword: ${input.primaryKeyword}.` : '',
      ]
        .filter(Boolean)
        .join(' ');

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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
      let response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.5,
          max_tokens: 600,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });

      // Some models don't support json_object response_format — retry without it
      if (!response.ok) {
        const errText = await response.text();
        if (
          response.status === 400 &&
          /response_format|json_object|json mode/i.test(errText)
        ) {
          response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: cfg.model,
              temperature: 0.5,
              max_tokens: 600,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
            }),
            signal: controller.signal,
          });
          if (!response.ok) {
            const err2 = await response.text();
            throw new BadRequestException(
              `AI request failed: ${response.status} ${err2.slice(0, 200)}`,
            );
          }
        } else {
          throw new BadRequestException(
            `AI request failed: ${response.status} ${errText.slice(0, 200)}`,
          );
        }
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = String(json?.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new BadRequestException('Empty AI response');

      const parsed = this.tryParseJson(text);
      if (!parsed || typeof parsed !== 'object') {
        throw new BadRequestException('AI returned invalid JSON for SEO fill');
      }

      const str = (k: string): string =>
        typeof parsed[k] === 'string' ? (parsed[k] as string).trim() : '';

      return {
        meta_title: str('meta_title'),
        meta_description: str('meta_description'),
        h1_override: str('h1_override'),
        og_title: str('og_title'),
        og_description: str('og_description'),
      };
    } catch (e: unknown) {
      const err = e as Error & { name?: string };
      if (err?.name === 'AbortError')
        throw new BadRequestException('AI request timed out');
      if (
        e instanceof BadRequestException ||
        e instanceof ServiceUnavailableException
      )
        throw e;
      throw new BadRequestException(err?.message || 'AI request failed');
    } finally {
      clearTimeout(timer);
    }
  }
}
