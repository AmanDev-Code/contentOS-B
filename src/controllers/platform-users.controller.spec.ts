import { PlatformUsersController } from './platform-users.controller';
import { SupabaseService } from '../services/supabase.service';
import { NotificationService } from '../services/notification.service';
import { SubscriptionService } from '../services/subscription.service';
import { QuotaService } from '../services/quota.service';
import { CacheService } from '../services/cache.service';
import { OnboardingService } from '../services/onboarding.service';

describe('PlatformUsersController.adjustCredits (Sprint 1.9b bucket routing)', () => {
  let controller: PlatformUsersController;
  let grantCredits: jest.Mock;
  let consumeCredits: jest.Mock;
  let logTransaction: jest.Mock;
  let getUserQuota: jest.Mock;
  let createNotification: jest.Mock;

  const adminReq = {
    user: { id: 'admin-9', email: 'admin@trndinn.test' },
  } as never;

  function buildClient() {
    const chain = {
      select: jest.fn(() => chain),
      update: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({ data: { id: 'user-1' }, error: null }),
      single: jest
        .fn()
        .mockResolvedValue({ data: { id: 'user-1' }, error: null }),
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    };
    return { from: jest.fn(() => chain) };
  }

  beforeEach(() => {
    const supabaseService = {
      getServiceClient: () => buildClient(),
    } as unknown as SupabaseService;

    grantCredits = jest.fn().mockResolvedValue(undefined);
    consumeCredits = jest.fn().mockResolvedValue(undefined);
    logTransaction = jest.fn().mockResolvedValue(undefined);
    getUserQuota = jest.fn().mockResolvedValue({
      remainingCredits: 120,
      usedCredits: 0,
      totalCredits: 120,
      percentageUsed: 0,
      planType: 'free',
      resetDate: new Date('2026-07-01T00:00:00Z'),
    });
    const quotaService = {
      grantCredits,
      consumeCredits,
      logTransaction,
      getUserQuota,
    } as unknown as QuotaService;

    createNotification = jest.fn().mockResolvedValue(undefined);
    const notificationService = {
      createNotification,
    } as unknown as NotificationService;

    const cacheService = {
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;

    controller = new PlatformUsersController(
      supabaseService,
      notificationService,
      {} as unknown as SubscriptionService,
      quotaService,
      cacheService,
      {} as unknown as OnboardingService,
    );
  });

  it('routes a POSITIVE admin grant through grantCredits -> reward bucket (operation_type=admin_grant)', async () => {
    const res = await controller.adjustCredits(
      'user-1',
      { delta: 75, reason: 'goodwill' },
      adminReq,
    );

    expect(grantCredits).toHaveBeenCalledTimes(1);
    expect(grantCredits).toHaveBeenCalledWith(
      'user-1',
      75,
      expect.stringContaining('Admin credit adjustment'),
      'admin_grant',
      expect.objectContaining({
        source: 'admin',
        admin_id: 'admin-9',
        reason: 'goodwill',
      }),
    );
    expect(consumeCredits).not.toHaveBeenCalled();
    expect(logTransaction).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it('routes a NEGATIVE admin correction through the bucket-aware consumeCredits (operation_type=admin_adjustment)', async () => {
    const res = await controller.adjustCredits(
      'user-1',
      { delta: -30, reason: 'chargeback' },
      adminReq,
    );

    expect(consumeCredits).toHaveBeenCalledTimes(1);
    expect(consumeCredits).toHaveBeenCalledWith(
      'user-1',
      30,
      expect.stringContaining('Admin credit adjustment'),
      'admin_adjustment',
      undefined,
      undefined,
      expect.objectContaining({
        source: 'admin',
        admin_id: 'admin-9',
        reason: 'chargeback',
      }),
    );
    expect(grantCredits).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it('rejects a zero / non-finite delta', async () => {
    await expect(
      controller.adjustCredits('user-1', { delta: 0 }, adminReq),
    ).rejects.toThrow();
    expect(grantCredits).not.toHaveBeenCalled();
    expect(consumeCredits).not.toHaveBeenCalled();
  });
});
