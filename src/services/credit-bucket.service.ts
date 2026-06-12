import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { CacheService } from './cache.service';
import { AppSettingsService } from './app-settings.service';
import { SubscriptionService } from './subscription.service';
import { getPlanDisplayName } from '../modules/credits/credit-costs';

/**
 * Sprint 1.9b — multi-bucket credit balances (trial / plan / reward).
 *
 * Authoritative for the NEW credit balance. Backed by the additive
 * `credit_buckets` table and the atomic `apply_credit_charge` /
 * `ensure_credit_buckets` SQL functions. The legacy `credit_transactions`
 * ledger + `user_quota_view` remain intact (the charge RPC still writes audit
 * rows so the old view stays consistent).
 *
 * Deduction order on any charge: trial (expiring) -> plan -> reward.
 */

export type BucketType = 'trial' | 'plan' | 'reward';

export interface CreditBalance {
  userId: string;
  trial: number;
  plan: number;
  reward: number;
  total: number;
  /** Trial expiry timestamp (ISO) — null when no trial bucket. */
  trialExpiresAt: string | null;
  /** Next plan reset boundary (ISO) — null when no plan bucket. */
  planResetsAt: string | null;
  planType: string;
  planDisplayName: string;
  /** Start of the current plan period (ISO) — for "consumed this period". */
  periodStart: string | null;
  /** Credits consumed (net of refunds) since the current period start. */
  consumedThisPeriod: number;
  /** Consumed credits broken down by operation_type (post_now/schedule/generation/...). */
  consumptionByType: Record<string, number>;
}

interface ChargeRpcResult {
  trial: number;
  plan: number;
  reward: number;
  total: number;
}

@Injectable()
export class CreditBucketService {
  private readonly logger = new Logger(CreditBucketService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
    private readonly appSettingsService: AppSettingsService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  private balanceCacheKey(userId: string): string {
    return `credit:balance:${userId}`;
  }

  private async getTrialDefault(): Promise<number> {
    try {
      return await this.appSettingsService.getFreeCreditLimit();
    } catch {
      return 50;
    }
  }

  /** Ensure buckets exist + monthly plan reset is applied (idempotent). */
  async ensureBuckets(userId: string): Promise<void> {
    const trialDefault = await this.getTrialDefault();
    const { error } = await this.supabaseService
      .getServiceClient()
      .rpc('ensure_credit_buckets', {
        p_user_id: userId,
        p_trial_default: trialDefault,
      });
    if (error) {
      this.logger.error(`ensure_credit_buckets failed for ${userId}: ${error.message}`);
    }
  }

  /**
   * Current bucket balance for a user. Ensures buckets first (lazy init +
   * reset), then reads the authoritative `user_credit_balance_view`.
   */
  async getBalance(
    userId: string,
    options?: { bypassCache?: boolean },
  ): Promise<CreditBalance> {
    const cacheKey = this.balanceCacheKey(userId);
    if (!options?.bypassCache) {
      const cached = await this.cacheService.get(cacheKey);
      if (cached) {
        const parsed =
          typeof cached === 'string'
            ? (JSON.parse(cached) as CreditBalance)
            : (cached as CreditBalance);
        return parsed;
      }
    }

    await this.ensureBuckets(userId);

    let planType = 'free';
    try {
      const sub = await this.subscriptionService.getUserSubscription(userId);
      if (sub?.planType) planType = sub.planType;
    } catch {
      // fall back to free for display only
    }

    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('user_credit_balance_view')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      this.logger.error(`getBalance view read failed for ${userId}: ${error.message}`);
    }

    const planResetsAt: string | null = data?.plan_resets_at ?? null;
    const periodStart = this.computePeriodStart(planResetsAt);
    const { consumed, byType } = await this.computeConsumption(userId, periodStart);

    const balance: CreditBalance = {
      userId,
      trial: Number(data?.trial_credits ?? 0),
      plan: Number(data?.plan_credits ?? 0),
      reward: Number(data?.reward_credits ?? 0),
      total: Number(data?.total_balance ?? 0),
      trialExpiresAt: data?.trial_expires_at ?? null,
      planResetsAt,
      planType,
      planDisplayName: getPlanDisplayName(planType),
      periodStart: periodStart.toISOString(),
      consumedThisPeriod: consumed,
      consumptionByType: byType,
    };

    await this.cacheService.set(cacheKey, JSON.stringify(balance), 60);
    return balance;
  }

  /**
   * Start of the current billing period. Anchored one month before the next
   * plan reset boundary; falls back to the first of the calendar month.
   */
  private computePeriodStart(planResetsAt: string | null): Date {
    if (planResetsAt) {
      const next = new Date(planResetsAt);
      if (!Number.isNaN(next.getTime())) {
        const start = new Date(next);
        start.setUTCMonth(start.getUTCMonth() - 1);
        return start;
      }
    }
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  /** Sum debits (net of refunds) since periodStart, grouped by operation_type. */
  private async computeConsumption(
    userId: string,
    periodStart: Date,
  ): Promise<{ consumed: number; byType: Record<string, number> }> {
    try {
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('credit_transactions')
        .select('transaction_type, amount, operation_type')
        .eq('user_id', userId)
        .gte('created_at', periodStart.toISOString());

      if (error || !Array.isArray(data)) {
        return { consumed: 0, byType: {} };
      }

      const byType: Record<string, number> = {};
      let consumed = 0;
      for (const row of data as Array<{
        transaction_type?: string;
        amount?: number | string;
        operation_type?: string | null;
      }>) {
        const amount = Math.abs(Number(row.amount ?? 0));
        if (!amount) continue;
        const op = row.operation_type ?? 'other';
        if (row.transaction_type === 'debit') {
          consumed += amount;
          byType[op] = (byType[op] ?? 0) + amount;
        } else if (row.transaction_type === 'refund') {
          consumed -= amount;
          byType[op] = (byType[op] ?? 0) - amount;
        }
      }
      consumed = Math.max(0, Math.round(consumed * 100) / 100);
      for (const key of Object.keys(byType)) {
        byType[key] = Math.round(byType[key] * 100) / 100;
        if (byType[key] <= 0) delete byType[key];
      }
      return { consumed, byType };
    } catch {
      return { consumed: 0, byType: {} };
    }
  }

  async invalidate(userId: string): Promise<void> {
    await this.cacheService.delete(this.balanceCacheKey(userId));
  }

  /**
   * Apply a credit charge against the buckets. `transactionType`:
   *   - 'debit'  : deduct in order trial -> plan -> reward.
   *   - 'refund' : add back (to metadata.refund_bucket, else plan).
   *   - 'credit' : admin/reward grant -> reward bucket.
   * Returns the fresh balance snapshot.
   */
  async applyCharge(params: {
    userId: string;
    transactionType: 'debit' | 'refund' | 'credit';
    amount: number;
    description: string;
    operationType?: string | null;
    contentType?: string | null;
    contentId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<ChargeRpcResult> {
    const trialDefault = await this.getTrialDefault();
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .rpc('apply_credit_charge', {
        p_user_id: params.userId,
        p_content_id: params.contentId ?? null,
        p_transaction_type: params.transactionType,
        p_amount: Math.abs(params.amount),
        p_description: params.description,
        p_operation_type: params.operationType ?? null,
        p_content_type: params.contentType ?? null,
        p_metadata: params.metadata ?? {},
        p_trial_default: trialDefault,
      });

    if (error) {
      this.logger.error(
        `apply_credit_charge failed user=${params.userId} type=${params.transactionType} amount=${params.amount}: ${error.message}`,
      );
      throw new Error(`Credit bucket charge failed: ${error.message}`);
    }

    await this.invalidate(params.userId);

    const result = (data ?? { trial: 0, plan: 0, reward: 0, total: 0 }) as ChargeRpcResult;
    return result;
  }
}
