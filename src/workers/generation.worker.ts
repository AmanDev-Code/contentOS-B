import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { N8nService } from '../services/n8n.service';
import { GenerationJobRepository } from '../repositories/generation-job.repository';
import { GeneratedContentRepository } from '../repositories/generated-content.repository';
import { QuotaService } from '../services/quota.service';
import { NotificationService } from '../services/notification.service';
import { QUEUE_NAMES, JOB_STAGES } from '../common/constants';
import { JobStatus } from '../common/types';

@Processor(QUEUE_NAMES.CONTENT_GENERATION)
export class GenerationWorker extends WorkerHost {
  private readonly logger = new Logger(GenerationWorker.name);

  constructor(
    private configService: ConfigService,
    private n8nService: N8nService,
    private generationJobRepository: GenerationJobRepository,
    private generatedContentRepository: GeneratedContentRepository,
    private quotaService: QuotaService,
    private notificationService: NotificationService,
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    const { jobId, userId, preferences } = job.data;

    this.logger.log(`Processing generation job ${jobId} for user ${userId}`);

    try {
      await this.generationJobRepository.updateStatus(
        jobId,
        JobStatus.GENERATING,
        10,
        JOB_STAGES.TOPIC_DISCOVERY,
      );

      await job.updateProgress(10);

      // Build callback URL for n8n to call when job completes
      const baseUrl =
        this.configService.get<string>('app.baseUrl') ||
        'http://localhost:3000';
      const callbackUrl = `${baseUrl}/webhook/n8n-callback`;

      const carouselUrl =
        this.configService.get<string>('n8n.carouselWebhookUrl') || '';
      const ct = preferences?.contentType as string | undefined;
      const useCarousel =
        ct === 'carousel' && carouselUrl.length > 0;

      this.logger.log(
        `n8n route: contentType=${String(ct)} jobType=${String(preferences?.jobType)} ` +
          `→ ${useCarousel ? `carousel webhook (${carouselUrl})` : `default webhook`}`,
      );

      await this.n8nService.triggerContentGeneration(
        {
          jobId,
          userId,
          callbackUrl,
          preferences,
        },
        useCarousel ? { webhookUrlOverride: carouselUrl } : undefined,
      );

      await this.generationJobRepository.updateStatus(
        jobId,
        JobStatus.GENERATING,
        30,
        JOB_STAGES.CONTENT_GENERATION,
      );

      await job.updateProgress(30);

      this.logger.log(
        `n8n webhook triggered for job ${jobId}, waiting for completion...`,
      );

      // Wait for n8n to complete by polling the database
      // n8n will call our webhook which updates the job status
      const maxWaitTime = 120000; // 2 minutes max
      const pollInterval = 2000; // Check every 2 seconds
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));

        // Check if job status was updated by webhook
        const currentJob = await this.generationJobRepository.findById(jobId);

        if (!currentJob) {
          throw new Error('Job not found in database');
        }

        // Check if n8n completed (webhook was called)
        if (currentJob.status === JobStatus.READY) {
          this.logger.log(`✅ Job ${jobId} completed successfully by n8n`);

          // LOG SUCCESSFUL CREDIT TRANSACTION
          try {
            await this.quotaService.logTransaction(
              userId,
              currentJob.contentId || null,
              'debit',
              0, // No additional charge, already deducted
              'Content generated successfully (1.5 credits total)',
              'generation',
              'text',
            );
            this.logger.log(
              `Logged successful generation transaction for user ${userId}`,
            );
          } catch (logError) {
            this.logger.error(
              `Failed to log transaction for user ${userId}: ${logError.message}`,
            );
          }

          // SEND GENERATION SUCCESS NOTIFICATION
          try {
            if (currentJob.contentId) {
              // Get content title from database
              const content = await this.generatedContentRepository.findById(
                currentJob.contentId,
              );
              const contentTitle = content?.title || 'Your content';
              await this.notificationService.notifyGenerationComplete(
                userId,
                currentJob.contentId,
                contentTitle,
              );
              this.logger.log(
                `Sent generation success notification to user ${userId}`,
              );
            }
          } catch (notificationError) {
            this.logger.error(
              `Failed to send generation success notification: ${notificationError.message}`,
            );
          }

          await job.updateProgress(100);
          return {
            success: true,
            jobId,
            contentId: currentJob.contentId,
            message: 'Content generated successfully',
          };
        }

        if (currentJob.status === JobStatus.FAILED) {
          this.logger.error(
            `❌ Job ${jobId} failed in n8n: ${currentJob.error}`,
          );
          throw new Error(currentJob.error || 'n8n workflow failed');
        }

        // Update progress if changed
        if (currentJob.progress > 30) {
          await job.updateProgress(currentJob.progress);
        }

        this.logger.log(
          `⏳ Job ${jobId} still processing... (${currentJob.progress}%)`,
        );
      }

      // Timeout - n8n didn't respond
      this.logger.error(`⏰ Job ${jobId} timed out waiting for n8n`);
      await this.generationJobRepository.updateError(
        jobId,
        'n8n workflow timeout - no response after 2 minutes',
        0,
      );

      throw new Error('n8n workflow timeout');
    } catch (error) {
      this.logger.error(
        `Failed to process generation job ${jobId}: ${error.message}`,
      );

      // REFUND CREDITS for failed generation
      try {
        await this.quotaService.consumeCredits(
          userId,
          -1.5, // Refund 1.5 credits
          'Refund for failed content generation (1.5 credits)',
          'refund',
          'text',
        );
        this.logger.log(
          `Refunded 1.5 credits to user ${userId} for failed job ${jobId}`,
        );
      } catch (refundError) {
        this.logger.error(
          `Failed to refund credits for user ${userId}: ${refundError.message}`,
        );
      }

      // SEND GENERATION FAILURE NOTIFICATION
      try {
        await this.notificationService.notifyGenerationFailed(
          userId,
          jobId,
          error.message,
          1.5,
        );
        this.logger.log(
          `Sent generation failure notification to user ${userId}`,
        );
      } catch (notificationError) {
        this.logger.error(
          `Failed to send generation failure notification: ${notificationError.message}`,
        );
      }

      // Mark job as failed in database
      await this.generationJobRepository.updateError(
        jobId,
        error.message,
        0, // No auto-retry
      );

      // Don't throw error to prevent BullMQ from retrying
      // User must manually retry via UI
      this.logger.log(
        `Job ${jobId} marked as failed. User can manually retry from UI.`,
      );

      return {
        success: false,
        jobId,
        error: error.message,
        message: 'Job failed. Manual retry required.',
      };
    }
  }
}
