import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

import { CacheService } from './cache.service';
import { SupabaseService } from './supabase.service';

/**
 * Tool Feedback Service — Star ratings + messages per tool.
 *
 * Three-layer "has given feedback" check:
 * 1. Redis (fast, 30-day TTL)
 * 2. Supabase (persistent source of truth)
 *
 * Frontend adds localStorage as layer 0 for instant client-side gating.
 * Anonymous users identified by stable IP hash (fixed salt from env).
 */
@Injectable()
export class ToolFeedbackService {
  private readonly logger = new Logger(ToolFeedbackService.name);
  private readonly REDIS_PREFIX = 'tool-feedback:given';
  private readonly REDIS_TTL = 30 * 24 * 60 * 60; // 30 days
  private readonly TABLE = 'tool_feedback';

  constructor(
    private readonly cache: CacheService,
    private readonly supabase: SupabaseService,
  ) {}

  /**
   * Check if this user/IP has already given feedback for a tool.
   * Returns true if eligible (has NOT given feedback yet).
   */
  async checkEligibility(
    toolSlug: string,
    userId?: string,
    ip?: string,
  ): Promise<boolean> {
    const identifier = this.resolveIdentifier(userId, ip);
    if (!identifier) return false;

    // Layer 1: Redis (fast)
    const redisKey = this.buildRedisKey(toolSlug, identifier);
    const cached = await this.cache.get(redisKey);
    if (cached !== null) {
      return false; // Already given
    }

    // Layer 2: Supabase (persistent)
    const client = this.supabase.getServiceClient();
    const { data } = await client
      .from(this.TABLE)
      .select('id')
      .eq('tool_slug', toolSlug)
      .eq('identifier', identifier)
      .maybeSingle();

    if (data) {
      // Exists in DB but not in Redis — repopulate cache
      await this.cache.set(redisKey, '1', this.REDIS_TTL);
      return false;
    }

    return true; // Eligible — has not given feedback
  }

  /**
   * Submit tool feedback.
   */
  async submit(params: {
    toolSlug: string;
    rating: number;
    message?: string;
    userId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { toolSlug, rating, message, userId, ip, userAgent } = params;

    if (rating < 1 || rating > 5) {
      return { success: false, error: 'Rating must be between 1 and 5' };
    }

    const identifier = this.resolveIdentifier(userId, ip);
    if (!identifier) {
      return { success: false, error: 'Could not identify user' };
    }

    const identifierType = userId ? 'user' : 'anonymous';

    try {
      const client = this.supabase.getServiceClient();

      // Upsert — allows updating feedback if user gives it again via manual button
      const { error } = await client.from(this.TABLE).upsert(
        {
          tool_slug: toolSlug,
          identifier,
          identifier_type: identifierType,
          rating,
          message: message?.trim() || null,
          user_agent: userAgent || null,
          created_at: new Date().toISOString(),
        },
        { onConflict: 'tool_slug,identifier' },
      );

      if (error) {
        this.logger.error(`Tool feedback submit failed: ${error.message}`);
        return { success: false, error: 'Failed to save feedback' };
      }

      // Set Redis cache so we don't ask again
      const redisKey = this.buildRedisKey(toolSlug, identifier);
      await this.cache.set(redisKey, '1', this.REDIS_TTL);

      this.logger.log(
        `Tool feedback: ${toolSlug} rated ${rating}★ by ${identifierType} ${identifier.slice(0, 8)}...`,
      );

      return { success: true };
    } catch (err) {
      this.logger.error(`Tool feedback error: ${(err as Error).message}`);
      return { success: false, error: 'Internal error saving feedback' };
    }
  }

  /**
   * Admin: Get paginated feedback for a tool (or all tools).
   */
  async listFeedback(params: {
    toolSlug?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    items: any[];
    total: number;
    stats: { average: number; count: number; distribution: Record<number, number> };
  }> {
    const { toolSlug, page = 1, limit = 20 } = params;
    const offset = (page - 1) * limit;
    const client = this.supabase.getServiceClient();

    let query = client
      .from(this.TABLE)
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (toolSlug) {
      query = query.eq('tool_slug', toolSlug);
    }

    const { data, error, count } = await query;

    if (error) {
      this.logger.error(`Admin list feedback error: ${error.message}`);
      return { items: [], total: 0, stats: { average: 0, count: 0, distribution: {} } };
    }

    // Get stats (separate query for aggregate)
    const stats = await this.getStats(toolSlug);

    return {
      items: data || [],
      total: count || 0,
      stats,
    };
  }

  /**
   * Admin: Get aggregate stats for a tool.
   */
  async getStats(toolSlug?: string): Promise<{
    average: number;
    count: number;
    distribution: Record<number, number>;
  }> {
    const client = this.supabase.getServiceClient();

    let query = client.from(this.TABLE).select('rating');
    if (toolSlug) {
      query = query.eq('tool_slug', toolSlug);
    }

    const { data } = await query;
    const ratings = (data || []).map((r: { rating: number }) => r.rating);

    if (ratings.length === 0) {
      return { average: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    }

    const sum = ratings.reduce((a: number, b: number) => a + b, 0);
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of ratings) {
      distribution[r] = (distribution[r] || 0) + 1;
    }

    return {
      average: Math.round((sum / ratings.length) * 10) / 10,
      count: ratings.length,
      distribution,
    };
  }

  /**
   * Admin: Get all tool slugs that have received feedback.
   */
  async getToolsWithFeedback(): Promise<string[]> {
    const client = this.supabase.getServiceClient();
    const { data } = await client
      .from(this.TABLE)
      .select('tool_slug')
      .limit(100);

    if (!data) return [];
    return [...new Set(data.map((r: { tool_slug: string }) => r.tool_slug))];
  }

  /**
   * Resolve user identifier: prefer userId, fallback to stable IP hash.
   */
  private resolveIdentifier(userId?: string, ip?: string): string | null {
    if (userId) return `user_${userId}`;
    if (ip) return `ip_${this.hashIp(ip)}`;
    return null;
  }

  /**
   * Stable IP hash with fixed salt (NOT daily rotating).
   * Must persist across sessions so "already given" check works.
   */
  private hashIp(ip: string): string {
    const salt = process.env.TOOL_FEEDBACK_SALT || 'trndinn-tool-feedback-v1';
    return createHash('sha256').update(`${ip}::${salt}`).digest('hex').slice(0, 16);
  }

  private buildRedisKey(toolSlug: string, identifier: string): string {
    return `${this.REDIS_PREFIX}:${toolSlug}:${identifier}`;
  }
}
