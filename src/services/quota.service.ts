import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { CacheService } from './cache.service';

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
    free: 50,
    standard: 500,
    pro: 2000,
    ultimate: 10000,
  };

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
  ) {}

  async getUserQuota(userId: string): Promise<UserQuota> {
    // Check cache first
    const cacheKey = `quota:${userId}`;
    const cachedQuota = await this.cacheService.get(cacheKey);

    if (cachedQuota) {
      return JSON.parse(cachedQuota);
    }

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
          // No subscription found, return free plan defaults
          console.log('No subscription found, using free plan defaults');
          return {
            userId,
            totalCredits: this.quotaLimits.free,
            usedCredits: 0,
            remainingCredits: this.quotaLimits.free,
            percentageUsed: 0,
            planType: 'free',
            resetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          };
        }
        throw new Error(`Failed to get quota: ${quotaError.message}`);
      }

      const quota: UserQuota = {
        userId: quotaData.user_id,
        totalCredits: quotaData.total_credits,
        usedCredits: quotaData.used_credits,
        remainingCredits: quotaData.remaining_credits,
        percentageUsed: parseFloat(quotaData.percentage_used || '0'),
        planType: quotaData.plan_type,
        resetDate: new Date(quotaData.reset_date),
      };

      // Cache for 5 minutes
      await this.cacheService.set(cacheKey, JSON.stringify(quota), 300);

      return quota;
    } catch (error) {
      console.error('Error getting user quota:', error);

      // Return default free plan quota on error
      return {
        userId,
        totalCredits: this.quotaLimits.free,
        usedCredits: 0,
        remainingCredits: this.quotaLimits.free,
        percentageUsed: 0,
        planType: 'free',
        resetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      };
    }
  }

  // Default generation cost: 1.5 credits per successful job
  async checkQuotaAvailable(
    userId: string,
    creditsNeeded: number = 1.5,
  ): Promise<boolean> {
    const quota = await this.getUserQuota(userId);
    return quota.remainingCredits >= creditsNeeded;
  }

  async consumeCredits(
    userId: string,
    creditsUsed: number = 1.5,
    description: string = 'Credit consumption',
    operationType: string = 'generation',
    contentType?: string,
    contentId?: string,
  ): Promise<UserQuota> {
    const txType: 'debit' | 'refund' = creditsUsed >= 0 ? 'debit' : 'refund';
    const amount = Math.abs(creditsUsed);

    try {
      const { error } = await this.supabaseService
        .getServiceClient()
        .rpc('log_credit_transaction', {
          p_user_id: userId,
          p_content_id: contentId || null,
          p_transaction_type: txType,
          p_amount: amount,
          p_description: description,
          p_operation_type: operationType,
          p_content_type: contentType || null,
          p_metadata: {},
        });
      if (error) {
        console.error('Failed to log credit transaction:', error);
      }
    } catch (error) {
      console.error('Error logging credit transaction:', error);
    }

    // Invalidate cache to force refresh
    const cacheKey = `quota:${userId}`;
    await this.cacheService.delete(cacheKey);

    // Get updated quota
    const updatedQuota = await this.getUserQuota(userId);

    // TODO: Handle low credits notification in controllers instead of here to avoid circular dependency

    return updatedQuota;
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
        console.error('Failed to log transaction:', error);
      }
    } catch (error) {
      console.error('Error logging transaction:', error);
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
  }): Promise<boolean> {
    const key = `quota:debit:${params.userId}:${params.operationId}`;
    const locked = await this.cacheService.setIfAbsent(
      key,
      { at: Date.now() },
      86400,
    );
    if (!locked) return false;
    await this.consumeCredits(
      params.userId,
      params.amount,
      params.description,
      params.operationType,
      params.contentType,
      params.contentId,
    );
    return true;
  }

  async refundOnce(params: {
    userId: string;
    operationId: string;
    amount: number;
    description: string;
    operationType: string;
    contentType: string;
    contentId?: string;
  }): Promise<boolean> {
    const key = `quota:refund:${params.userId}:${params.operationId}`;
    const locked = await this.cacheService.setIfAbsent(
      key,
      { at: Date.now() },
      86400,
    );
    if (!locked) return false;
    await this.consumeCredits(
      params.userId,
      -Math.abs(params.amount),
      params.description,
      params.operationType,
      params.contentType,
      params.contentId,
    );
    return true;
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
