import { ReferralService } from './referral.service';
import { SupabaseService } from './supabase.service';
import { QuotaService } from './quota.service';
import { NotificationService } from './notification.service';

describe('ReferralService.processReferralCompletion (Sprint 1.9b reward grant)', () => {
  let service: ReferralService;
  let grantCredits: jest.Mock;
  let consumeCredits: jest.Mock;
  let createNotification: jest.Mock;
  let rpc: jest.Mock;

  beforeEach(() => {
    rpc = jest.fn();

    const supabaseService = {
      getServiceClient: () => ({ rpc }),
    } as unknown as SupabaseService;

    grantCredits = jest.fn().mockResolvedValue(undefined);
    consumeCredits = jest.fn().mockResolvedValue(undefined);
    const quotaService = {
      grantCredits,
      consumeCredits,
    } as unknown as QuotaService;

    createNotification = jest.fn().mockResolvedValue(undefined);
    const notificationService = {
      createNotification,
    } as unknown as NotificationService;

    service = new ReferralService(
      supabaseService,
      quotaService,
      notificationService,
    );
  });

  it('grants the referral bonus to the reward bucket via grantCredits (operation_type=referral_bonus)', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          success: true,
          credits_awarded: 50,
          referrer_id: 'referrer-1',
          message: 'Referral completed',
        },
      ],
      error: null,
    });

    const result = await service.processReferralCompletion('referred-1');

    expect(result.success).toBe(true);
    expect(result.creditsAwarded).toBe(50);

    // Routes through grantCredits (transactionType=credit -> never-expiring
    // reward bucket), NOT the old negative consumeCredits (refund -> plan).
    expect(grantCredits).toHaveBeenCalledTimes(1);
    expect(grantCredits).toHaveBeenCalledWith(
      'referrer-1',
      50,
      expect.stringContaining('Referral bonus'),
      'referral_bonus',
      expect.objectContaining({
        source: 'referral',
        referred_user_id: 'referred-1',
      }),
    );
    expect(consumeCredits).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('does not grant when no credits are awarded', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          success: false,
          credits_awarded: 0,
          referrer_id: null,
          message: 'No referral found',
        },
      ],
      error: null,
    });

    const result = await service.processReferralCompletion('referred-2');

    expect(result.success).toBe(false);
    expect(grantCredits).not.toHaveBeenCalled();
    expect(consumeCredits).not.toHaveBeenCalled();
  });
});
