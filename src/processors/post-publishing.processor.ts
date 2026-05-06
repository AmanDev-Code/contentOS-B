import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { PostSchedulingService } from '../services/post-scheduling.service';
import { SupabaseService } from '../services/supabase.service';
import { QuotaService } from '../services/quota.service';
import { NotificationService } from '../services/notification.service';

interface PublishJobData {
  contentId: string;
  userId: string;
  platform: string;
  actorType?: 'member' | 'organization';
  organizationUrn?: string;
}

/**
 * Scheduled LinkedIn publish worker.
 *
 * Idempotency / refunds:
 * - Duplicate BullMQ attempts after a failure used to call `consumeCredits` (refund) every time.
 *   Refunds now go through `refundOnce` with a stable `operationId` per `contentId` so the same
 *   logical failure is not refunded multiple times.
 * - If `generated_content` is already published (e.g. LinkedIn succeeded but a later DB write
 *   failed), we complete the job without calling LinkedIn again.
 * - `BadRequestException` / `ForbiddenException` from publishing (token, URN, product config)
 *   are treated as non-retryable via `UnrecoverableError` so BullMQ does not burn all attempts.
 */
@Processor('post-publishing')
export class PostPublishingProcessor extends WorkerHost {
  private readonly logger = new Logger(PostPublishingProcessor.name);

  constructor(
    private readonly postSchedulingService: PostSchedulingService,
    private readonly supabaseService: SupabaseService,
    private readonly quotaService: QuotaService,
    private readonly notificationService: NotificationService,
  ) {
    super();
  }

  async process(job: Job<PublishJobData>) {
    if (job.name !== 'publish-scheduled-post') return;

    return this.handleScheduledPost(job);
  }

  async handleScheduledPost(job: Job<PublishJobData>) {
    this.logger.log(`Processing scheduled post job: ${job.id || 'unknown'}`);

    const { contentId, userId, platform, actorType, organizationUrn } = job.data;

    const { data: existingContent } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('publish_status, linkedin_post_id')
      .eq('id', contentId)
      .maybeSingle();

    if (
      existingContent?.publish_status === 'published' &&
      existingContent?.linkedin_post_id
    ) {
      this.logger.log(
        `Content ${contentId} already published; marking scheduled job ${job.id} complete (idempotent).`,
      );
      await this.updateScheduledPostStatus(
        job.id?.toString() || 'unknown',
        'published',
        existingContent.linkedin_post_id,
      );
      return {
        success: true,
        postId: existingContent.linkedin_post_id,
        idempotent: true,
      };
    }

    try {
      // Update job status to processing
      await this.updateScheduledPostStatus(
        job.id?.toString() || 'unknown',
        'processing',
      );

      // Publish the post
      const postId = await this.postSchedulingService.publishPostNow({
        contentId,
        userId,
        platform: platform as 'linkedin',
        actorType,
        organizationUrn,
      });

      // Update job status to published
      await this.updateScheduledPostStatus(
        job.id?.toString() || 'unknown',
        'published',
        postId,
      );

      // Also update the generated_content status
      await this.supabaseService
        .getServiceClient()
        .from('generated_content')
        .update({
          publish_status: 'published',
          linkedin_post_id: postId || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', contentId);

      // SEND SUCCESS NOTIFICATION
      try {
        // Get content title for notification
        const contentData = await this.supabaseService
          .getServiceClient()
          .from('generated_content')
          .select('title')
          .eq('id', contentId)
          .single();

        const contentTitle = contentData.data?.title || 'Your scheduled post';
        await this.notificationService.notifyPostPublished(
          userId,
          contentId,
          contentTitle,
          postId,
        );
        this.logger.log(
          `Sent scheduled post success notification to user ${userId}`,
        );
      } catch (notificationError) {
        this.logger.error(
          `Failed to send scheduled post success notification: ${notificationError.message}`,
        );
      }

      this.logger.log(`Scheduled post published successfully: ${postId}`);
      return { success: true, postId };
    } catch (error: unknown) {
      const errMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to publish scheduled post: ${errMessage}`,
      );

      // Update job status to failed
      await this.updateScheduledPostStatus(
        job.id?.toString() || 'unknown',
        'failed',
        undefined,
        errMessage,
      );

      // Also update the generated_content status to failed
      await this.supabaseService
        .getServiceClient()
        .from('generated_content')
        .update({
          publish_status: 'failed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', contentId);

      // REFUND CREDITS for failed scheduled post
      try {
        // Get content type to determine refund amount
        const contentData = await this.supabaseService
          .getServiceClient()
          .from('generated_content')
          .select('visual_type, visual_url, carousel_urls, media_urls')
          .eq('id', contentId)
          .single();

        if (contentData.data) {
          const hasCarousel = Boolean(
            contentData.data.carousel_urls &&
            contentData.data.carousel_urls.length > 0,
          );
          const hasValidImage = Boolean(
            contentData.data.visual_url?.startsWith('http') ||
            (contentData.data.media_urls &&
              contentData.data.media_urls.length > 0),
          );

          let refundAmount = 4; // Default text scheduling cost
          let contentType = 'text';

          if (hasCarousel) {
            refundAmount = 15;
            contentType = 'carousel';
          } else if (hasValidImage) {
            refundAmount = 7.5;
            contentType = 'image';
          }

          const refunded = await this.quotaService.refundOnce({
            userId,
            operationId: `scheduled-publish-fail:${contentId}`,
            amount: refundAmount,
            description: `Refund for failed scheduled post publishing (${refundAmount} credits)`,
            operationType: 'refund',
            contentType,
            contentId,
          });

          if (refunded) {
            this.logger.log(
              `Refunded ${refundAmount} credits to user ${userId} for failed scheduled post ${contentId}`,
            );

            try {
              const titleRow = await this.supabaseService
                .getServiceClient()
                .from('generated_content')
                .select('title')
                .eq('id', contentId)
                .single();

              const contentTitle =
                titleRow.data?.title || 'Your scheduled post';
              await this.notificationService.notifyScheduledPostFailed(
                userId,
                contentId,
                contentTitle,
                errMessage || 'Unknown error',
                refundAmount,
              );
              this.logger.log(
                `Sent scheduled post failure notification to user ${userId}`,
              );
            } catch (notificationError) {
              this.logger.error(
                `Failed to send scheduled post failure notification: ${notificationError.message}`,
              );
            }
          } else {
            this.logger.log(
              `Skipped duplicate refund for scheduled post ${contentId} (already refunded for this failure). jobId=${job.id} attemptsMade=${job.attemptsMade}`,
            );
          }
        }
      } catch (refundError) {
        this.logger.error(
          `Failed to refund credits for failed scheduled post: ${refundError.message}`,
        );
      }

      const msg = error instanceof Error ? error.message : String(error);
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw new UnrecoverableError(msg);
      }

      throw error;
    }
  }

  private async updateScheduledPostStatus(
    jobId: string,
    status: string,
    linkedinPostId?: string,
    errorMessage?: string,
  ) {
    try {
      const updateData: any = {
        status,
        updated_at: new Date().toISOString(),
      };

      if (status === 'published') {
        updateData.published_at = new Date().toISOString();
      }

      if (errorMessage) {
        updateData.error_message = errorMessage;
        updateData.retry_count = await this.incrementRetryCount(jobId);
      }

      await this.supabaseService
        .getServiceClient()
        .from('scheduled_posts')
        .update(updateData)
        .eq('job_id', jobId);

      this.logger.log(`Updated scheduled post status: ${jobId} -> ${status}`);
    } catch (error) {
      this.logger.error(
        `Failed to update scheduled post status: ${error.message}`,
      );
    }
  }

  private async incrementRetryCount(jobId: string): Promise<number> {
    try {
      const { data } = await this.supabaseService
        .getServiceClient()
        .from('scheduled_posts')
        .select('retry_count')
        .eq('job_id', jobId)
        .single();

      return (data?.retry_count || 0) + 1;
    } catch (error) {
      this.logger.error(`Failed to get retry count: ${error.message}`);
      return 1;
    }
  }
}
