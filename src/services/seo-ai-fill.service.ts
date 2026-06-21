import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiGatewayService } from './ai-gateway.service';

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

  constructor(private readonly aiGateway: AiGatewayService) {}

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

    try {
      const { content: text } = await this.aiGateway.chatCompletionRaw({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.5,
        maxTokens: 600,
        jsonObject: true,
        timeoutMs: 20_000,
      });

      if (!text) throw new BadRequestException('Empty AI response');

      const parsed = this.tryParseJson(text);
      if (!parsed || typeof parsed !== 'object') {
        throw new BadRequestException('AI returned invalid JSON for SEO fill');
      }

      const str = (k: string): string =>
        typeof parsed[k] === 'string' ? parsed[k].trim() : '';

      return {
        meta_title: str('meta_title'),
        meta_description: str('meta_description'),
        h1_override: str('h1_override'),
        og_title: str('og_title'),
        og_description: str('og_description'),
      };
    } catch (e: unknown) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(
        (e as Error)?.message || 'AI request failed',
      );
    }
  }
}
