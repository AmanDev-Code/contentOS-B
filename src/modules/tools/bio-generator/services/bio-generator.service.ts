/**
 * BioGeneratorService — Orchestrates bio generation + scoring.
 *
 * - Rate limits per IP (15/hr) via CacheService.
 * - Fans out per-platform generation calls to the AI gateway in parallel.
 * - Parses strict JSON, enforces platform char limits, annotates output with
 *   keyword + buzzword findings so the frontend can highlight them.
 * - Scoring endpoint reuses the same gateway.
 */

import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

import { AiGatewayError, AiGatewayService } from '../../../../services/ai-gateway.service';
import { CacheService } from '../../../../services/cache.service';
import {
  BIO_GENERATOR_REDIS,
  BUZZWORDS,
  BioPlatform,
  LINKEDIN_RECRUITER_HINTS,
  PLATFORM_LIMITS,
  RATE_LIMITS,
} from '../config';
import type {
  BioGenerateInput,
  BioGenerateResult,
  BioPlatformResult,
  BioScoreInput,
  BioScoreResult,
  BioStreamEvent,
  BioVariation,
} from '../types';
import type { FeedbackBioDto } from '../dto/generate.dto';
import { BioFeedbackService } from './bio-feedback.service';
import { PromptBuilderService } from './prompt-builder.service';

@Injectable()
export class BioGeneratorService {
  private readonly logger = new Logger(BioGeneratorService.name);

  constructor(
    private readonly ai: AiGatewayService,
    private readonly cache: CacheService,
    private readonly prompts: PromptBuilderService,
    private readonly feedback: BioFeedbackService,
  ) {}

  /**
   * Record a thumbs-up / thumbs-down on a generated bio. Delegates to the
   * dedicated feedback service so this service stays focused on generation.
   * Returns only the vote accepted — counts are never surfaced to end users.
   */
  async recordFeedback(input: FeedbackBioDto, ip: string): Promise<{ vote: 'up' | 'down' }> {
    return this.feedback.record(input, ip);
  }

  /** Enforce per-IP rate limit. Dev mode bypasses. */
  async checkIpLimit(ip: string): Promise<{ allowed: boolean; reason?: string; remaining: number }> {
    if (process.env.NODE_ENV !== 'production') {
      return { allowed: true, remaining: RATE_LIMITS.maxPerIpPerHour };
    }
    const key = `${BIO_GENERATOR_REDIS.IP_COUNT}:${ip}`;
    const raw = await this.cache.get(key);
    const count = Number(raw ?? 0);
    if (count >= RATE_LIMITS.maxPerIpPerHour) {
      return {
        allowed: false,
        reason: `Rate limit reached (${RATE_LIMITS.maxPerIpPerHour}/hr). Wait an hour and try again — the tool stays free.`,
        remaining: 0,
      };
    }
    return { allowed: true, remaining: RATE_LIMITS.maxPerIpPerHour - count };
  }

  private async incrementIp(ip: string): Promise<void> {
    const key = `${BIO_GENERATOR_REDIS.IP_COUNT}:${ip}`;
    const raw = await this.cache.get(key);
    const next = Number(raw ?? 0) + 1;
    await this.cache.set(key, next, RATE_LIMITS.ttlSeconds);
  }

  /**
   * Generate bios for a single platform. Extracted so both the batch
   * `generate()` path and the streaming SSE path can share the exact
   * same code (single source of truth for the LLM call + parsing).
   */
  async generateOne(input: BioGenerateInput, platform: BioPlatform): Promise<{
    result: BioPlatformResult;
    model: string;
  }> {
    const { system, user } = this.prompts.buildGeneratePrompt(input, platform);
    const { content, model } = await this.ai.chatCompletionRaw({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.85,
      maxTokens: 1400,
      jsonObject: true,
      category: 'text',
    });
    const variations = this.parseAndAnnotate(content, platform);
    return {
      result: {
        platform,
        variations,
        limit: PLATFORM_LIMITS[platform].maxChars,
        softFold: PLATFORM_LIMITS[platform].softFold,
      },
      model,
    };
  }

  /** Main entry — generate bios for every requested platform in parallel. */
  async generate(input: BioGenerateInput, ip: string): Promise<BioGenerateResult> {
    const start = Date.now();
    const limit = await this.checkIpLimit(ip);
    if (!limit.allowed) {
      throw new HttpException(
        limit.reason ?? 'Rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const platforms = [...new Set(input.platforms)];
    let modelUsed = 'unknown';

    const settled = await Promise.allSettled(
      platforms.map((platform) =>
        this.generateOne(input, platform).then((res) => {
          modelUsed = res.model;
          return res.result;
        }),
      ),
    );

    const results: BioPlatformResult[] = [];
    const errors: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        errors.push(`${platforms[i]}: ${reason}`);
        this.logger.warn(`Bio generation failed for ${platforms[i]}: ${reason}`);
      }
    });

    if (results.length === 0) {
      throw new HttpException(
        errors[0] || 'Bio generation failed on every platform',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    await this.incrementIp(ip);

    return {
      generationId: crypto.randomUUID(),
      results,
      model: modelUsed,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Streaming path — kicks off all platform generations in parallel and yields
   * an async iterable of events as each one settles. The frontend renders each
   * platform's cards the moment they're ready, so users never wait on the
   * slowest platform to see anything.
   *
   * Rate-limit check + counter increment happen in the caller so the caller
   * can emit those as SSE events too.
   *
   * Yields event objects: 'start' (once) → 'platform' | 'error' (per platform,
   * as they complete, in completion order — NOT input order) → 'end' (once).
   */
  async *generateStream(
    input: BioGenerateInput,
    ip: string,
  ): AsyncGenerator<BioStreamEvent, void, unknown> {
    const start = Date.now();
    const limit = await this.checkIpLimit(ip);
    if (!limit.allowed) {
      yield {
        type: 'error',
        message: limit.reason ?? 'Rate limit exceeded',
        fatal: true,
      };
      return;
    }

    const platforms = [...new Set(input.platforms)];
    const generationId = crypto.randomUUID();

    yield {
      type: 'start',
      generationId,
      platforms,
    };

    // Wrap each platform generation into a promise that resolves with a
    // completion-tag so we can race them and stream in completion order.
    const inFlight = new Map<
      number,
      Promise<{ index: number; result?: BioPlatformResult; error?: string; model?: string }>
    >();

    platforms.forEach((platform, index) => {
      inFlight.set(
        index,
        this.generateOne(input, platform)
          .then(({ result, model }) => ({ index, result, model }))
          .catch((err) => ({
            index,
            error: err instanceof Error ? err.message : String(err),
          })),
      );
    });

    let successCount = 0;
    let modelUsed = 'unknown';

    // Race the in-flight promises: as each settles, yield its event, then remove
    // it from the map. Loop until the map is empty.
    while (inFlight.size > 0) {
      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled.index);
      const platform = platforms[settled.index]!;

      if (settled.error) {
        this.logger.warn(`Bio streaming: platform ${platform} failed: ${settled.error}`);
        yield {
          type: 'error',
          platform,
          message: settled.error,
          fatal: false,
        };
      } else if (settled.result) {
        successCount++;
        if (settled.model) modelUsed = settled.model;
        yield {
          type: 'platform',
          platform,
          result: settled.result,
        };
      }
    }

    if (successCount === 0) {
      yield {
        type: 'error',
        message: 'Bio generation failed on every platform',
        fatal: true,
      };
      return;
    }

    // Only bump the IP counter once, and only after at least one platform
    // succeeded — same behavior as the batch path.
    await this.incrementIp(ip);

    yield {
      type: 'end',
      generationId,
      model: modelUsed,
      durationMs: Date.now() - start,
      succeeded: successCount,
      failed: platforms.length - successCount,
    };
  }

  /** Score a single bio on the 5-dimension rubric with 3 improvement tips. */
  async score(input: BioScoreInput, ip: string): Promise<BioScoreResult> {
    const limit = await this.checkIpLimit(ip);
    if (!limit.allowed) {
      throw new HttpException(
        limit.reason ?? 'Rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { system, user } = this.prompts.buildScorePrompt(input);
    let parsed: any;
    try {
      const { content } = await this.ai.chatCompletionRaw({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        maxTokens: 500,
        jsonObject: true,
        category: 'text',
      });
      parsed = this.safeParseJson(content);
    } catch (e) {
      if (e instanceof AiGatewayError) {
        throw new HttpException(e.message, HttpStatus.SERVICE_UNAVAILABLE);
      }
      throw e;
    }

    const dims = {
      hook: this.clampScore(parsed?.hook),
      clarity: this.clampScore(parsed?.clarity),
      platformFit: this.clampScore(parsed?.platformFit),
      impact: this.clampScore(parsed?.impact),
      originality: this.clampScore(parsed?.originality),
    };
    const overall = Math.round(
      (dims.hook + dims.clarity + dims.platformFit + dims.impact + dims.originality),
    ); // sum of 5 × 0-20 = 0-100
    const tips = Array.isArray(parsed?.tips)
      ? parsed.tips.slice(0, 3).map((t: unknown) => String(t).slice(0, 240))
      : [];

    return { overall, dimensions: dims, tips };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private parseAndAnnotate(content: string, platform: BioPlatform): BioVariation[] {
    const parsed = this.safeParseJson(content);
    const items: unknown[] = Array.isArray(parsed?.bios) ? parsed.bios : [];
    return items
      .map((raw) => this.toVariation(raw, platform))
      .filter((v): v is BioVariation => Boolean(v));
  }

  private toVariation(raw: unknown, platform: BioPlatform): BioVariation | null {
    if (!raw || typeof raw !== 'object') return null;
    const text = String((raw as any).text ?? '').trim();
    if (!text) return null;
    const charCount = [...text].length; // Unicode-safe
    const { maxChars } = PLATFORM_LIMITS[platform];
    const buzzwordsFound = this.findBuzzwords(text);
    const keywordsFound = platform === 'linkedin' ? this.findLinkedInKeywords(text) : undefined;

    return {
      text,
      charCount,
      keywordsFound,
      buzzwordsFound,
      withinLimit: charCount <= maxChars,
    };
  }

  private safeParseJson(content: string): any {
    // Strip common wrappers (```json, backticks) that some models emit.
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      // Last-ditch attempt: pull the first {...} block.
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          /* fall through */
        }
      }
      this.logger.warn(`Could not parse LLM JSON: ${cleaned.slice(0, 200)}`);
      return {};
    }
  }

  private findBuzzwords(text: string): string[] {
    const lower = text.toLowerCase();
    return BUZZWORDS.filter((b) => lower.includes(b));
  }

  private findLinkedInKeywords(text: string): string[] {
    // Very lightweight — flag common recruiter-friendly patterns present.
    const found: string[] = [];
    const lower = text.toLowerCase();
    const roleWords = [
      'engineer', 'developer', 'designer', 'manager', 'director', 'founder',
      'lead', 'senior', 'principal', 'vp', 'head of', 'consultant', 'strategist',
      'analyst', 'architect', 'writer', 'marketer', 'operator', 'product',
    ];
    for (const w of roleWords) if (lower.includes(w)) found.push(w);
    // Numbers like "10+ years", "$5M ARR", "200+ shipped" — strong signals.
    if (/\d+(?:\+|k|m|b|%|x)/i.test(text)) found.push('quantified impact');
    if (/\bex[-\s]?[a-z]/i.test(text)) found.push('ex-company');
    return [...new Set(found)];
  }

  private clampScore(v: unknown): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(20, Math.round(n)));
  }

  /** Static — expose LinkedIn hints for documentation / debug endpoints. */
  static readonly LINKEDIN_HINTS = LINKEDIN_RECRUITER_HINTS;
}
