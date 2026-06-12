import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { SubscriptionService } from './subscription.service';
import {
  getUsagePlanQuota,
  type UsagePlanQuota,
} from '../config/usage-quota.config';

/**
 * Sprint 1.9 — Usage Tracking Foundation (DATA ONLY, NO ENFORCEMENT).
 *
 * Computes how many posts + AI generations a user has consumed in the current
 * billing period, alongside the display-only plan caps. Nothing here blocks,
 * throws-on-over-limit, or mutates state — it is pure measurement for the
 * dashboard panel. Quota *enforcement* is deferred to Phase 2 (Sprint 1.9b).
 *
 * Data sources (existing tables, no new tables required):
 *  - AI generations: `generated_content` rows created in the period.
 *  - Posts published: `generated_content` where publish_status='published'
 *    (covers both immediate publishes and scheduled publishes).
 *  - Posts scheduled (pending): `scheduled_posts` not-yet-terminal rows whose
 *    `scheduled_for` falls in the period.
 *  Published + pending-scheduled are non-overlapping (a row flips out of the
 *  pending set once published), so summing them does not double-count.
 */

export interface UsagePeriod {
  /** ISO timestamp — inclusive start of the current billing period. */
  start: string;
  /** ISO timestamp — exclusive end of the current billing period. */
  end: string;
}

export interface UsageMetric {
  used: number;
  /** Display cap; null => unlimited / no cap shown. NEVER enforced. */
  limit: number | null;
  /** Convenience for the UI; null when there is no limit. */
  percentUsed: number | null;
}

export interface UsageSummary {
  userId: string;
  planType: string;
  planDisplayName: string;
  period: UsagePeriod;
  posts: UsageMetric & {
    published: number;
    scheduledPending: number;
  };
  aiGenerations: UsageMetric;
  /** Always false in Phase 1 — usage is measured, never enforced. */
  enforced: false;
}

// Treat these scheduled_posts statuses as "still consuming a post slot" (the
// post is committed but not yet published). Terminal/published states are
// excluded so they're only counted once via the published bucket.
const PENDING_SCHEDULE_STATUSES = [
  'scheduled',
  'processing',
  'retrying',
  'pending',
];

@Injectable()
export class UsageTrackingService {
  private readonly logger = new Logger(UsageTrackingService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  /**
   * Current monthly billing-period window. We always use a MONTHLY window even
   * for yearly subscribers, because the displayed caps are "posts per month".
   * Anchored on the subscription start day-of-month (clamped to 28 to avoid
   * month-length surprises); falls back to the calendar month for users without
   * a subscription.
   */
  computeCurrentPeriod(subscriptionStartIso?: string | null): UsagePeriod {
    const now = new Date();

    let anchorDay = 1;
    if (subscriptionStartIso) {
      const startDate = new Date(subscriptionStartIso);
      if (!Number.isNaN(startDate.getTime())) {
        anchorDay = Math.min(28, Math.max(1, startDate.getUTCDate()));
      }
    }

    // Most recent occurrence of anchorDay at-or-before now (UTC).
    let periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), anchorDay, 0, 0, 0, 0),
    );
    if (periodStart.getTime() > now.getTime()) {
      periodStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, anchorDay, 0, 0, 0, 0),
      );
    }
    const periodEnd = new Date(
      Date.UTC(
        periodStart.getUTCFullYear(),
        periodStart.getUTCMonth() + 1,
        anchorDay,
        0,
        0,
        0,
        0,
      ),
    );

    return { start: periodStart.toISOString(), end: periodEnd.toISOString() };
  }

  private percent(used: number, limit: number | null): number | null {
    if (limit == null || limit <= 0) return null;
    return Math.min(100, Math.round((used / limit) * 100 * 100) / 100);
  }

  private async countRows(
    table: string,
    apply: (q: any) => any,
  ): Promise<number> {
    try {
      const query = this.supabaseService
        .getServiceClient()
        .from(table)
        .select('id', { count: 'exact', head: true });
      const { count, error } = await apply(query);
      if (error) {
        this.logger.warn(`Usage count failed for ${table}: ${error.message}`);
        return 0;
      }
      return count ?? 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Usage count threw for ${table}: ${msg}`);
      return 0;
    }
  }

  /**
   * Build the usage summary for a user. Resilient by design: any data-source
   * failure degrades to 0 for that metric rather than throwing, so the panel
   * always renders and NOTHING here can block a user action.
   */
  async getUsageSummary(userId: string): Promise<UsageSummary> {
    let planType = 'free';
    let subscriptionStart: string | null = null;
    try {
      const subscription =
        await this.subscriptionService.getUserSubscription(userId);
      if (subscription) {
        planType = subscription.planType || 'free';
        subscriptionStart = subscription.subscriptionStartDate || null;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not resolve subscription for ${userId}: ${msg}`);
    }

    const quota: UsagePlanQuota = getUsagePlanQuota(planType);
    const period = this.computeCurrentPeriod(subscriptionStart);

    const [aiGenerationsUsed, postsPublished, postsScheduledPending] =
      await Promise.all([
        this.countRows('generated_content', (q) =>
          q
            .eq('user_id', userId)
            .is('deleted_at', null)
            .gte('created_at', period.start)
            .lt('created_at', period.end),
        ),
        this.countRows('generated_content', (q) =>
          q
            .eq('user_id', userId)
            .is('deleted_at', null)
            .eq('publish_status', 'published')
            .gte('published_at', period.start)
            .lt('published_at', period.end),
        ),
        this.countRows('scheduled_posts', (q) =>
          q
            .eq('user_id', userId)
            .in('status', PENDING_SCHEDULE_STATUSES)
            .gte('scheduled_for', period.start)
            .lt('scheduled_for', period.end),
        ),
      ]);

    const postsUsed = postsPublished + postsScheduledPending;

    return {
      userId,
      planType,
      planDisplayName: quota.displayName,
      period,
      posts: {
        used: postsUsed,
        published: postsPublished,
        scheduledPending: postsScheduledPending,
        limit: quota.postsPerPeriod,
        percentUsed: this.percent(postsUsed, quota.postsPerPeriod),
      },
      aiGenerations: {
        used: aiGenerationsUsed,
        limit: quota.aiGenerationsPerPeriod,
        percentUsed: this.percent(
          aiGenerationsUsed,
          quota.aiGenerationsPerPeriod,
        ),
      },
      enforced: false,
    };
  }
}
