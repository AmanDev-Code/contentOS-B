import {
  Injectable,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { GenerationJobRepository } from '../repositories/generation-job.repository';
import { GeneratedContentRepository } from '../repositories/generated-content.repository';
import { ProfileRepository } from '../repositories/profile.repository';
import { SubscriptionRepository } from '../repositories/subscription.repository';
import { GenerationWorkerManager } from '../workers/generation-worker-manager';
import { QuotaService } from './quota.service';
import { CustomTopicCreditService } from '../modules/credits/custom-topic-credit.service';
import {
  CreditSlice,
  normalizeCustomTopicContentType,
  CUSTOM_TOPIC_PRICING,
  buildCreditSlices,
  calculateTotalCredits,
} from '../modules/credits/pricing';
import {
  CREDIT_COSTS,
  regenerateAllImagesCost,
  regenerateCarouselCost,
} from '../modules/credits/credit-costs';
import type { PostGenerationInput } from '../modules/post-ai/custom-topic.schemas';
import { QUEUE_NAMES, PLAN_LIMITS, ERROR_MESSAGES } from '../common/constants';
import { PlanType, SubscriptionStatus, JobStatus } from '../common/types';
import { AiGatewayService } from './ai-gateway.service';

const MAX_IN_FLIGHT_PER_USER = 5;

@Injectable()
export class GenerationService {
  private readonly logger = new Logger(GenerationService.name);
  private userQueues: Map<string, Queue> = new Map();

  constructor(
    private configService: ConfigService,
    private generationJobRepository: GenerationJobRepository,
    private generatedContentRepository: GeneratedContentRepository,
    private profileRepository: ProfileRepository,
    private subscriptionRepository: SubscriptionRepository,
    private workerManager: GenerationWorkerManager,
    private quotaService: QuotaService,
    private customTopicCreditService: CustomTopicCreditService,
    private aiGateway: AiGatewayService,
  ) {}

  /**
   * Get or create a queue for a specific user
   */
  private getUserQueue(userId: string): Queue {
    if (!this.userQueues.has(userId)) {
      const queueName = `${QUEUE_NAMES.CONTENT_GENERATION}-${userId}`;
      // Use config service for Redis connection - port comes from REDIS_PORT env var
      const redisPort = this.configService.get<number>('redis.port');
      this.logger.log(
        `Creating queue ${queueName} with Redis port=${redisPort} (from config)`,
      );
      const queue = new Queue(queueName, {
        connection: {
          host: this.configService.get<string>('redis.host') || 'localhost',
          port: redisPort || 6379,
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
    await this.enforceInFlightLimit(userId);

    const normalizedPreferences = {
      ...(preferences || {}),
      generationGuardrails: {
        temperature:
          typeof preferences?.generationGuardrails?.temperature === 'number'
            ? Math.max(
                0,
                Math.min(1, preferences.generationGuardrails.temperature),
              )
            : 0.2,
        factualityMode:
          preferences?.generationGuardrails?.factualityMode || 'strict',
        reduceHallucination: true,
      },
    };

    // Check quota and consume credits immediately (no more test user exception).
    // Cost from the single source of truth (credit-costs.ts).
    const legacyCost = CREDIT_COSTS.legacyGenerate;
    const hasQuota = await this.quotaService.checkQuotaAvailable(userId, legacyCost);
    if (!hasQuota) {
      throw new BadRequestException(
        `Insufficient credits. Content generation requires ${legacyCost} credits. Please upgrade your plan.`,
      );
    }

    // IMMEDIATE CREDIT DEDUCTION for content generation
    await this.quotaService.consumeCredits(
      userId,
      legacyCost,
      `Content generation initiated (${legacyCost} credits)`,
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
        preferences: normalizedPreferences,
      },
      {
        jobId: job.id, // Keep BullMQ job id aligned with DB generation_jobs.id
        attempts: 1, // No auto-retry, user must manually retry
        removeOnComplete: true, // Auto-remove completed jobs to prevent queue jamming
        removeOnFail: { count: 10 }, // Keep last 10 failed jobs per queue
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

    const stashed =
      job.response &&
      typeof job.response === 'object' &&
      !Array.isArray(job.response)
        ? (job.response as Record<string, unknown>).preferences
        : null;
    if (
      !stashed ||
      typeof stashed !== 'object' ||
      (stashed as Record<string, unknown>).jobType !== 'custom_topic'
    ) {
      throw new BadRequestException(
        'Cannot retry this job — generation settings were not stored. Start a new generation instead.',
      );
    }

    const userQueue = this.getUserQueue(job.userId);

    await userQueue.add(
      'generate-content',
      {
        jobId: job.id,
        userId: job.userId,
        preferences: stashed,
      },
      {
        jobId: job.id,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 10 },
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

  /**
   * Start a custom-topic generation job with per-subtask credit slicing.
   *
   * Credits are reserved upfront (pre-flight guard already verified balance).
   * Workers will call refundSlice / chargeSlice on completion/failure.
   */
  async startCustomTopicGeneration(
    userId: string,
    input: {
      topic: string;
      platform: 'linkedin' | 'instagram' | 'x';
      contentType: 'text' | 'image' | 'carousel' | 'post';
      tonality: string;
      wordLimit: { kind: string; words?: number };
      onlineSearch?: boolean;
      includeBrandKit?: boolean;
      imageCount?: number;
      slideCount?: number;
      carouselVisualStyle?: PostGenerationInput['carouselVisualStyle'];
      carouselNoteDensity?: PostGenerationInput['carouselNoteDensity'];
      carouselSubjectMode?: PostGenerationInput['carouselSubjectMode'];
      carouselDocumentMode?: PostGenerationInput['carouselDocumentMode'];
      carouselDocumentAuthor?: PostGenerationInput['carouselDocumentAuthor'];
      trainingDataCaptureOptIn?: boolean;
    },
    creditSlices: CreditSlice[],
    totalCost: number,
  ): Promise<{ jobId: string; message: string; totalCost: number }> {
    const contentType = normalizeCustomTopicContentType(input.contentType);

    await this.enforceInFlightLimit(userId);

    const job = await this.generationJobRepository.create(userId);

    try {
      await this.customTopicCreditService.reserveCredits(
        userId,
        job.id,
        creditSlices,
      );
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      await this.generationJobRepository.updateError(
        job.id,
        `Credit reservation failed: ${rawMsg}`,
        0,
      );
      throw this.mapCustomTopicCreditReservationError(err);
    }

    this.workerManager.ensureWorkerForUser(userId);

    const userQueue = this.getUserQueue(userId);

    const preferences = {
      jobType: 'custom_topic' as const,
      contentType,
      topic: input.topic,
      platform: input.platform,
      tonality: input.tonality,
      wordLimit: input.wordLimit,
      onlineSearch: input.onlineSearch,
      includeBrandKit: input.includeBrandKit,
      imageCount: input.imageCount,
      slideCount: input.slideCount,
      carouselVisualStyle: input.carouselVisualStyle,
      carouselNoteDensity: input.carouselNoteDensity,
      carouselSubjectMode: input.carouselSubjectMode,
      carouselDocumentMode: input.carouselDocumentMode,
      carouselDocumentAuthor: input.carouselDocumentAuthor,
      trainingDataCaptureOptIn: input.trainingDataCaptureOptIn,
      creditSlices,
      totalCost,
    };

    await userQueue.add(
      'generate-content',
      {
        jobId: job.id,
        userId,
        preferences,
      },
      {
        jobId: job.id,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 10 }, // Keep last 10 failed jobs
      },
    );

    await this.generationJobRepository.stashJobPayload(job.id, { preferences });

    return {
      jobId: job.id,
      message: `Custom topic generation started. ${totalCost} credits reserved.`,
      totalCost,
    };
  }

  async cancelJob(
    jobId: string,
    userId: string,
  ): Promise<{ success: boolean; message: string }> {
    const job = await this.generationJobRepository.findById(jobId);
    if (!job) {
      throw new BadRequestException('Job not found');
    }
    if (job.userId !== userId) {
      throw new BadRequestException('Unauthorized');
    }
    if (job.status === JobStatus.READY || job.status === JobStatus.FAILED) {
      return { success: false, message: 'Job already completed or failed' };
    }

    await this.generationJobRepository.updateError(
      jobId,
      'Cancelled by user',
      0,
    );

    let refunded = false;
    try {
      const userQueue = this.getUserQueue(userId);
      const bullJob = await userQueue.getJob(jobId);
      if (bullJob) {
        const prefs = bullJob.data?.preferences;
        const creditSlices: CreditSlice[] = prefs?.creditSlices ?? [];
        if (creditSlices.length > 0) {
          await this.customTopicCreditService.refundAllSlices(userId, jobId, creditSlices);
          refunded = true;
        }
        await bullJob.remove().catch(() => undefined);
      }
    } catch { /* best effort queue cleanup */ }

    if (!refunded) {
      await this.refundGenerationCredits(userId, jobId, 'Cancelled by user');
    }

    return { success: true, message: 'Job cancelled and credits refunded' };
  }

  /**
   * Maps credit ledger / idempotency failures to HTTP exceptions with stable client-facing codes.
   */
  private mapCustomTopicCreditReservationError(err: unknown): HttpException {
    if (err instanceof HttpException) {
      return err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/Duplicate or blocked credit reservation/i.test(msg)) {
      return new ConflictException({
        code: 'credit_reservation_duplicate',
        message:
          'Credits were already reserved for this generation. Please wait a moment or start a new generation.',
      });
    }
    if (
      /Credit ledger update failed/i.test(msg) ||
      /foreign key/i.test(msg) ||
      /violates foreign key constraint/i.test(msg)
    ) {
      return new HttpException(
        {
          code: 'credit_ledger_unavailable',
          message:
            'We could not update your credit balance. Please try again in a few moments.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return new HttpException(
      {
        code: 'credit_reservation_failed',
        message:
          'Could not reserve credits for this generation. Please try again.',
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * Enforce max 5 in-flight jobs per user.
   * Stale jobs older than GENERATION_ACTIVE_STALE_MS are auto-failed first.
   * Throws 429 (Too Many Requests) when count >= MAX_IN_FLIGHT_PER_USER.
   */
  private async enforceInFlightLimit(userId: string): Promise<void> {
    // Default to 5 minutes (300000ms) to match n8n workflow timeout.
    // Can be increased via GENERATION_ACTIVE_STALE_MS env var for long-running jobs.
    const staleAfterMs = Number(process.env.GENERATION_ACTIVE_STALE_MS || '300000');
    const existingJobs = await this.generationJobRepository.findByUserId(userId);
    const activeJobs = existingJobs.filter(
      (j) =>
        j.status === JobStatus.GENERATING ||
        j.status === JobStatus.MEDIA_GENERATING ||
        j.status === JobStatus.PUBLISHING,
    );

    let cleanedCount = 0;
    for (const staleCandidate of activeJobs) {
      const createdAtMs = new Date(staleCandidate.createdAt as any).getTime();
      const ageMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : 0;
      if (ageMs > staleAfterMs) {
        // Atomic guard: skip if the worker has already finalized the row.
        // See `updateErrorIfStillActive` for rationale.
        const updated = await this.generationJobRepository.updateErrorIfStillActive(
          staleCandidate.id,
          `Auto-failed stale active job after ${Math.round(ageMs / 1000)}s without completion (n8n callback timeout)`,
          staleCandidate.retryCount || 0,
        );
        if (updated) {
          cleanedCount++;
          this.logger.warn(
            `Cleaned up stale job ${staleCandidate.id} for user ${userId} (age=${Math.round(ageMs / 1000)}s, threshold=${Math.round(staleAfterMs / 1000)}s)`,
          );
          // Refund credits for the stale job
          await this.refundGenerationCredits(userId, staleCandidate.id, 'stale job timeout');
        }
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(
        `Cleaned up ${cleanedCount} stale jobs for user ${userId} before enforcing in-flight limit`,
      );
    }

    const liveCount = activeJobs.filter((j) => {
      const createdAtMs = new Date(j.createdAt as any).getTime();
      const ageMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : 0;
      return ageMs <= staleAfterMs;
    }).length;

    if (liveCount >= MAX_IN_FLIGHT_PER_USER) {
      this.logger.warn(
        `User ${userId} has ${liveCount} in-flight jobs (limit ${MAX_IN_FLIGHT_PER_USER}). Returning 429.`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'max_in_flight_reached',
          message: `You have ${liveCount} active generation jobs. Maximum is ${MAX_IN_FLIGHT_PER_USER}. Please wait for one to complete.`,
          retryAfterSeconds: 30,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async refundGenerationCredits(
    userId: string,
    jobId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.quotaService.consumeCredits(
        userId,
        -CREDIT_COSTS.legacyGenerate,
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

  /**
   * Re-run the full custom-topic pipeline for an existing post (text + media)
   * using the original topic and generation settings persisted on the row.
   * Updates the same content record in place when complete.
   */
  async regeneratePostFromContent(
    userId: string,
    contentId: string,
    overrides?: { includeBrandKit?: boolean },
  ): Promise<{ jobId: string; message: string; totalCost: number }> {
    const content = await this.generatedContentRepository.findById(contentId);
    if (!content) {
      throw new BadRequestException('Content not found');
    }
    if ((content as any).user_id !== userId) {
      throw new BadRequestException('Unauthorized');
    }
    const pp = (content as any).performance_prediction as
      | Record<string, unknown>
      | undefined;
    const customMeta = (pp?.customTopicMeta ?? {}) as Record<string, unknown>;
    const hasCustomMeta = Boolean(
      customMeta.contentType ||
        (Array.isArray(customMeta.imagePrompts) && customMeta.imagePrompts.length > 0) ||
        (Array.isArray(customMeta.slides) && customMeta.slides.length > 0) ||
        String(customMeta.topic ?? '').trim(),
    );
    if ((content as any).source !== 'custom' && !hasCustomMeta) {
      throw new BadRequestException(
        'Only AI-generated custom posts can be fully regenerated',
      );
    }

    let topic = String(customMeta.topic ?? '').trim();
    if (!topic) {
      const body = String((content as any).content || '');
      const withoutFooter = body.split(/\n\n— Generated by/)[0]?.trim() ?? body.trim();
      topic =
        withoutFooter.split(/(?<=[.!?])\s+/)[0]?.trim() ||
        withoutFooter.slice(0, 300).trim();
    }
    if (!topic) {
      topic = String((content as any).title || '').trim();
    }
    if (!topic) {
      throw new BadRequestException(
        'Original topic not found on this post. Generate a new post from the Agent instead.',
      );
    }

    const contentType = normalizeCustomTopicContentType(customMeta.contentType);
    const imagePrompts = customMeta.imagePrompts as string[] | undefined;
    const slides = customMeta.slides as unknown[] | undefined;
    const imageCount =
      typeof customMeta.imageCount === 'number'
        ? customMeta.imageCount
        : imagePrompts?.length ?? 1;
    const slideCount =
      typeof customMeta.slideCount === 'number'
        ? customMeta.slideCount
        : slides?.length ?? 2;

    const creditSlices = buildCreditSlices(contentType, imageCount, slideCount);
    const totalCost = calculateTotalCredits(
      contentType,
      imageCount,
      slideCount,
    );

    const hasQuota = await this.quotaService.checkQuotaAvailable(
      userId,
      totalCost,
    );
    if (!hasQuota) {
      throw new BadRequestException(
        `Insufficient credits. Regenerating this post requires ${totalCost} credits.`,
      );
    }

    await this.enforceInFlightLimit(userId);
    const job = await this.generationJobRepository.create(userId);

    try {
      await this.customTopicCreditService.reserveCredits(
        userId,
        job.id,
        creditSlices,
      );
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      await this.generationJobRepository.updateError(
        job.id,
        `Credit reservation failed: ${rawMsg}`,
        0,
      );
      throw this.mapCustomTopicCreditReservationError(err);
    }

    const includeBrandKit =
      overrides?.includeBrandKit !== undefined
        ? overrides.includeBrandKit
        : customMeta.includeBrandKit !== false;

    const preferences = {
      jobType: 'custom_topic' as const,
      contentType,
      topic,
      platform: (customMeta.platform as 'linkedin' | 'instagram' | 'x') ?? 'linkedin',
      tonality: String(customMeta.tonality ?? 'professional'),
      wordLimit: (customMeta.wordLimit as { kind: string; words?: number }) ?? {
        kind: 'medium',
      },
      onlineSearch: customMeta.onlineSearch === true,
      includeBrandKit,
      imageCount: contentType === 'image' ? imageCount : undefined,
      slideCount: contentType === 'carousel' ? slideCount : undefined,
      carouselVisualStyle: (customMeta.carouselVisualStyleRequested ??
        customMeta.carouselVisualStyle) as
        | PostGenerationInput['carouselVisualStyle']
        | undefined,
      carouselNoteDensity: customMeta.carouselNoteDensity as
        | PostGenerationInput['carouselNoteDensity']
        | undefined,
      carouselSubjectMode: customMeta.carouselSubjectMode as
        | PostGenerationInput['carouselSubjectMode']
        | undefined,
      carouselDocumentMode: (customMeta.carouselDocumentModeRequested ??
        customMeta.carouselDocumentMode) as
        | PostGenerationInput['carouselDocumentMode']
        | undefined,
      carouselDocumentAuthor: customMeta.carouselDocumentAuthor as
        | string
        | undefined,
      trainingDataCaptureOptIn: customMeta.trainingDataCaptureOptIn === true,
      replaceContentId: contentId,
      creditSlices,
      totalCost,
    };

    this.workerManager.ensureWorkerForUser(userId);
    const userQueue = this.getUserQueue(userId);

    await userQueue.add(
      'generate-content',
      {
        jobId: job.id,
        userId,
        preferences,
      },
      {
        jobId: job.id,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 10 },
      },
    );

    await this.generationJobRepository.stashJobPayload(job.id, { preferences });

    return {
      jobId: job.id,
      message: `Post regeneration started. ${totalCost} credits reserved.`,
      totalCost,
    };
  }

  /**
   * Regenerate carousel slides or images for an existing content.
   * Only charges for the media credits (not text credits).
   */
  async regenerateMedia(
    userId: string,
    contentId: string,
    regenerationType: 'carousel' | 'images',
  ): Promise<{ jobId: string; message: string; creditsCost: number }> {
    const content = await this.generatedContentRepository.findById(contentId);
    if (!content) {
      throw new BadRequestException('Content not found');
    }
    if ((content as any).user_id !== userId) {
      throw new BadRequestException('Unauthorized');
    }

    const pp = (content as any).performance_prediction as Record<string, unknown> | undefined;
    const customMeta = pp?.customTopicMeta as Record<string, unknown> | undefined;

    if (regenerationType === 'carousel') {
      const slides = customMeta?.slides as unknown[] | undefined;
      if (!slides || slides.length === 0) {
        throw new BadRequestException('No carousel slides found in content to regenerate');
      }

      const slideCount = slides.length;
      const creditsCost = regenerateCarouselCost(slideCount);

      const hasQuota = await this.quotaService.checkQuotaAvailable(userId, creditsCost);
      if (!hasQuota) {
        throw new BadRequestException(
          `Insufficient credits. Regenerating ${slideCount} slides requires ${creditsCost} credits.`,
        );
      }

      await this.enforceInFlightLimit(userId);
      const job = await this.generationJobRepository.create(userId);

      const creditSlices: CreditSlice[] = [];
      for (let i = 1; i <= slideCount; i++) {
        creditSlices.push({
          subtaskKey: `slide_${i}`,
          credits: CUSTOM_TOPIC_PRICING.SLIDE_PER_UNIT_CREDITS,
          halfCredits: CUSTOM_TOPIC_PRICING.SLIDE_PER_UNIT_HALF_CREDITS,
        });
      }

      try {
        await this.customTopicCreditService.reserveCredits(userId, job.id, creditSlices);
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        await this.generationJobRepository.updateError(job.id, `Credit reservation failed: ${rawMsg}`, 0);
        throw this.mapCustomTopicCreditReservationError(err);
      }

      this.workerManager.ensureWorkerForUser(userId);
      const userQueue = this.getUserQueue(userId);

      await userQueue.add(
        'regenerate-carousel',
        {
          jobId: job.id,
          userId,
          originalContentId: contentId,
          slides,
          carouselVisualStyle: customMeta?.carouselVisualStyleResolved ?? customMeta?.carouselVisualStyleRequested ?? 'handwritten_notebook',
          carouselNoteDensity: customMeta?.carouselNoteDensity ?? 'standard',
          carouselDocumentMode: customMeta?.carouselDocumentMode,
          carouselDocumentTheme: customMeta?.carouselDocumentTheme,
          creditSlices,
          totalCost: creditsCost,
        },
        {
          jobId: job.id,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: { count: 10 },
        },
      );

      return {
        jobId: job.id,
        message: `Carousel regeneration started. ${creditsCost} credits reserved.`,
        creditsCost,
      };
    }

    if (regenerationType === 'images') {
      const imagePrompts = customMeta?.imagePrompts as string[] | undefined;
      if (!imagePrompts || imagePrompts.length === 0) {
        throw new BadRequestException('No image prompts found in content to regenerate');
      }

      const imageCount = imagePrompts.length;
      const creditsCost = regenerateAllImagesCost(imageCount);

      const hasQuota = await this.quotaService.checkQuotaAvailable(userId, creditsCost);
      if (!hasQuota) {
        throw new BadRequestException(
          `Insufficient credits. Regenerating ${imageCount} images requires ${creditsCost} credits.`,
        );
      }

      await this.enforceInFlightLimit(userId);
      const job = await this.generationJobRepository.create(userId);

      const creditSlices: CreditSlice[] = [];
      for (let i = 1; i <= imageCount; i++) {
        creditSlices.push({
          subtaskKey: `image_${i}`,
          credits: CUSTOM_TOPIC_PRICING.IMAGE_PER_UNIT_CREDITS,
          halfCredits: CUSTOM_TOPIC_PRICING.IMAGE_PER_UNIT_HALF_CREDITS,
        });
      }

      try {
        await this.customTopicCreditService.reserveCredits(userId, job.id, creditSlices);
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        await this.generationJobRepository.updateError(job.id, `Credit reservation failed: ${rawMsg}`, 0);
        throw this.mapCustomTopicCreditReservationError(err);
      }

      this.workerManager.ensureWorkerForUser(userId);
      const userQueue = this.getUserQueue(userId);

      await userQueue.add(
        'regenerate-images',
        {
          jobId: job.id,
          userId,
          originalContentId: contentId,
          imagePrompts,
          creditSlices,
          totalCost: creditsCost,
        },
        {
          jobId: job.id,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: { count: 10 },
        },
      );

      return {
        jobId: job.id,
        message: `Image regeneration started. ${creditsCost} credits reserved.`,
        creditsCost,
      };
    }

    throw new BadRequestException('Invalid regeneration type');
  }

  /**
   * Regenerate a single AI-generated image at the given index inside an
   * existing content record. Charges 3 credits up-front (idempotent
   * `debitOnce` reservation); the worker either commits (job succeeds) or
   * refunds the slice (job fails).
   *
   * Disallowed when the content has no `imagePrompts` metadata (i.e. legacy
   * content or content where the image is user-uploaded). The frontend hides
   * the regenerate button in those cases, but we still hard-validate here.
   */
  async regenerateSingleImage(
    userId: string,
    contentId: string,
    imageIndex: number,
    opts?: {
      userOverridePrompt?: string;
      caption?: string;
      includeBrandKit?: boolean;
    },
  ): Promise<{ jobId: string; estimatedCost: number; message: string }> {
    if (!Number.isInteger(imageIndex) || imageIndex < 0) {
      throw new BadRequestException('imageIndex must be a non-negative integer');
    }

    const content = await this.generatedContentRepository.findById(contentId);
    if (!content) {
      throw new BadRequestException('Content not found');
    }
    if ((content as any).user_id !== userId) {
      throw new BadRequestException('Unauthorized');
    }

    const pp = (content as any).performance_prediction as
      | Record<string, unknown>
      | undefined;
    const customMeta = pp?.customTopicMeta as Record<string, unknown> | undefined;
    const imagePrompts = (customMeta?.imagePrompts as string[] | undefined) ?? [];
    const hasCustomMeta = Boolean(
      customMeta?.contentType ||
        imagePrompts.length > 0 ||
        String(customMeta?.topic ?? '').trim(),
    );
    if ((content as any).source !== 'custom' && !hasCustomMeta) {
      throw new BadRequestException(
        'Only AI-generated custom posts support image regeneration',
      );
    }

    let topic = String(customMeta?.topic ?? '').trim();
    if (!topic) {
      const body = String((content as any).content || '');
      const withoutFooter = body.split(/\n\n— Generated by/)[0]?.trim() ?? body.trim();
      topic =
        withoutFooter.split(/(?<=[.!?])\s+/)[0]?.trim() ||
        withoutFooter.slice(0, 300).trim();
    }
    if (!topic) {
      topic = String((content as any).title || '').trim();
    }

    const caption =
      (typeof opts?.caption === 'string' && opts.caption.trim()) ||
      String((content as any).content || '').trim();
    if (!caption || caption.length < 20) {
      throw new BadRequestException(
        'Post caption is required to regenerate an image',
      );
    }
    if (!topic || topic.length < 3) {
      throw new BadRequestException(
        'Original topic not found on this post — cannot regenerate image',
      );
    }

    const platform = (customMeta?.platform as 'linkedin' | 'instagram' | 'x') ?? 'linkedin';
    const includeBrandKit =
      opts?.includeBrandKit !== undefined
        ? opts.includeBrandKit
        : customMeta?.includeBrandKit !== false;

    const creditsCost = CUSTOM_TOPIC_PRICING.IMAGE_PER_UNIT_CREDITS;

    const hasQuota = await this.quotaService.checkQuotaAvailable(
      userId,
      creditsCost,
    );
    if (!hasQuota) {
      throw new HttpException(
        {
          code: 'insufficient_credits',
          message: `Insufficient credits. Regenerating one image costs ${creditsCost} credits.`,
          requiredCredits: creditsCost,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    await this.enforceInFlightLimit(userId);
    const job = await this.generationJobRepository.create(userId);

    const existingUrlCount = Array.isArray((content as any).image_urls)
      ? (content as any).image_urls.length
      : 0;
    const slice: CreditSlice = {
      subtaskKey: `image_regen_${existingUrlCount + 1}`,
      credits: CUSTOM_TOPIC_PRICING.IMAGE_PER_UNIT_CREDITS,
      halfCredits: CUSTOM_TOPIC_PRICING.IMAGE_PER_UNIT_HALF_CREDITS,
    };
    const creditSlices = [slice];

    try {
      await this.customTopicCreditService.reserveCredits(
        userId,
        job.id,
        creditSlices,
      );
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      await this.generationJobRepository.updateError(
        job.id,
        `Credit reservation failed: ${rawMsg}`,
        0,
      );
      throw this.mapCustomTopicCreditReservationError(err);
    }

    this.workerManager.ensureWorkerForUser(userId);
    const userQueue = this.getUserQueue(userId);

    await userQueue.add(
      'regenerate-image',
      {
        jobId: job.id,
        userId,
        originalContentId: contentId,
        imageIndex,
        creditSlices,
        totalCost: creditsCost,
        regenContext: {
          topic,
          caption,
          platform,
          includeBrandKit,
          variationNonce: `${Date.now()}-${existingUrlCount}-${imageIndex}`,
          userOverridePrompt: opts?.userOverridePrompt?.trim() || undefined,
        },
      },
      {
        jobId: job.id,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 10 },
      },
    );

    return {
      jobId: job.id,
      estimatedCost: creditsCost,
      message: `Image regeneration started. ${creditsCost} credits reserved.`,
    };
  }

  /**
   * Regenerate every slide of an existing carousel using the deck JSON that
   * was persisted on the original generation (no LLM re-call). Charges
   * 2.5 × slideCount credits as granular slices (one per slide), so a partial
   * failure refunds only the slides that didn't render.
   */
  async regenerateCarouselFromContent(
    userId: string,
    contentId: string,
    requestedSlideCount?: number,
  ): Promise<{ jobId: string; estimatedCost: number; message: string }> {
    const content = await this.generatedContentRepository.findById(contentId);
    if (!content) {
      throw new BadRequestException('Content not found');
    }
    if ((content as any).user_id !== userId) {
      throw new BadRequestException('Unauthorized');
    }

    const pp = (content as any).performance_prediction as
      | Record<string, unknown>
      | undefined;
    const customMeta = pp?.customTopicMeta as Record<string, unknown> | undefined;
    const slides = customMeta?.slides as unknown[] | undefined;
    if (!slides || slides.length === 0) {
      throw new BadRequestException(
        'No carousel deck found on this content. Carousels can only be regenerated when the original AI deck JSON is persisted.',
      );
    }

    const slideCount =
      typeof requestedSlideCount === 'number' &&
      Number.isInteger(requestedSlideCount) &&
      requestedSlideCount > 0
        ? Math.min(requestedSlideCount, slides.length)
        : slides.length;
    const targetSlides = slides.slice(0, slideCount);

    const creditsCost =
      CUSTOM_TOPIC_PRICING.SLIDE_PER_UNIT_CREDITS * slideCount;

    const hasQuota = await this.quotaService.checkQuotaAvailable(
      userId,
      creditsCost,
    );
    if (!hasQuota) {
      throw new HttpException(
        {
          code: 'insufficient_credits',
          message: `Insufficient credits. Regenerating ${slideCount} slides costs ${creditsCost} credits.`,
          requiredCredits: creditsCost,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    await this.enforceInFlightLimit(userId);
    const job = await this.generationJobRepository.create(userId);

    const creditSlices: CreditSlice[] = [];
    for (let i = 1; i <= slideCount; i++) {
      creditSlices.push({
        subtaskKey: `slide_regen_${i}`,
        credits: CUSTOM_TOPIC_PRICING.SLIDE_PER_UNIT_CREDITS,
        halfCredits: CUSTOM_TOPIC_PRICING.SLIDE_PER_UNIT_HALF_CREDITS,
      });
    }

    try {
      await this.customTopicCreditService.reserveCredits(
        userId,
        job.id,
        creditSlices,
      );
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      await this.generationJobRepository.updateError(
        job.id,
        `Credit reservation failed: ${rawMsg}`,
        0,
      );
      throw this.mapCustomTopicCreditReservationError(err);
    }

    this.workerManager.ensureWorkerForUser(userId);
    const userQueue = this.getUserQueue(userId);

    await userQueue.add(
      'regenerate-carousel-full',
      {
        jobId: job.id,
        userId,
        originalContentId: contentId,
        slides: targetSlides,
        carouselVisualStyle:
          customMeta?.carouselVisualStyleResolved ??
          customMeta?.carouselVisualStyleRequested ??
          'handwritten_notebook',
        carouselNoteDensity: customMeta?.carouselNoteDensity ?? 'standard',
        carouselDocumentMode: customMeta?.carouselDocumentMode,
        carouselDocumentTheme: customMeta?.carouselDocumentTheme,
        creditSlices,
        totalCost: creditsCost,
      },
      {
        jobId: job.id,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { count: 10 },
      },
    );

    return {
      jobId: job.id,
      estimatedCost: creditsCost,
      message: `Carousel regeneration started. ${creditsCost} credits reserved.`,
    };
  }

  /**
   * Format and improve user content using AI for LinkedIn posting.
   * This is a lightweight operation that costs 0.5 credits.
   */
  async formatContentWithAI(
    userId: string,
    content: string,
  ): Promise<{ formattedContent: string; creditsCost: number }> {
    const creditsCost = CREDIT_COSTS.aiTextFormatting;

    // Check if user has enough credits
    const hasQuota = await this.quotaService.checkQuotaAvailable(userId, creditsCost);
    if (!hasQuota) {
      throw new HttpException(
        {
          code: 'insufficient_credits',
          message: `Insufficient credits. Formatting content costs ${creditsCost} credits.`,
          requiredCredits: creditsCost,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // Deduct credits upfront
    await this.quotaService.consumeCredits(
      userId,
      creditsCost,
      'AI content formatting',
      'generation',
      'text',
    );

    try {
      const systemPrompt = `You are a text editor assistant. Your job is to LIGHTLY format and clean up the user's post.

STRICT RULES:
- Fix spelling and grammar mistakes ONLY
- Add line breaks between paragraphs if needed
- Keep the EXACT same length and message - do NOT expand or add new content
- Do NOT add greetings, sign-offs, or calls-to-action
- Do NOT add questions or engagement prompts
- Do NOT make it longer than the original
- Do NOT add hashtags
- Do NOT use markdown formatting (no **, __, etc.)
- Keep the user's original voice and tone
- If the content is already well-formatted, return it as-is with only spelling fixes

Return ONLY the cleaned-up text, nothing else.`;

      // Route through the Bifrost gateway text chain (admin-managed model +
      // automatic fallback to the next text model on failure — never fail).
      let formattedContent: string | undefined;
      let usedModel = '';
      try {
        const result = await this.aiGateway.chatCompletionRaw({
          category: 'text',
          temperature: 0.3,
          maxTokens: 2000,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content },
          ],
        });
        formattedContent = result.content?.trim();
        usedModel = result.model;
      } catch (gatewayError) {
        this.logger.error(
          `AI formatting gateway error: ${(gatewayError as Error).message}`,
        );
        // Refund credits when the whole text chain is unavailable.
        await this.quotaService.consumeCredits(
          userId,
          -creditsCost,
          'Refund: AI formatting unavailable',
          'refund',
          'text',
        );
        throw new HttpException(
          'AI formatting is not available at this time. Please try again later.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      if (!formattedContent) {
        // Refund credits if no content returned
        await this.quotaService.consumeCredits(
          userId,
          -creditsCost,
          'Refund: No formatted content returned',
          'refund',
          'text',
        );
        throw new HttpException(
          'Failed to format content. Please try again.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // TEMPORARY (debug): tag which model formatted the content so the user can
      // see which gateway model is working in the preview. Remove when asked —
      // tracked in Recallium (search "Formatted by" debug marker).
      if (usedModel) {
        formattedContent = `${formattedContent}\n\n— Formatted by ${usedModel}`;
      }

      return {
        formattedContent,
        creditsCost,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Format content error: ${error.message}`);
      // Refund credits on unexpected error
      await this.quotaService.consumeCredits(
        userId,
        -creditsCost,
        `Refund: Unexpected error - ${error.message}`,
        'refund',
        'text',
      );
      throw new HttpException(
        'Failed to format content. Please try again.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
