import {
  BadRequestException,
  Injectable,
  Logger,
  ConflictException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SupabaseService } from './supabase.service';
import { QuotaService } from './quota.service';
import { CacheService } from './cache.service';
import { QUEUE_NAMES } from '../common/constants';

const MS_24H = 24 * 60 * 60 * 1000;
const CREDITS_REWARD_TEXT =
  'Submit your rating and optional feedback — we add 100 bonus credits to your account about 24 hours after you submit.';
const ADMIN_FEEDBACK_CACHE_PREFIX = 'admin:feedback:list:';

export type FeedbackEligibilityReason = 'none' | 'first_time' | 'reminder';

export interface FeedbackEligibilityDto {
  showPopup: boolean;
  reason: FeedbackEligibilityReason;
  creditsRewardText: string;
}

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly quotaService: QuotaService,
    private readonly cacheService: CacheService,
    @InjectQueue(QUEUE_NAMES.FEEDBACK_REWARD)
    private readonly rewardQueue: Queue,
  ) {}

  async recordFirstAction(
    userId: string,
  ): Promise<{ promptSuggested: boolean }> {
    const client = this.supabaseService.getServiceClient();

    const { data: existing } = await client
      .from('feedback_eligibility')
      .select('user_id, first_action_completed_at, feedback_submitted_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (existing?.feedback_submitted_at) {
      return { promptSuggested: false };
    }

    if (existing?.first_action_completed_at) {
      return { promptSuggested: false };
    }

    const now = new Date().toISOString();
    const { error } = await client.from('feedback_eligibility').upsert(
      {
        user_id: userId,
        first_action_completed_at: now,
        feedback_pending: false,
      },
      { onConflict: 'user_id' },
    );

    if (error) {
      this.logger.warn(`recordFirstAction upsert: ${error.message}`);
    }

    return { promptSuggested: true };
  }

  async getEligibility(userId: string): Promise<FeedbackEligibilityDto> {
    const row = await this.getEligibilityRow(userId);

    if (row.feedback_submitted_at) {
      return {
        showPopup: false,
        reason: 'none',
        creditsRewardText: CREDITS_REWARD_TEXT,
      };
    }

    if (!row.first_action_completed_at) {
      return {
        showPopup: false,
        reason: 'none',
        creditsRewardText: CREDITS_REWARD_TEXT,
      };
    }

    if (!row.feedback_pending) {
      return {
        showPopup: true,
        reason: 'first_time',
        creditsRewardText: CREDITS_REWARD_TEXT,
      };
    }

    if (!row.last_feedback_prompt_at) {
      return {
        showPopup: true,
        reason: 'first_time',
        creditsRewardText: CREDITS_REWARD_TEXT,
      };
    }

    const nextMs = new Date(row.last_feedback_prompt_at).getTime() + MS_24H;
    if (Date.now() >= nextMs) {
      return {
        showPopup: true,
        reason: 'reminder',
        creditsRewardText: CREDITS_REWARD_TEXT,
      };
    }

    return {
      showPopup: false,
      reason: 'none',
      creditsRewardText: CREDITS_REWARD_TEXT,
    };
  }

  private async getEligibilityRow(userId: string) {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('feedback_eligibility')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      this.logger.warn(`getEligibilityRow: ${error.message}`);
    }

    return (
      data || {
        user_id: userId,
        first_action_completed_at: null,
        feedback_submitted_at: null,
        feedback_pending: false,
        last_feedback_prompt_at: null,
      }
    );
  }

  async skipFeedback(userId: string): Promise<void> {
    const row = await this.getEligibilityRow(userId);
    if (!row.first_action_completed_at) {
      return;
    }
    if (row.feedback_submitted_at) {
      return;
    }

    const now = new Date().toISOString();
    const client = this.supabaseService.getServiceClient();

    const { error } = await client.from('feedback_eligibility').upsert(
      {
        user_id: userId,
        first_action_completed_at: row.first_action_completed_at,
        feedback_pending: true,
        last_feedback_prompt_at: now,
      },
      { onConflict: 'user_id' },
    );

    if (error) {
      throw new BadRequestException(error.message);
    }
  }

  async submitFeedback(
    userId: string,
    body: { rating: number; message?: string },
  ): Promise<{ feedbackId: string }> {
    const rating = Math.floor(Number(body.rating));
    if (rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    const client = this.supabaseService.getServiceClient();
    const elig = await this.getEligibilityRow(userId);

    if (!elig.first_action_completed_at) {
      throw new BadRequestException(
        'Feedback is available after your first post or scheduled post.',
      );
    }

    if (elig.feedback_submitted_at) {
      throw new ConflictException('Feedback already submitted');
    }

    const now = new Date().toISOString();

    const { data: inserted, error: insertErr } = await client
      .from('product_feedback')
      .insert({
        user_id: userId,
        rating,
        message: body.message?.trim() || null,
        first_action_at: elig.first_action_completed_at,
      })
      .select('id')
      .single();

    if (insertErr) {
      if (insertErr.code === '23505') {
        throw new ConflictException('Feedback already submitted');
      }
      throw new BadRequestException(insertErr.message);
    }

    const { error: upErr } = await client.from('feedback_eligibility').upsert(
      {
        user_id: userId,
        feedback_submitted_at: now,
        feedback_pending: false,
        last_feedback_prompt_at: now,
      },
      { onConflict: 'user_id' },
    );

    if (upErr) {
      this.logger.error(`submitFeedback eligibility: ${upErr.message}`);
    }

    await this.rewardQueue.add(
      'apply-reward',
      { feedbackId: inserted.id, userId },
      {
        delay: MS_24H,
        jobId: `feedback-reward-${inserted.id}`,
        removeOnComplete: true,
        attempts: 3,
      },
    );

    return { feedbackId: inserted.id };
  }

  async applyFeedbackReward(feedbackId: string): Promise<boolean> {
    const client = this.supabaseService.getServiceClient();

    const { data: row, error: selErr } = await client
      .from('product_feedback')
      .select('id, user_id, rewarded')
      .eq('id', feedbackId)
      .single();

    if (selErr || !row) {
      this.logger.warn(`applyFeedbackReward missing row ${feedbackId}`);
      return false;
    }

    if (row.rewarded) {
      return false;
    }

    const { data: updated, error: updErr } = await client
      .from('product_feedback')
      .update({ rewarded: true })
      .eq('id', feedbackId)
      .eq('rewarded', false)
      .select('id')
      .maybeSingle();

    if (updErr || !updated) {
      return false;
    }

    // Sprint 1.9b: feedback rewards are a grant, so route through
    // grantCredits -> the never-expiring REWARD bucket (operation_type
    // 'feedback_reward'). The old logTransaction call only wrote a
    // credit_transactions audit row and was NOT bucket-aware, so the credits
    // never landed in (or counted toward) the authoritative bucket balance.
    await this.quotaService.grantCredits(
      row.user_id,
      100,
      'Product feedback bonus (100 credits)',
      'feedback_reward',
      { source: 'feedback', feedback_id: feedbackId },
    );

    return true;
  }

  /** Admin list + aggregates with optional simple cache key */
  async adminListFeedback(params: {
    page: number;
    limit: number;
    rating?: number;
    cacheBuster?: boolean;
  }) {
    const page = Math.max(1, params.page);
    const limit = Math.min(100, Math.max(1, params.limit));
    const cacheKey = `${ADMIN_FEEDBACK_CACHE_PREFIX}${page}:${limit}:${params.rating ?? 'all'}`;

    if (!params.cacheBuster) {
      const cached = await this.cacheService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as Awaited<
          ReturnType<FeedbackService['adminListFeedbackUncached']>
        >;
      }
    }

    const result = await this.adminListFeedbackUncached({
      page,
      limit,
      rating: params.rating,
    });

    await this.cacheService.set(cacheKey, JSON.stringify(result), 60);
    return result;
  }

  private async adminListFeedbackUncached(params: {
    page: number;
    limit: number;
    rating?: number;
  }) {
    const client = this.supabaseService.getServiceClient();
    const offset = (params.page - 1) * params.limit;

    let q = client
      .from('product_feedback')
      .select(
        'id, user_id, rating, message, rewarded, first_action_at, created_at',
        {
          count: 'exact',
        },
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + params.limit - 1);

    if (params.rating !== undefined) {
      q = q.eq('rating', params.rating);
    }

    const { data: rows, error, count } = await q;

    if (error) {
      throw new BadRequestException(error.message);
    }

    const stats = await this.computeAggregateStats();

    return {
      items: rows || [],
      total: count ?? 0,
      page: params.page,
      limit: params.limit,
      stats,
    };
  }

  private async computeAggregateStats() {
    const client = this.supabaseService.getServiceClient();
    const { data: all } = await client
      .from('product_feedback')
      .select('rating, created_at');

    const list = (all || []) as { rating: number; created_at: string }[];
    const n = list.length;
    const avgRating =
      n === 0 ? null : list.reduce((a, r) => a + r.rating, 0) / n;

    const promoters = list.filter((r) => r.rating >= 4).length;
    const detractors = list.filter((r) => r.rating <= 2).length;
    const npsApprox =
      n === 0 ? null : Math.round(((promoters - detractors) / n) * 100);

    const byDay: Record<string, number> = {};
    for (const r of list) {
      const d = (r.created_at || '').slice(0, 10);
      if (d) byDay[d] = (byDay[d] || 0) + 1;
    }

    return {
      avg_rating: avgRating,
      count: n,
      nps_approx: npsApprox,
      count_by_day: byDay,
    };
  }
}
