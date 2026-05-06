import { CustomTopicCreditService } from './custom-topic-credit.service';
import { QuotaService } from '../../services/quota.service';
import { NotificationService } from '../../services/notification.service';
import { buildCreditSlices } from './pricing';

describe('CustomTopicCreditService', () => {
  let service: CustomTopicCreditService;
  let quota: jest.Mocked<
    Pick<
      QuotaService,
      'debitOnce' | 'refundOnce' | 'getUserQuota'
    >
  >;
  let notifications: jest.Mocked<
    Pick<NotificationService, 'emitCreditBalanceChanged'>
  >;

  beforeEach(() => {
    quota = {
      debitOnce: jest.fn().mockResolvedValue(true),
      refundOnce: jest.fn().mockResolvedValue(true),
      getUserQuota: jest.fn().mockResolvedValue({
        userId: 'u1',
        totalCredits: 100,
        usedCredits: 0,
        remainingCredits: 100,
        percentageUsed: 0,
        planType: 'pro' as const,
        resetDate: new Date(),
      }),
    };
    notifications = {
      emitCreditBalanceChanged: jest.fn(),
    };
    service = new CustomTopicCreditService(
      quota as unknown as QuotaService,
      notifications as unknown as NotificationService,
    );
  });

  it('reserve passes no content_id and uses metadata for generation job id (FK-safe)', async () => {
    const genId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const slices = buildCreditSlices('text');

    await service.reserveCredits('user-1', genId, slices);

    expect(quota.debitOnce).toHaveBeenCalledTimes(1);
    const arg = quota.debitOnce.mock.calls[0][0];
    expect(arg.contentId).toBeUndefined();
    expect(arg.amount).toBe(2);
    expect(arg.metadata).toEqual(
      expect.objectContaining({
        generation_id: genId,
        ledger_phase: 'custom_topic_reserve',
      }),
    );
  });

  it('12-slide carousel reserve debits 32 credits without content_id', async () => {
    const genId = '11111111-2222-3333-4444-555555555555';
    const slices = buildCreditSlices('carousel', undefined, 12);

    await service.reserveCredits('user-2', genId, slices);

    expect(quota.debitOnce).toHaveBeenCalledTimes(1);
    const arg = quota.debitOnce.mock.calls[0][0];
    expect(arg.contentId).toBeUndefined();
    expect(arg.amount).toBe(32);
    expect(arg.metadata?.generation_id).toBe(genId);
    expect(arg.metadata?.slice_count).toBe(13);
  });

  it('refundSlice passes metadata and omits content_id', async () => {
    const genId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const slice = {
      subtaskKey: 'slide_1',
      credits: 2.5,
      halfCredits: 5,
    };

    await service.refundSlice('user-1', genId, slice);

    expect(quota.refundOnce).toHaveBeenCalledTimes(1);
    const arg = quota.refundOnce.mock.calls[0][0];
    expect(arg.contentId).toBeUndefined();
    expect(arg.metadata).toEqual(
      expect.objectContaining({
        generation_id: genId,
        subtask_key: 'slide_1',
        ledger_phase: 'custom_topic_refund_slice',
      }),
    );
  });
});
