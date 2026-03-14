import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PostSchedulingService } from '../services/post-scheduling.service';
import { SupabaseService } from '../services/supabase.service';
import { QuotaService } from '../services/quota.service';
import { NotificationService } from '../services/notification.service';

interface PublishJobData {
  contentId: string;
  userId: string;
  platform: string;
}

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

    const { contentId, userId, platform } = job.data;

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
    } catch (error) {
      this.logger.error(`Failed to publish scheduled post: ${error.message}`);

      // Update job status to failed
      await this.updateScheduledPostStatus(
        job.id?.toString() || 'unknown',
        'failed',
        undefined,
        error.message,
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

          await this.quotaService.consumeCredits(
            userId,
            -refundAmount, // Negative for refund
            `Refund for failed scheduled post publishing (${refundAmount} credits)`,
            'refund',
            contentType,
            contentId,
          );

          this.logger.log(
            `Refunded ${refundAmount} credits to user ${userId} for failed scheduled post ${contentId}`,
          );

          // SEND FAILURE NOTIFICATION
          try {
            // Get content title for notification
            const contentData = await this.supabaseService
              .getServiceClient()
              .from('generated_content')
              .select('title')
              .eq('id', contentId)
              .single();

            const contentTitle =
              contentData.data?.title || 'Your scheduled post';
            await this.notificationService.notifyScheduledPostFailed(
              userId,
              contentId,
              contentTitle,
              error.message || 'Unknown error',
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
        }
      } catch (refundError) {
        this.logger.error(
          `Failed to refund credits for failed scheduled post: ${refundError.message}`,
        );
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
