import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { CacheService } from './cache.service';
import { AppSettingsService } from './app-settings.service';
import { CreditBucketService } from './credit-bucket.service';

export interface UserQuota {
  userId: string;
  totalCredits: number;
  usedCredits: number;
  remainingCredits: number;
  percentageUsed: number;
  planType: 'free' | 'standard' | 'pro' | 'ultimate';
  resetDate: Date;
}

export interface QuotaLimits {
  free: number;
  standard: number;
  pro: number;
  ultimate: number;
}

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);
  private readonly quotaLimits: QuotaLimits = {
    free: 50, // Default, will be overridden by app settings
    standard: 500,
    pro: 2000,
    ultimate: 10000,
  };

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
    private readonly appSettingsService: AppSettingsService,
    private readonly creditBucketService: CreditBucketService,
  ) {}

  /**
   * Sprint 1.9b: overlay the authoritative multi-bucket balance onto a legacy
   * quota object so `remainingCredits` everywhere reflects trial+plan+reward.
   * Resilient: any failure leaves the legacy (user_quota_view) numbers intact.
   */
  private async overlayBucketBalance(
    userId: string,
    base: UserQuota,
  ): Promise<UserQuota> {
    try {
      const balance = await this.creditBucketService.getBalance(userId);
      const remaining = balance.total;
      const total = Math.max(base.totalCredits, remaining);
      const used = Math.max(0, total - remaining);
      const percentageUsed =
        total > 0 ? Math.round((used / total) * 100 * 100) / 100 : 0;
      return {
        ...base,
        totalCredits: total,
        usedCredits: used,
        remainingCredits: remaining,
        percentageUsed,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`overlayBucketBalance failed for ${userId}: ${msg}`);
      return base;
    }
  }

  private async getFreeCreditLimit(): Promise<number> {
    return this.appSettingsService.getFreeCreditLimit();
  }

  /** Normalize view rows, Redis cache JSON, or legacy shapes into `UserQuota`. */
  private coerceUserQuota(
    raw: Record<string, unknown>,
    userId: string,
  ): UserQuota {
    const resetRaw = raw.resetDate ?? raw.reset_date;
    const resetDate =
      resetRaw instanceof Date
        ? resetRaw
        : new Date(
            typeof resetRaw === 'string' || typeof resetRaw === 'number'
              ? resetRaw
              : Date.now(),
          );

    return {
      userId: String(raw.userId ?? raw.user_id ?? userId),
      totalCredits: Number(raw.totalCredits ?? raw.total_credits ?? 0),
      usedCredits: Number(raw.usedCredits ?? raw.used_credits ?? 0),
      remainingCredits: Number(
        raw.remainingCredits ?? raw.remaining_credits ?? 0,
      ),
      percentageUsed: Number(raw.percentageUsed ?? raw.percentage_used ?? 0),
      planType: (raw.planType ?? raw.plan_type ?? 'free') as UserQuota['planType'],
      resetDate,
    };
  }

  async getUserQuota(
    userId: string,
    options?: { bypassCache?: boolean },
  ): Promise<UserQuota> {
    const cacheKey = `quota:${userId}`;

    if (!options?.bypassCache) {
      const cachedQuota = await this.cacheService.get(cacheKey);
      if (cachedQuota) {
        const parsed =
          typeof cachedQuota === 'string'
            ? (JSON.parse(cachedQuota) as Record<string, unknown>)
            : (cachedQuota as Record<string, unknown>);
        return this.coerceUserQuota(parsed, userId);
      }
    }

    // Get dynamic free credit limit
    const freeCreditLimit = await this.getFreeCreditLimit();

    try {
      // Use the user_quota_view for efficient quota calculation
      const { data: quotaData, error: quotaError } = await this.supabaseService
        .getServiceClient()
        .from('user_quota_view')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (quotaError) {
        if (quotaError.code === 'PGRST116') {
          // No subscription found, return free plan defaults (overlaid with buckets).
          console.log('No subscription found, using free plan defaults');
          return this.overlayBucketBalance(userId, {
            userId,
            totalCredits: freeCreditLimit,
            usedCredits: 0,
            remainingCredits: freeCreditLimit,
            percentageUsed: 0,
            planType: 'free',
            resetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          });
        }
        throw new Error(`Failed to get quota: ${quotaError.message}`);
      }

      // For free plan users, use the dynamic free credit limit
      const isFreeUser = quotaData.plan_type === 'free';
      const totalCredits = isFreeUser ? freeCreditLimit : quotaData.total_credits;
      const usedCredits = quotaData.used_credits;
      const remainingCredits = totalCredits - usedCredits;
      const percentageUsed = totalCredits > 0 ? Math.round((usedCredits / totalCredits) * 100 * 100) / 100 : 0;

      const legacyQuota = this.coerceUserQuota(
        {
          userId: quotaData.user_id,
          totalCredits,
          usedCredits,
          remainingCredits,
          percentageUsed,
          planType: quotaData.plan_type,
          resetDate: quotaData.reset_date,
        },
        userId,
      );

      // Sprint 1.9b: authoritative balance comes from the multi-bucket model.
      const quota = await this.overlayBucketBalance(userId, legacyQuota);

      // Cache for 5 minutes
      await this.cacheService.set(cacheKey, JSON.stringify(quota), 300);

      return quota;
    } catch (error) {
      console.error('Error getting user quota:', error);

      // Return default free plan quota on error
      return {
        userId,
        totalCredits: freeCreditLimit,
        usedCredits: 0,
        remainingCredits: freeCreditLimit,
        percentageUsed: 0,
        planType: 'free',
        resetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      };
    }
  }

  // Default generation cost: 1.5 credits per successful job.
  // Sprint 1.9b: the gate reads the authoritative multi-bucket balance.
  async checkQuotaAvailable(
    userId: string,
    creditsNeeded: number = 1.5,
  ): Promise<boolean> {
    try {
      const balance = await this.creditBucketService.getBalance(userId);
      return balance.total >= creditsNeeded;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `checkQuotaAvailable bucket read failed for ${userId}, falling back to legacy quota: ${msg}`,
      );
      const quota = await this.getUserQuota(userId);
      return quota.remainingCredits >= creditsNeeded;
    }
  }

  async consumeCredits(
    userId: string,
    creditsUsed: number = 1.5,
    description: string = 'Credit consumption',
    operationType: string = 'generation',
    contentType?: string,
    contentId?: string,
    metadata: Record<string, unknown> = {},
  ): Promise<UserQuota> {
    const txType: 'debit' | 'refund' = creditsUsed >= 0 ? 'debit' : 'refund';
    const amount = Math.abs(creditsUsed);

    try {
      // Sprint 1.9b: route through the bucket-aware charge. This deducts across
      // trial -> plan -> reward (debit) or refunds back (refund) AND writes the
      // audit rows into credit_transactions, so the legacy user_quota_view stays
      // consistent (recorded amounts always sum to the charged amount).
      await this.creditBucketService.applyCharge({
        userId,
        transactionType: txType,
        amount,
        description,
        operationType,
        contentType: contentType || null,
        contentId: contentId || null,
        metadata,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`consumeCredits error user=${userId}: ${msg}`);
      throw error instanceof Error ? error : new Error(msg);
    }

    // Invalidate cache to force refresh
    const cacheKey = `quota:${userId}`;
    await this.cacheService.delete(cacheKey);

    // Get updated quota
    const updatedQuota = await this.getUserQuota(userId);

    // TODO: Handle low credits notification in controllers instead of here to avoid circular dependency

    return updatedQuota;
  }

  /**
   * Sprint 1.9b — grant reward credits (referral / bonus / admin promo).
   *
   * Routes through the bucket-aware `credit` charge so the grant lands in the
   * never-expiring REWARD bucket (per the multi-bucket model) AND writes an
   * audit row into credit_transactions (keeping user_quota_view consistent).
   * Use this for awards/grants; use `consumeCredits` for debits/refunds.
   */
  async grantCredits(
    userId: string,
    amount: number,
    description: string,
    operationType: string = 'reward',
    metadata: Record<string, unknown> = {},
  ): Promise<UserQuota> {
    const grant = Math.abs(amount);
    if (grant <= 0) {
      return this.getUserQuota(userId);
    }

    try {
      await this.creditBucketService.applyCharge({
        userId,
        transactionType: 'credit',
        amount: grant,
        description,
        operationType,
        // A reward grant is not "content" — leave content_type null.
        contentType: null,
        contentId: null,
        metadata,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`grantCredits error user=${userId}: ${msg}`);
      throw error instanceof Error ? error : new Error(msg);
    }

    await this.cacheService.delete(`quota:${userId}`);
    return this.getUserQuota(userId);
  }

  async logTransaction(
    userId: string,
    contentId: string | null,
    transactionType: 'debit' | 'credit' | 'refund',
    amount: number,
    description: string,
    operationType: string,
    contentType: string,
  ): Promise<void> {
    try {
      const { error } = await this.supabaseService
        .getServiceClient()
        .rpc('log_credit_transaction', {
          p_user_id: userId,
          p_content_id: contentId,
          p_transaction_type: transactionType,
          p_amount: Math.abs(amount),
          p_description: description,
          p_operation_type: operationType,
          p_content_type: contentType,
          p_metadata: {},
        });

      if (error) {
        this.logger.error(`logTransaction RPC failed: ${error.message}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`logTransaction error: ${msg}`);
    }
  }

  async debitOnce(params: {
    userId: string;
    operationId: string;
    amount: number;
    description: string;
    operationType: string;
    contentType: string;
    contentId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<boolean> {
    const key = `quota:debit:${params.userId}:${params.operationId}`;
    const locked = await this.cacheService.setIfAbsent(
      key,
      { at: Date.now() },
      86400,
    );
    if (!locked) return false;
    try {
      await this.consumeCredits(
        params.userId,
        params.amount,
        params.description,
        params.operationType,
        params.contentType,
        params.contentId,
        params.metadata ?? {},
      );
      return true;
    } catch (err) {
      await this.cacheService.delete(key);
      throw err;
    }
  }

  async refundOnce(params: {
    userId: string;
    operationId: string;
    amount: number;
    description: string;
    operationType: string;
    contentType: string;
    contentId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<boolean> {
    const key = `quota:refund:${params.userId}:${params.operationId}`;
    const locked = await this.cacheService.setIfAbsent(
      key,
      { at: Date.now() },
      86400,
    );
    if (!locked) return false;
    try {
      await this.consumeCredits(
        params.userId,
        -Math.abs(params.amount),
        params.description,
        params.operationType,
        params.contentType,
        params.contentId,
        params.metadata ?? {},
      );
      return true;
    } catch (err) {
      await this.cacheService.delete(key);
      throw err;
    }
  }

  async incrementUsage(userId: string): Promise<void> {
    // This would typically be called after a successful generation
    // For now, we'll just invalidate the cache to force a refresh
    const cacheKey = `quota:${userId}`;
    await this.cacheService.delete(cacheKey);
  }

  getQuotaColor(percentageUsed: number): 'green' | 'orange' | 'red' {
    if (percentageUsed >= 80) return 'red';
    if (percentageUsed >= 40) return 'orange';
    return 'green';
  }
}
