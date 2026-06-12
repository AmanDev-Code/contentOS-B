import { Injectable, Logger } from '@nestjs/common';
import { AiGatewayService } from '../../services/ai-gateway.service';
import { AiModelRegistryService } from '../../services/ai-model-registry.service';
import { parseJsonFromLlmPayload } from '../../common/utils/parse-json-from-llm';

export type TavilyFreshness = 'day' | 'week' | 'month' | 'year';
export type TavilyTopic = 'general' | 'news' | 'finance';

export interface FormattedPrompt {
  /**
   * The user's prompt cleaned up: grammar + punctuation fixed and structured,
   * with EVERY entity / keyword / number preserved. Falls back to the raw topic
   * when no formatter model is configured or the call fails.
   */
  cleaned: string;
  /** Whether the cleaned text actually came from the formatter model. */
  formatted: boolean;
  /** Recency window the search should use, if the request is time-sensitive. */
  freshness?: TavilyFreshness;
  /** Tavily search agent best suited to the request. */
  tavilyTopic?: TavilyTopic;
  /** Model that produced the cleaned text (for logging/meta). */
  usedModel?: string;
}

interface FormatterJson {
  cleaned_prompt?: unknown;
  freshness?: unknown;
  topic?: unknown;
}

/**
 * Cleans a raw user prompt with a cheap, dedicated "AI Formatter" model before
 * it reaches web search and generation.
 *
 * Goals:
 *  - Fix grammar + punctuation, structure the request clearly.
 *  - NEVER strip keywords, entities, numbers, or change meaning.
 *  - Also classify recency (so Tavily can be tuned for the freshest data).
 *
 * Always best-effort: any failure returns the original topic unchanged so
 * generation never breaks. Uses the dedicated `text_formatter` registry
 * category so admins choose a separate cheap model (not the primary text model).
 */
@Injectable()
export class PromptFormatterService {
  private readonly logger = new Logger(PromptFormatterService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly registry: AiModelRegistryService,
  ) {}

  /** True when an admin has configured at least one AI Formatter model. */
  isConfigured(): boolean {
    return this.registry.hasModelsSync('text_formatter');
  }

  async format(rawTopic: string): Promise<FormattedPrompt> {
    const raw = (rawTopic || '').trim();
    if (!raw) return { cleaned: raw, formatted: false };

    // No dedicated formatter configured → send the FULL raw prompt through
    // unchanged (never silently borrow the expensive primary text model).
    if (!this.isConfigured()) {
      this.logger.log(
        'AI Formatter: no text_formatter model configured — passing raw prompt through unchanged',
      );
      return { cleaned: raw, formatted: false };
    }

    try {
      const { content, model } = await this.aiGateway.chatCompletionRaw({
        category: 'text_formatter',
        temperature: 0.1,
        maxTokens: 900,
        jsonObject: true,
        timeoutMs: 20_000,
        messages: [
          { role: 'system', content: this.systemPrompt() },
          { role: 'user', content: raw },
        ],
      });

      const parsed = parseJsonFromLlmPayload(content) as FormatterJson | null;
      const cleaned = this.coerceCleaned(parsed?.cleaned_prompt, raw);

      // Anti-stripping guard: if the model returned something much shorter than
      // the input, it likely summarized/dropped content — keep the original.
      if (cleaned.length < Math.floor(raw.length * 0.5)) {
        this.logger.warn(
          `AI Formatter output looked stripped (${cleaned.length} < ${raw.length} chars) — keeping raw prompt`,
        );
        return { cleaned: raw, formatted: false, usedModel: model };
      }

      const freshness = this.coerceFreshness(parsed?.freshness);
      const tavilyTopic = this.coerceTopic(parsed?.topic);

      this.logger.log(
        `AI Formatter cleaned prompt via ${model} (freshness=${freshness ?? 'none'} topic=${tavilyTopic ?? 'general'})`,
      );
      return {
        cleaned,
        formatted: true,
        freshness,
        tavilyTopic,
        usedModel: model,
      };
    } catch (e) {
      this.logger.warn(
        `AI Formatter failed (non-blocking): ${(e as Error).message} — using raw prompt`,
      );
      return { cleaned: raw, formatted: false };
    }
  }

  private systemPrompt(): string {
    return [
      'You are a PROMPT FORMATTER. You receive a user\'s raw content request and',
      'return a cleaned, well-structured version of THE SAME request.',
      '',
      'STRICT RULES:',
      '1. Fix grammar, spelling, punctuation, and capitalization.',
      '2. Rewrite it into clear, well-formed sentences with proper structure.',
      '3. PRESERVE EVERYTHING that carries meaning: every entity, brand, product,',
      '   person, place, date, number, and keyword the user wrote. Do NOT drop or',
      '   shorten them. Expand obvious abbreviations only when unambiguous.',
      '4. Do NOT summarize, do NOT remove keywords, do NOT change the intent, and',
      '   do NOT answer the request or write the post. Only clean and structure it.',
      '5. Do NOT add new facts, opinions, hashtags, or instructions.',
      '',
      'Also classify recency so a web search can fetch the freshest sources:',
      '- "freshness": one of "day", "week", "month", "year", or "none".',
      '    Use a tight window (day/week) for breaking news, live events, or',
      '    anything explicitly "latest/today/upcoming". Use "none" for timeless',
      '    or evergreen topics.',
      '- "topic": one of "news", "finance", or "general".',
      '    "news" for current events / launches / events, "finance" for markets/',
      '    money, otherwise "general".',
      '',
      'Respond with ONLY this JSON object and nothing else:',
      '{"cleaned_prompt": "<the cleaned request>", "freshness": "day|week|month|year|none", "topic": "news|finance|general"}',
    ].join('\n');
  }

  private coerceCleaned(value: unknown, fallback: string): string {
    if (typeof value === 'string' && value.trim()) return value.trim();
    return fallback;
  }

  private coerceFreshness(value: unknown): TavilyFreshness | undefined {
    if (value === 'day' || value === 'week' || value === 'month' || value === 'year') {
      return value;
    }
    return undefined;
  }

  private coerceTopic(value: unknown): TavilyTopic | undefined {
    if (value === 'news' || value === 'finance' || value === 'general') {
      return value;
    }
    return undefined;
  }
}
