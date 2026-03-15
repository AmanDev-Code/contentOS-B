import { Injectable, BadRequestException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { GenerationJobRepository } from '../repositories/generation-job.repository';
import { GeneratedContentRepository } from '../repositories/generated-content.repository';
import { ProfileRepository } from '../repositories/profile.repository';
import { SubscriptionRepository } from '../repositories/subscription.repository';
import { GenerationWorkerManager } from '../workers/generation-worker-manager';
import { QuotaService } from './quota.service';
import { QUEUE_NAMES, PLAN_LIMITS, ERROR_MESSAGES } from '../common/constants';
import { PlanType, SubscriptionStatus, JobStatus } from '../common/types';

@Injectable()
export class GenerationService {
  private userQueues: Map<string, Queue> = new Map();

  constructor(
    private configService: ConfigService,
    private generationJobRepository: GenerationJobRepository,
    private generatedContentRepository: GeneratedContentRepository,
    private profileRepository: ProfileRepository,
    private subscriptionRepository: SubscriptionRepository,
    private workerManager: GenerationWorkerManager,
    private quotaService: QuotaService,
  ) {}

  /**
   * Get or create a queue for a specific user
   */
  private getUserQueue(userId: string): Queue {
    if (!this.userQueues.has(userId)) {
      const queueName = `${QUEUE_NAMES.CONTENT_GENERATION}-${userId}`;
      const queue = new Queue(queueName, {
        connection: {
          host: this.configService.get<string>('redis.host') || 'localhost',
          port: parseInt(
            this.configService.get<string>('redis.port') || '6380',
            10,
          ),
          password:
            this.configService.get<string>('redis.password') || undefined,
        },
      });
      this.userQueues.set(userId, queue);
    }
    return this.userQueues.get(userId)!;
  }

  async startGeneration(
    userId: string,
    preferences?: Record<string, any>,
  ): Promise<{ jobId: string; message: string }> {
    // Check quota and consume credits immediately (no more test user exception)
    const hasQuota = await this.quotaService.checkQuotaAvailable(userId, 1.5);
    if (!hasQuota) {
      throw new BadRequestException(
        'Insufficient credits. Content generation requires 1.5 credits. Please upgrade your plan.',
      );
    }

    // IMMEDIATE CREDIT DEDUCTION for content generation
    await this.quotaService.consumeCredits(
      userId,
      1.5,
      'Content generation initiated (1.5 credits)',
      'generation',
      'text', // Default to text, will be updated based on actual content type
    );

    const job = await this.generationJobRepository.create(userId);

    // Ensure worker exists for this user
    this.workerManager.ensureWorkerForUser(userId);

    // Get user-specific queue
    const userQueue = this.getUserQueue(userId);

    await userQueue.add(
      'generate-content',
      {
        jobId: job.id,
        userId,
        preferences,
      },
      {
        attempts: 1, // No auto-retry, user must manually retry
        removeOnComplete: true, // Auto-remove completed jobs to prevent queue jamming
        removeOnFail: false, // Keep failed jobs so user can see them
      },
    );

    // Skip credit decrement for test user
    if (userId !== 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3') {
      await this.profileRepository.incrementDailyCreditsUsed(userId);
    }

    return {
      jobId: job.id,
      message: 'Content generation started successfully',
    };
  }

  async getJobStatus(jobId: string, userId: string) {
    const job = await this.generationJobRepository.findById(jobId);

    if (!job) {
      throw new BadRequestException('Job not found');
    }

    if (job.userId !== userId) {
      throw new BadRequestException('Unauthorized access to job');
    }

    return {
      id: job.id,
      status: job.status,
      progress: job.progress,
      currentStage: job.currentStage,
      contentId: job.contentId,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  async getUserJobs(userId: string, limit = 20) {
    const jobs = await this.generationJobRepository.findByUserId(userId);
    return jobs.slice(0, limit);
  }

  async retryJob(jobId: string, userId: string) {
    const job = await this.generationJobRepository.findById(jobId);

    if (!job) {
      throw new BadRequestException('Job not found');
    }

    if (job.userId !== userId) {
      throw new BadRequestException('Unauthorized access to job');
    }

    if (job.status !== JobStatus.FAILED) {
      throw new BadRequestException('Can only retry failed jobs');
    }

    // Reset job status
    await this.generationJobRepository.updateStatus(
      jobId,
      JobStatus.GENERATING,
      0,
      'Retrying...',
    );

    // Add back to user's queue
    const userQueue = this.getUserQueue(job.userId);

    await userQueue.add(
      'generate-content',
      {
        jobId: job.id,
        userId: job.userId,
        preferences: {},
      },
      {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return {
      jobId: job.id,
      message: 'Job retry initiated',
    };
  }

  async checkAndSyncJobCompletion(
    jobId: string,
    userId: string,
  ): Promise<{
    synced: boolean;
    status: string;
    message: string;
    canRetry?: boolean;
  }> {
    // Get job from database
    const job = await this.generationJobRepository.findById(jobId);
    if (!job || job.userId !== userId) {
      return { synced: false, status: 'not_found', message: 'Job not found' };
    }

    // If already completed, return
    if (job.status === JobStatus.READY) {
      return {
        synced: false,
        status: job.status,
        message: 'Job already completed',
      };
    }

    if (job.status === JobStatus.FAILED) {
      return {
        synced: false,
        status: job.status,
        message: 'Job already failed',
        canRetry: true,
      };
    }

    // Check if job exists in BullMQ queue
    const queue = this.getUserQueue(userId);
    const bullJob = await queue.getJob(jobId);

    if (!bullJob) {
      // Job not in queue - might be completed or removed
      // Check if there's any content generated for this job
      const content = await this.generatedContentRepository.findByJobId(jobId);

      if (content && content.length > 0) {
        // Content exists! Update job to ready
        await this.generationJobRepository.updateWithContent(
          jobId,
          content[0].id,
          JobStatus.READY,
          { message: 'Auto-synced from completed queue job' },
        );

        // Consume quota credit for successful generation
        await this.quotaService.incrementUsage(userId);

        return {
          synced: true,
          status: 'ready',
          message: 'Job synced to ready with existing content',
        };
      }

      // Check if job has been stuck for too long (more than 2 minutes)
      const jobAge = Date.now() - new Date(job.createdAt).getTime();
      const TWO_MINUTES = 2 * 60 * 1000;

      if (jobAge > TWO_MINUTES && job.status === JobStatus.GENERATING) {
        await this.generationJobRepository.updateError(
          jobId,
          'Job timeout: n8n workflow did not complete within 2 minutes',
          job.retryCount,
        );
        await this.refundGenerationCredits(userId, jobId, 'timeout');
        return {
          synced: true,
          status: 'failed',
          message: 'Job timed out - n8n workflow did not respond',
          canRetry: true,
        };
      }

      await this.generationJobRepository.updateError(
        jobId,
        'Job completed in queue but no content generated',
        job.retryCount,
      );
      await this.refundGenerationCredits(userId, jobId, 'no content generated');
      return {
        synced: true,
        status: 'failed',
        message: 'Job marked as failed - no content found',
        canRetry: true,
      };
    }

    // Job still in queue - check its state
    const state = await bullJob.getState();

    if (state === 'completed') {
      // BullMQ says completed, but check if we have content
      const content = await this.generatedContentRepository.findByJobId(jobId);

      if (content && content.length > 0) {
        // Content exists! Update job to ready
        await this.generationJobRepository.updateWithContent(
          jobId,
          content[0].id,
          JobStatus.READY,
          { message: 'Auto-synced with content' },
        );

        // Consume quota credit for successful generation
        await this.quotaService.incrementUsage(userId);

        return {
          synced: true,
          status: 'ready',
          message: 'Job synced to ready',
        };
      }

      // Completed in queue but no content - n8n failed silently
      await this.generationJobRepository.updateError(
        jobId,
        'n8n workflow completed but did not generate content',
        job.retryCount,
      );
      await this.refundGenerationCredits(userId, jobId, 'n8n silent failure');
      return {
        synced: true,
        status: 'failed',
        message: 'n8n workflow failed to generate content',
        canRetry: true,
      };
    }

    if (state === 'failed') {
      const failedReason = bullJob.failedReason || 'Unknown error';
      await this.generationJobRepository.updateError(
        jobId,
        failedReason,
        job.retryCount,
      );
      await this.refundGenerationCredits(userId, jobId, failedReason);
      return {
        synced: true,
        status: 'failed',
        message: `Job failed: ${failedReason}`,
        canRetry: true,
      };
    }

    // Job still processing
    return { synced: false, status: state, message: `Job still ${state}` };
  }

  private async refundGenerationCredits(
    userId: string,
    jobId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.quotaService.consumeCredits(
        userId,
        -1.5,
        `Refund for failed generation job ${jobId} (${reason})`,
        'refund',
        'text',
      );
    } catch (error) {
      // Log but don't throw — the job already failed, refund is best-effort
      console.error(
        `Failed to refund 1.5 credits for user ${userId}, job ${jobId}: ${error.message}`,
      );
    }
  }

  private async checkQuotaAndSubscription(userId: string): Promise<void> {
    const profile = await this.profileRepository.findById(userId);
    if (!profile) {
      throw new BadRequestException('User profile not found');
    }

    const subscription = await this.subscriptionRepository.findByUserId(userId);
    if (!subscription || subscription.status !== SubscriptionStatus.ACTIVE) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_SUBSCRIPTION);
    }

    const planLimits = PLAN_LIMITS[profile.plan];
    if (!planLimits) {
      throw new BadRequestException('Invalid plan');
    }

    if (
      planLimits.monthlyGenerations !== -1 &&
      profile.credits_remaining <= 0
    ) {
      throw new BadRequestException(ERROR_MESSAGES.QUOTA_EXCEEDED);
    }

    if (profile.credits_remaining > 0) {
      await this.profileRepository.updateCredits(
        userId,
        profile.credits_remaining - 1,
      );
    }
  }
}
