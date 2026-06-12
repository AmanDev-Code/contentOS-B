import { HttpException, HttpStatus } from '@nestjs/common';
import { PostsController } from '../posts.controller';

async function expectHttpStatus(
  promise: Promise<unknown>,
  status: HttpStatus,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status });
  await expect(promise).rejects.toBeInstanceOf(HttpException);
}

/**
 * Controller-level guarantee that PATCH /posts/scheduled/:id/reschedule is a
 * NO-CHARGE path: QuotaService.consumeCredits / checkQuotaAvailable must never
 * be invoked, in contrast to POST /posts/schedule.
 */

function buildController(rescheduleImpl?: jest.Mock) {
  const reschedulePost =
    rescheduleImpl ??
    jest.fn(async () => ({
      jobId: 'job-1',
      contentId: 'content-1',
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
    }));

  const titleSingle = jest.fn(async () => ({ data: { title: 'My Post' } }));
  const supabaseService = {
    getServiceClient: () => ({
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({ single: titleSingle })),
        })),
      })),
    }),
  };

  const postSchedulingService: any = { reschedulePost, supabaseService };
  const quotaService = {
    consumeCredits: jest.fn(),
    checkQuotaAvailable: jest.fn(),
    logTransaction: jest.fn(),
  };
  const notificationService = { notifyPostScheduled: jest.fn() };
  const cacheService = { invalidateUser: jest.fn() };
  const idempotencyService = {};
  const configService = {};
  const immediatePostPublishService = {};
  const feedbackService = {};
  const webhookDispatcher = { emitPostScheduled: jest.fn(), emitPostCancelled: jest.fn() };

  const controller = new PostsController(
    postSchedulingService,
    quotaService as any,
    notificationService as any,
    cacheService as any,
    idempotencyService as any,
    configService as any,
    immediatePostPublishService as any,
    feedbackService as any,
    webhookDispatcher as any,
  );

  return {
    controller,
    reschedulePost,
    quotaService,
    cacheService,
    notificationService,
  };
}

const req = { user: { id: 'user-1' } } as any;

describe('PostsController.reschedulePost — no credit charge', () => {
  it('delegates to the service and never charges credits', async () => {
    const { controller, reschedulePost, quotaService, cacheService } =
      buildController();
    const scheduledFor = new Date(Date.now() + 3600_000).toISOString();

    const res = await controller.reschedulePost(
      req,
      'sp-1',
      { scheduledFor, timezone: 'UTC' },
      undefined,
    );

    expect(res.success).toBe(true);
    expect(reschedulePost).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledPostId: 'sp-1', userId: 'user-1' }),
    );
    // The whole point of the fix: scheduling re-charges, reschedule must not.
    expect(quotaService.consumeCredits).not.toHaveBeenCalled();
    expect(quotaService.checkQuotaAvailable).not.toHaveBeenCalled();
    expect(cacheService.invalidateUser).toHaveBeenCalledWith('user-1');
  });

  it('rejects a missing scheduled time with 400 and no charge', async () => {
    const { controller, reschedulePost, quotaService } = buildController();

    await expectHttpStatus(
      controller.reschedulePost(req, 'sp-1', { scheduledFor: '' }, undefined),
      HttpStatus.BAD_REQUEST,
    );

    expect(reschedulePost).not.toHaveBeenCalled();
    expect(quotaService.consumeCredits).not.toHaveBeenCalled();
  });

  it('rejects a past scheduled time with 400 and no charge', async () => {
    const { controller, quotaService } = buildController();
    const past = new Date(Date.now() - 3600_000).toISOString();

    await expectHttpStatus(
      controller.reschedulePost(req, 'sp-1', { scheduledFor: past }, undefined),
      HttpStatus.BAD_REQUEST,
    );

    expect(quotaService.consumeCredits).not.toHaveBeenCalled();
  });
});
