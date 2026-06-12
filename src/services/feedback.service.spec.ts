import { FeedbackService } from './feedback.service';
import { SupabaseService } from './supabase.service';
import { QuotaService } from './quota.service';
import { CacheService } from './cache.service';
import type { Queue } from 'bullmq';

describe('FeedbackService.applyFeedbackReward (Sprint 1.9b reward grant)', () => {
  let service: FeedbackService;
  let grantCredits: jest.Mock;
  let logTransaction: jest.Mock;
  let single: jest.Mock;
  let maybeSingle: jest.Mock;

  function buildClient() {
    const chain = {
      select: jest.fn(() => chain),
      update: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      single,
      maybeSingle,
    };
    return { from: jest.fn(() => chain) };
  }

  beforeEach(() => {
    // 1) load product_feedback row, 2) mark rewarded
    single = jest.fn().mockResolvedValue({
      data: { id: 'fb-1', user_id: 'user-1', rewarded: false },
      error: null,
    });
    maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'fb-1' },
      error: null,
    });

    const supabaseService = {
      getServiceClient: () => buildClient(),
    } as unknown as SupabaseService;

    grantCredits = jest.fn().mockResolvedValue(undefined);
    logTransaction = jest.fn().mockResolvedValue(undefined);
    const quotaService = {
      grantCredits,
      logTransaction,
    } as unknown as QuotaService;

    const cacheService = {
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;

    const rewardQueue = { add: jest.fn() } as unknown as Queue;

    service = new FeedbackService(
      supabaseService,
      quotaService,
      cacheService,
      rewardQueue,
    );
  });

  it('grants the feedback bonus to the reward bucket via grantCredits (operation_type=feedback_reward)', async () => {
    const ok = await service.applyFeedbackReward('fb-1');

    expect(ok).toBe(true);
    // Routes through grantCredits -> never-expiring reward bucket, NOT the old
    // non-bucket-aware logTransaction.
    expect(grantCredits).toHaveBeenCalledTimes(1);
    expect(grantCredits).toHaveBeenCalledWith(
      'user-1',
      100,
      expect.stringContaining('feedback'),
      'feedback_reward',
      expect.objectContaining({ source: 'feedback', feedback_id: 'fb-1' }),
    );
    expect(logTransaction).not.toHaveBeenCalled();
  });

  it('does not grant again when the reward was already applied', async () => {
    single = jest.fn().mockResolvedValue({
      data: { id: 'fb-1', user_id: 'user-1', rewarded: true },
      error: null,
    });

    const ok = await service.applyFeedbackReward('fb-1');

    expect(ok).toBe(false);
    expect(grantCredits).not.toHaveBeenCalled();
  });
});
