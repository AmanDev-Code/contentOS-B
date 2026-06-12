import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QuotaService } from './quota.service';
import { AiModelRegistryService } from './ai-model-registry.service';
import { AiGatewayService } from './ai-gateway.service';

/**
 * Brand Kit "Smart Import" (Sprint 1.5, Stage B).
 *
 * Takes arbitrary pasted text — a ChatGPT "give me my brand kit" dump, a
 * Tailwind/CSS color block, or freeform prose with typos — and uses the AI
 * gateway to clean it up and parse it into the structured Brand Kit fields the
 * UI can pre-fill (the user reviews before saving; nothing is persisted here).
 *
 * Gateway is ENV-DRIVEN via the shared `aiRefinement` config (same as
 * SeoAiFillService): AI_REFINEMENT_BASE_URL / _API_KEY / _MODEL. Point that at
 * local Docker Bifrost now, or a deployed Bifrost in prod — no code change.
 */

export interface ExtractedBrandKit {
  name?: string;
  tone?: string;
  targetAudience?: string;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  voiceExamples?: string[];
  doUse?: string[];
  doNotUse?: string[];
  additionalInformation?: string;
}

const EXTRACT_CREDIT_COST = 0.5;
const MAX_INPUT_CHARS = 20000;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

@Injectable()
export class BrandKitExtractionService {
  private readonly logger = new Logger(BrandKitExtractionService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly quotaService: QuotaService,
    private readonly aiModelRegistry: AiModelRegistryService,
    private readonly aiGateway: AiGatewayService,
  ) {}

  /** Env-driven gateway config — Bifrost-ready (mirrors SeoAiFillService). */
  private getClientConfig() {
    const enabled =
      this.configService.get<boolean>('aiRefinement.enabled') !== false &&
      (process.env.AI_REFINEMENT_ENABLED || 'true') !== 'false';
    const baseUrl =
      this.configService.get<string>('aiRefinement.baseUrl') ||
      process.env.AI_REFINEMENT_BASE_URL ||
      'https://openrouter.ai/api/v1';
    const model =
      this.aiModelRegistry.getActiveModelSync() ||
      (String(baseUrl).includes('openrouter.ai')
        ? 'openai/gpt-4o-mini'
        : 'gpt-4o-mini');
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
          '30000',
      ) || 30000;
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

  /**
   * Charge credits, call the gateway, parse + sanitize, refund on failure.
   * Returns a structured (unsaved) suggestion for the UI to review.
   */
  async extract(
    userId: string,
    rawText: string,
  ): Promise<{ extracted: ExtractedBrandKit; creditsCost: number }> {
    const text = (rawText || '').trim().slice(0, MAX_INPUT_CHARS);
    if (text.length < 5) {
      throw new HttpException(
        'Please paste a bit more text to extract from.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const cfg = this.getClientConfig();
    if (!cfg.enabled || !cfg.apiKey) {
      throw new ServiceUnavailableException(
        'AI Smart Import is not available right now.',
      );
    }

    const hasQuota = await this.quotaService.checkQuotaAvailable(
      userId,
      EXTRACT_CREDIT_COST,
    );
    if (!hasQuota) {
      throw new HttpException(
        {
          code: 'insufficient_credits',
          message: `Insufficient credits. Smart Import costs ${EXTRACT_CREDIT_COST} credits.`,
          requiredCredits: EXTRACT_CREDIT_COST,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    await this.quotaService.consumeCredits(
      userId,
      EXTRACT_CREDIT_COST,
      'Brand Kit Smart Import',
      'generation',
      'text',
    );

    try {
      const extracted = await this.callGateway(cfg, text);
      return { extracted, creditsCost: EXTRACT_CREDIT_COST };
    } catch (error) {
      await this.quotaService
        .consumeCredits(
          userId,
          -EXTRACT_CREDIT_COST,
          'Refund: Brand Kit Smart Import failed',
          'refund',
          'text',
        )
        .catch(() => undefined);
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Brand Kit extraction failed: ${(error as Error).message}`,
      );
      throw new HttpException(
        'We could not read that. Please try again or fill the fields manually.',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private async callGateway(
    cfg: ReturnType<BrandKitExtractionService['getClientConfig']>,
    text: string,
  ): Promise<ExtractedBrandKit> {
    void cfg; // transport now resolved by the shared gateway (text model chain)
    const systemPrompt = [
      'You extract a brand kit from arbitrary user-pasted text.',
      'The input may be: a ChatGPT-style brand kit, a Tailwind/CSS color config,',
      'marketing copy, or rough freeform notes with typos. Clean up spelling and',
      'grammar, then map the information into the brand fields.',
      '',
      'Return ONLY valid JSON (no prose, no markdown fences) with these keys:',
      '{',
      '  "name": string,                // brand/company/product name',
      '  "tone": string,                // voice description, 1-3 sentences',
      '  "targetAudience": string,',
      '  "primaryColor": string,        // hex like #1A2B3C',
      '  "secondaryColor": string,      // hex',
      '  "accentColor": string,         // hex',
      '  "voiceExamples": string[],     // up to 5 example posts/sentences',
      '  "doUse": string[],             // words/phrases to favor',
      '  "doNotUse": string[],          // words/phrases to avoid',
      '  "additionalInformation": string // any leftover useful context',
      '}',
      '',
      'Rules: Omit a key if you truly cannot infer it. Convert any color',
      '(named, rgb, hsl, Tailwind token) to #RRGGBB hex. Put anything that does',
      'not fit a specific field into additionalInformation. Keep arrays concise.',
    ].join('\n');

    // Bifrost gateway text chain: admin-managed model + automatic fallback to
    // the next configured text model on failure ("never fail").
    const { content } = await this.aiGateway.chatCompletionRaw({
      category: 'text',
      temperature: 0.2,
      maxTokens: 1200,
      jsonObject: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
    });
    const parsed = this.tryParseJson(content || '');
    if (!parsed) {
      throw new Error('could not parse model JSON');
    }
    return this.sanitize(parsed);
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

  private sanitize(raw: Record<string, unknown>): ExtractedBrandKit {
    const str = (v: unknown, max = 5000): string | undefined => {
      if (typeof v !== 'string') return undefined;
      const t = v.trim();
      return t ? t.slice(0, max) : undefined;
    };
    const color = (v: unknown): string | undefined => {
      const c = str(v, 9);
      if (!c) return undefined;
      const hex = c.startsWith('#') ? c : `#${c}`;
      return HEX_RE.test(hex) ? hex.toUpperCase() : undefined;
    };
    const arr = (v: unknown, maxItems: number, maxLen: number): string[] => {
      if (!Array.isArray(v)) return [];
      return v
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter(Boolean)
        .map((x) => x.slice(0, maxLen))
        .slice(0, maxItems);
    };

    const out: ExtractedBrandKit = {};
    const name = str(raw.name, 255);
    if (name) out.name = name;
    const tone = str(raw.tone, 2000);
    if (tone) out.tone = tone;
    const audience = str(raw.targetAudience, 2000);
    if (audience) out.targetAudience = audience;
    const primary = color(raw.primaryColor);
    if (primary) out.primaryColor = primary;
    const secondary = color(raw.secondaryColor);
    if (secondary) out.secondaryColor = secondary;
    const accent = color(raw.accentColor);
    if (accent) out.accentColor = accent;
    const examples = arr(raw.voiceExamples, 5, 5000);
    if (examples.length) out.voiceExamples = examples;
    const doUse = arr(raw.doUse, 50, 120);
    if (doUse.length) out.doUse = doUse;
    const doNotUse = arr(raw.doNotUse, 50, 120);
    if (doNotUse.length) out.doNotUse = doNotUse;
    const extra = str(raw.additionalInformation, 10000);
    if (extra) out.additionalInformation = extra;
    return out;
  }
}
