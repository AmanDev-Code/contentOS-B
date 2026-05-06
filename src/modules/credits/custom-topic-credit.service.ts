import { Injectable, Logger } from '@nestjs/common';
import { QuotaService } from '../../services/quota.service';
import { NotificationService } from '../../services/notification.service';
import {
  CUSTOM_TOPIC_PRICING,
  CreditSlice,
} from './pricing';

@Injectable()
export class CustomTopicCreditService {
  private readonly logger = new Logger(CustomTopicCreditService.name);

  constructor(
    private readonly quotaService: QuotaService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Reserve all credits for a generation job upfront (single debit).
   * Called immediately after the pre-flight guard passes.
   */
  async reserveCredits(
    userId: string,
    generationId: string,
    slices: CreditSlice[],
  ): Promise<void> {
    const total = slices.reduce((sum, s) => sum + s.credits, 0);
    const totalHalf = slices.reduce((sum, s) => sum + s.halfCredits, 0);
    const debited = await this.quotaService.debitOnce({
      userId,
      operationId: `${generationId}:custom_topic_reserve`,
      amount: total,
      description: `Reserved ${total} credits (${totalHalf} half-credits) for custom topic generation ${generationId}`,
      operationType: 'generation',
      contentType: 'custom_topic',
      metadata: {
        generation_id: generationId,
        ledger_phase: 'custom_topic_reserve',
        slice_count: slices.length,
        total_half_credits: totalHalf,
      },
    });

    if (!debited) {
      throw new Error(
        `Duplicate or blocked credit reservation for generation ${generationId}`,
      );
    }

    this.logger.log(
      `Reserved ${total} credits (${slices.length} slices, ${totalHalf} half-credits) for user=${userId} gen=${generationId}`,
    );

    const updatedQuota = await this.quotaService.getUserQuota(userId, {
      bypassCache: true,
    });
    this.notificationService.emitCreditBalanceChanged(
      userId,
      updatedQuota.remainingCredits,
    );
  }

  /**
   * Refund a single subtask slice. Idempotent via `refundOnce`.
   */
  async refundSlice(
    userId: string,
    generationId: string,
    slice: CreditSlice,
  ): Promise<boolean> {
    const refunded = await this.quotaService.refundOnce({
      userId,
      operationId: `${generationId}:${slice.subtaskKey}`,
      amount: slice.credits,
      description: `Refund ${slice.subtaskKey} (${slice.credits} credits) for generation ${generationId}`,
      operationType: 'refund',
      contentType: 'custom_topic',
      metadata: {
        generation_id: generationId,
        subtask_key: slice.subtaskKey,
        ledger_phase: 'custom_topic_refund_slice',
      },
    });
    if (refunded) {
      this.logger.log(
        `Refunded slice ${slice.subtaskKey} (${slice.credits} cr) for gen=${generationId}`,
      );
      const updatedQuota = await this.quotaService.getUserQuota(userId, {
        bypassCache: true,
      });
      this.notificationService.emitCreditBalanceChanged(
        userId,
        updatedQuota.remainingCredits,
      );
    }
    return refunded;
  }

  /**
   * Refund every slice in the job.
   */
  async refundAllSlices(
    userId: string,
    generationId: string,
    slices: CreditSlice[],
  ): Promise<void> {
    for (const slice of slices) {
      await this.refundSlice(userId, generationId, slice);
    }
  }

  /**
   * Text generation failed → refund the entire job
   * (images/slides should not have started).
   */
  async refundTextFail(
    userId: string,
    generationId: string,
    slices: CreditSlice[],
  ): Promise<void> {
    await this.refundAllSlices(userId, generationId, slices);
  }

  /**
   * Specific image subtasks failed after text succeeded → refund only those.
   */
  async refundImageFail(
    userId: string,
    generationId: string,
    failedImageIndices: number[],
  ): Promise<void> {
    for (const idx of failedImageIndices) {
      const slice: CreditSlice = {
        subtaskKey: `image_${idx}`,
        credits: CUSTOM_TOPIC_PRICING.IMAGE_PER_UNIT_CREDITS,
        halfCredits: CUSTOM_TOPIC_PRICING.IMAGE_PER_UNIT_HALF_CREDITS,
      };
      await this.refundSlice(userId, generationId, slice);
    }
  }

  /**
   * Specific carousel slides failed.
   * If ALL slides failed AND text also failed, refund text too.
   */
  async refundSlideFail(
    userId: string,
    generationId: string,
    failedSlideIndices: number[],
    textSucceeded: boolean,
  ): Promise<void> {
    for (const idx of failedSlideIndices) {
      const slice: CreditSlice = {
        subtaskKey: `slide_${idx}`,
        credits: CUSTOM_TOPIC_PRICING.SLIDE_PER_UNIT_CREDITS,
        halfCredits: CUSTOM_TOPIC_PRICING.SLIDE_PER_UNIT_HALF_CREDITS,
      };
      await this.refundSlice(userId, generationId, slice);
    }

    if (!textSucceeded) {
      const textSlice: CreditSlice = {
        subtaskKey: 'text',
        credits: CUSTOM_TOPIC_PRICING.TEXT_CREDITS,
        halfCredits: CUSTOM_TOPIC_PRICING.TEXT_HALF_CREDITS,
      };
      await this.refundSlice(userId, generationId, textSlice);
    }
  }
}
