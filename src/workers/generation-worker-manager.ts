import { Injectable, Logger, OnModuleInit, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { N8nService } from '../services/n8n.service';
import { PostRefinementService } from '../services/post-refinement.service';
import { GenerationJobRepository } from '../repositories/generation-job.repository';
import { GeneratedContentRepository } from '../repositories/generated-content.repository';
import { GenerationWorker } from './generation.worker';
import { QUEUE_NAMES, JOB_STAGES } from '../common/constants';
import { JobStatus, ContentStatus, VisualType } from '../common/types';
import { MediaPostType, N8nGeneratedContentDto } from '../common/dto/media-intent.dto';
import { mergePerformancePredictionWithRefinementApplied } from '../common/utils/merge-performance-prediction';
import { isViralTopicsN8nPayload } from '../common/utils/viral-topics-detect';

type DirectGeneratedPost = N8nGeneratedContentDto & {
  performancePrediction?: Record<string, unknown>;
};

@Injectable()
export class GenerationWorkerManager implements OnModuleInit {
  private readonly logger = new Logger(GenerationWorkerManager.name);
  private workers: Map<string, Worker> = new Map();
  private activeUsers: Set<string> = new Set();
  private redis: Redis;

  constructor(
    private configService: ConfigService,
    private n8nService: N8nService,
    private postRefinementService: PostRefinementService,
    private generationJobRepository: GenerationJobRepository,
    private generatedContentRepository: GeneratedContentRepository,
    @Inject(forwardRef(() => GenerationWorker))
    private readonly generationWorker: GenerationWorker,
  ) {
    // Create Redis client for job completion signaling
    // Port comes from REDIS_PORT env var via config service (DragonflyDB uses 6380)
    const redisPort = this.configService.get<number>('redis.port') || 6379;
    this.logger.log(`GenerationWorkerManager: Connecting to Redis on port ${redisPort}`);
    this.redis = new Redis({
      host: this.configService.get<string>('redis.host') || 'localhost',
      port: redisPort,
      password: this.configService.get<string>('redis.password') || undefined,
    });
  }

  async onModuleInit() {
    // Log configuration for debugging
    const baseUrl = this.configService.get<string>('app.baseUrl');
    const n8nWebhookUrl = this.configService.get<string>('n8n.webhookUrl');
    const redisPort = this.configService.get<number>('redis.port');
    this.logger.log(
      JSON.stringify({
        event: 'worker_manager.init',
        baseUrl,
        n8nWebhookUrl,
        redisPort,
        hasWebhookSecret: !!this.configService.get<string>('n8n.webhookSecret'),
      }),
    );
    this.logger.log('Generation Worker Manager initialized');
    // Workers will be created dynamically when users create jobs

    // Clean up stale jobs on startup
    await this.cleanupStaleJobs();

    // Schedule periodic cleanup every 5 minutes
    setInterval(() => this.cleanupStaleJobs(), 5 * 60 * 1000);
  }

  /**
   * Clean up stale jobs that have been active for too long.
   * This prevents queue jams from stuck jobs.
   */
  private async cleanupStaleJobs(): Promise<void> {
    const staleThresholdMs = Number(
      // Must exceed BullMQ lockDuration (600s) so we never auto-fail a job that
      // is still legitimately processing inside the worker.
      process.env.GENERATION_ACTIVE_STALE_MS || '660000', // 11 minutes
    );

    try {
      // Find all active jobs older than the threshold
      const staleJobs = await this.generationJobRepository.findStaleActiveJobs(
        staleThresholdMs,
      );

      let markedCount = 0;
      let racedCount = 0;
      for (const job of staleJobs) {
        const updatedAtMs = new Date((job.updatedAt || job.createdAt) as any).getTime();
        const ageMs = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs : 0;

        // Atomic guard: if the worker wrote `ready`/`failed` between the SELECT
        // above and this UPDATE, the row is no longer in an active status and
        // the update silently no-ops. This prevents a sweeper-vs-worker race
        // from overwriting a freshly-completed job with `status=failed`, which
        // previously surfaced to users as ghost "failed" notifications next to
        // a successfully-generated post.
        const updated = await this.generationJobRepository.updateErrorIfStillActive(
          job.id,
          `Auto-failed stale job after ${Math.round(ageMs / 1000)}s without completion`,
          job.retryCount || 0,
        );
        if (updated) {
          markedCount += 1;
          this.logger.warn(
            `Cleaned up stale job ${job.id} (age=${Math.round(ageMs / 1000)}s)`,
          );
        } else {
          racedCount += 1;
          this.logger.log(
            `Stale-sweeper skipped job ${job.id} — already terminal (race with worker completion).`,
          );
        }
      }

      if (markedCount > 0 || racedCount > 0) {
        this.logger.log(
          `Stale job cleanup: marked ${markedCount} as failed (${racedCount} skipped — already terminal)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Stale job cleanup failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Get or create a worker for a specific user
   */
  getWorkerForUser(userId: string): Worker {
    if (!this.workers.has(userId)) {
      const queueName = `${QUEUE_NAMES.CONTENT_GENERATION}-${userId}`;
      const redisPort = this.configService.get<number>('redis.port') || 6379;

      const worker = new Worker(
        queueName,
        async (job: Job) => this.processJob(job),
        {
          connection: {
            host: this.configService.get<string>('redis.host') || 'localhost',
            port: redisPort,
            password:
              this.configService.get<string>('redis.password') || undefined,
          },
          // Per-user queue: 1 job at a time per user, but global rate limiter handles
          // cross-user coordination for OpenAI API load
          concurrency: 1,
          // Lock duration must comfortably exceed the longest realistic generation
          // (carousel + slide rendering + MinIO upload). 10 min matches the
          // frontend hard-timeout in useGenerationJob.ts so both sides agree on
          // the upper bound before declaring a stall.
          lockDuration: 600000,
          // Max stalled count: if job stalls 2 times, mark as failed
          maxStalledCount: 2,
          // Stalled job check interval: 30 seconds
          stalledInterval: 30000,
        },
      );

      worker.on('completed', (job) => {
        this.logger.log(`Job ${job.id} completed for user ${userId}`);
      });

      worker.on('failed', (job, err) => {
        this.logger.error(
          `Job ${job?.id} failed for user ${userId}: ${err.message}`,
        );
      });

      this.workers.set(userId, worker);
      this.activeUsers.add(userId);
      this.logger.log(`Created worker for user ${userId}`);
    }

    return this.workers.get(userId)!;
  }

  /**
   * Process a job (same logic as before, but per-user).
   *
   * Custom-topic jobs are delegated to `GenerationWorker.processCustomTopic`
   * because n8n has no custom-topic workflow; the rest of this method drives
   * n8n for viral / topic-discovery flows.
   */
  private async processJob(job: Job): Promise<any> {
    const { jobId, userId, preferences } = job.data;

    // Regeneration jobs ride the same per-user queue but never touch n8n —
    // dispatch them by job name straight to the GenerationWorker handler.
    // Without this dispatch they'd fall through to the n8n flow below and
    // silently time out (the @Processor on GenerationWorker is bound to a
    // different, unused queue name).
    if (job.name === 'regenerate-image') {
      return this.generationWorker.processSingleImageRegeneration(job);
    }
    if (job.name === 'regenerate-carousel-full') {
      return this.generationWorker.processFullCarouselRegeneration(job);
    }
    if (job.name === 'regenerate-carousel') {
      return this.generationWorker.processCarouselRegeneration(job);
    }
    if (job.name === 'regenerate-images') {
      return this.generationWorker.processImageRegeneration(job);
    }

    if (preferences?.jobType === 'custom_topic') {
      this.logger.log(
        JSON.stringify({
          event: 'generation.flow_routing',
          jobId,
          flow: 'custom_topic_direct',
          contentType: preferences?.contentType,
          reason: 'jobType=custom_topic → OpenAI direct (no n8n)',
        }),
      );
      return this.generationWorker.processCustomTopic(job);
    }

    this.logger.log(
      JSON.stringify({
        event: 'generation.flow_routing',
        jobId,
        flow: 'viral_n8n',
        contentType: preferences?.contentType,
        jobType: preferences?.jobType,
        reason: 'jobType≠custom_topic → n8n webhook pipeline',
      }),
    );

    const existingJob = await this.generationJobRepository.findById(jobId);
    if (existingJob?.status === JobStatus.READY && existingJob.contentId) {
      this.logger.log(
        JSON.stringify({
          event: 'generation.skip_already_ready',
          jobId,
          contentId: existingJob.contentId,
        }),
      );
      return {
        success: true,
        jobId,
        contentId: existingJob.contentId,
        message: 'Job already ready; skipping re-processing.',
      };
    }
    if (existingJob?.status === JobStatus.FAILED) {
      this.logger.log(
        JSON.stringify({
          event: 'generation.skip_already_failed',
          jobId,
          error: existingJob.error || null,
        }),
      );
      return {
        success: false,
        jobId,
        error: existingJob.error || 'Job already failed',
        message: 'Job already failed; skipping re-processing.',
      };
    }

    this.logger.log(
      `Processing generation job ${jobId} for user ${userId} ` +
        `(jobType=${String(job.data?.preferences?.jobType)}, contentType=${String(job.data?.preferences?.contentType)}). ` +
        `This pipeline is independent of post publishing.`,
    );

    try {
      await this.generationJobRepository.updateStatus(
        jobId,
        JobStatus.GENERATING,
        10,
        JOB_STAGES.TOPIC_DISCOVERY,
      );

      // Build callback URL for n8n to call when job completes
      const baseUrl =
        this.configService.get<string>('app.baseUrl');
      if (!baseUrl) {
        throw new Error('BACKEND_URL env var is required for n8n callback');
      }
      const webhookSecret = this.configService.get<string>('n8n.webhookSecret') || '';
      const callbackQuery = new URLSearchParams({ jobId });
      if (webhookSecret) {
        callbackQuery.set('secret', webhookSecret);
      }
      const callbackUrl = `${baseUrl}/webhook/n8n-callback?${callbackQuery.toString()}`;
      const carouselUrl =
        this.configService.get<string>('n8n.carouselWebhookUrl') || '';
      const ct = preferences?.contentType as string | undefined;
      const useCarousel = ct === 'carousel' && carouselUrl.length > 0;

      this.logger.log(
        JSON.stringify({
          event: 'generation.n8n.config',
          jobId,
          baseUrl,
          callbackUrl,
          n8nWebhookUrl: this.configService.get<string>('n8n.webhookUrl'),
          carouselWebhookUrl: carouselUrl,
          useCarousel,
          contentType: ct,
          jobType: preferences?.jobType,
          hasWebhookSecret: !!webhookSecret,
        }),
      );

      // Update progress to 15% before triggering n8n
      await this.generationJobRepository.updateStatus(
        jobId,
        JobStatus.GENERATING,
        15,
        JOB_STAGES.N8N_TRIGGERED,
      );

      const trigger = await this.n8nService.triggerContentGeneration(
        {
          jobId,
          userId,
          callbackUrl,
          callback_url: callbackUrl,
          callbackURL: callbackUrl,
          webhookCallbackUrl: callbackUrl,
          preferences,
        },
        useCarousel ? { webhookUrlOverride: carouselUrl } : undefined,
      );
      this.logger.log(
        JSON.stringify({
          event: 'generation.n8n.trigger_result',
          jobId,
          hasData: trigger?.data !== undefined && trigger?.data !== null,
          dataType:
            trigger?.data === null ? 'null' : typeof trigger?.data,
          dataKeys:
            trigger?.data && typeof trigger.data === 'object'
              ? Object.keys(trigger.data as Record<string, unknown>).slice(0, 15)
              : [],
        }),
      );

      // Fallback path: some topic workflows return data directly and never call callback.
      const isTopicJob =
        String(preferences?.jobType || '') === 'generate_topics' ||
        String(preferences?.contentType || '') === 'topics';
      if (isTopicJob && trigger?.data) {
        const normalized = this.extractTopicsFromN8nResponse(trigger.data);
        if (normalized.length > 0) {
          const contentText = [
            'Here are current viral topic ideas:',
            '',
            ...normalized.map((t, i) => `${i + 1}. ${t}`),
          ].join('\n');

          const created = await this.generatedContentRepository.create(
            userId,
            'Viral Topic Ideas',
            contentText.slice(0, 5000),
            {
              jobId,
              status: ContentStatus.READY,
              visualType: VisualType.NONE,
              hashtags: [],
              aiReasoning:
                'Generated from direct n8n topics response (callback fallback path)',
              performancePrediction:
                mergePerformancePredictionWithRefinementApplied({
                  source: 'n8n-direct-topics-response',
                  topics: normalized,
                  pipeline: 'topics',
                }),
            },
          );

          await this.generationJobRepository.updateWithContent(
            jobId,
            created.id,
            JobStatus.READY,
            {
              title: 'Viral Topic Ideas',
              content: contentText.slice(0, 5000),
              hashtags: [],
              source: 'n8n-direct-topics-response',
            },
          );

          const completionKey = `job:${jobId}:completed`;
          await this.redis.setex(
            completionKey,
            300,
            JSON.stringify({
              status: 'success',
              contentId: created.id,
              timestamp: new Date().toISOString(),
            }),
          );
          await job.updateProgress(100);
          this.logger.log(
            `✅ Job ${jobId} completed from direct n8n topics response (no callback needed)`,
          );
          return {
            success: true,
            jobId,
            contentId: created.id,
            message: 'Content generated successfully (direct n8n response)',
          };
        }
        const responseKeys =
          trigger.data && typeof trigger.data === 'object'
            ? Object.keys(trigger.data as Record<string, unknown>).slice(0, 15)
            : [];
        this.logger.warn(
          `Topic job ${jobId} received direct n8n response without parsable topics. ` +
            `dataType=${typeof trigger.data} keys=${JSON.stringify(responseKeys)}`,
        );
      }

      // Fallback path: some n8n workflows return final post payload directly.
      const directPostContent = this.extractDirectGeneratedPost(trigger?.data);
      if (directPostContent) {
        this.logger.log(
          JSON.stringify({
            event: 'generation.direct_post.detected',
            jobId,
            titleLength: (directPostContent.title || '').length,
            contentLength: (directPostContent.content || '').length,
            postType: directPostContent.postType || 'unknown',
          }),
        );
        const sourceUrl =
          (directPostContent.performancePrediction?.postMeta as any)?.link ||
          (directPostContent.performancePrediction as any)?.sourceLink ||
          undefined;
        const refined = await this.postRefinementService.refine({
          platform: 'linkedin',
          content: directPostContent,
          sourceUrl,
        });
        this.logger.log(
          JSON.stringify({
            event: 'generation.direct_post.refined',
            jobId,
            refinedLength: refined.content.length,
            hashtagCount: refined.hashtags.length,
            qualityScore: refined.quality.score,
          }),
        );
        const visualType =
          directPostContent.postType === MediaPostType.CAROUSEL
            ? VisualType.CAROUSEL
            : directPostContent.postType === MediaPostType.SINGLE
              ? VisualType.IMAGE
              : VisualType.NONE;
        const created = await this.generatedContentRepository.create(
          userId,
          refined.title,
          refined.content,
          {
            jobId,
            status:
              visualType === VisualType.NONE
                ? ContentStatus.READY
                : ContentStatus.MEDIA_GENERATING,
            visualType,
            hashtags: refined.hashtags,
            aiScore: directPostContent.aiScore,
            aiReasoning: directPostContent.aiReasoning,
            performancePrediction:
              mergePerformancePredictionWithRefinementApplied({
                ...(directPostContent.performancePrediction || {}),
                source: 'n8n-direct-post-response',
              }),
          },
        );
        await this.generationJobRepository.updateWithContent(
          jobId,
          created.id,
          JobStatus.READY,
          {
            title: refined.title,
            content: refined.content,
            hashtags: refined.hashtags,
            source: 'n8n-direct-post-response',
          },
        );
        const completionKey = `job:${jobId}:completed`;
        await this.redis.setex(
          completionKey,
          300,
          JSON.stringify({
            status: 'success',
            contentId: created.id,
            timestamp: new Date().toISOString(),
          }),
        );
        await job.updateProgress(100);
        this.logger.log(
          `✅ Job ${jobId} completed from direct n8n post response (no callback needed)`,
        );
        return {
          success: true,
          jobId,
          contentId: created.id,
          message: 'Content generated successfully (direct n8n post response)',
        };
      }

      await this.generationJobRepository.updateStatus(
        jobId,
        JobStatus.GENERATING,
        30,
        JOB_STAGES.WAITING_FOR_CALLBACK,
      );

      this.logger.log(
        `🚀 n8n webhook triggered for job ${jobId}, waiting for completion...`,
      );

      // Wait for n8n to complete by checking Redis completion signal
      // The webhook will set a Redis key when n8n completes
      const configuredMaxWaitTime = Number(
        this.configService.get<string>('n8n.workflowTimeoutMs') || '300000',
      );
      const configuredTopicsMaxWaitTime = Number(
        process.env.N8N_TOPICS_TIMEOUT_MS || configuredMaxWaitTime,
      );
      const isTopicJobForTimeout =
        String(preferences?.jobType || '') === 'generate_topics' ||
        String(preferences?.contentType || '') === 'topics';
      const maxWaitTime = isTopicJobForTimeout
        ? configuredTopicsMaxWaitTime
        : configuredMaxWaitTime;
      this.logger.log(
        JSON.stringify({
          event: 'generation.wait_config',
          jobId,
          isTopicJob: isTopicJobForTimeout,
          maxWaitTimeMs: maxWaitTime,
          workflowTimeoutMs: configuredMaxWaitTime,
          topicsTimeoutMs: configuredTopicsMaxWaitTime,
        }),
      );
      const pollInterval = 1000; // Check every 1 second
      const startTime = Date.now();
      const completionKey = `job:${jobId}:completed`;

      while (Date.now() - startTime < maxWaitTime) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));

        // Check Redis for completion signal (webhook sets this)
        const completionData = await this.redis.get(completionKey);

        if (completionData) {
          const result = JSON.parse(completionData);
          this.logger.log(
            `✅ Job ${jobId} completed (Redis): ${result.status}`,
          );

          await this.redis.del(completionKey);

          if (result.status === 'success') {
            await job.updateProgress(100);
            return {
              success: true,
              jobId,
              contentId: result.contentId,
              message: 'Content generated successfully by n8n',
            };
          } else {
            throw new Error(result.error || 'n8n workflow failed');
          }
        }

        // Fallback: same source of truth as the other worker — Supabase job row.
        // If Redis was flushed, keys missed, or webhook could not write Redis, n8n can
        // still complete via /webhook/n8n-callback and mark the job ready in DB.
        const dbJob = await this.generationJobRepository.findById(jobId);
        if (dbJob?.status === JobStatus.READY && dbJob.contentId) {
          if (!isTopicJobForTimeout) {
            await this.ensureRefinedBeforeFinalize(jobId, dbJob.contentId);
          }
          this.logger.log(
            `✅ Job ${jobId} completed (DB fallback, contentId=${dbJob.contentId})`,
          );
          await job.updateProgress(100);
          return {
            success: true,
            jobId,
            contentId: dbJob.contentId,
            message: 'Content generated successfully by n8n',
          };
        }
        if (dbJob?.status === JobStatus.FAILED) {
          throw new Error(dbJob.error || 'n8n workflow failed');
        }

        // Callback-free path:
        // If n8n (or another backend path) has already created generated_content for this job,
        // finalize here without waiting for webhook callback.
        const generatedForJob =
          !dbJob?.contentId && dbJob?.status !== JobStatus.READY
            ? await this.generatedContentRepository.findByJobId(jobId)
            : [];
        if (generatedForJob.length > 0) {
          const latest = generatedForJob[0] as any;
          this.logger.log(
            JSON.stringify({
              event: 'generation.db_content_detected',
              jobId,
              contentId: latest.id,
              status: latest.status,
              contentLength: String(latest.content || '').length,
            }),
          );

          const isTopicLike = this.isTopicContentRecord(latest);

          if (isTopicLike) {
            await this.generationJobRepository.updateWithContent(
              jobId,
              latest.id,
              JobStatus.READY,
              {
                title: String(latest.title || 'Viral Topic Ideas'),
                content: String(latest.content || '').slice(0, 5000),
                hashtags: Array.isArray(latest.hashtags) ? latest.hashtags : [],
                source: 'db-detected-topics',
              },
            );
            await job.updateProgress(100);
            this.logger.log(
              JSON.stringify({
                event: 'generation.db_content_finalized',
                jobId,
                mode: 'topics',
                refined: false,
              }),
            );
            return {
              success: true,
              jobId,
              contentId: latest.id,
              message: 'Content finalized from DB without callback',
            };
          }

          const refined = await this.postRefinementService.refine({
            platform: 'linkedin',
            content: {
              title: String(latest.title || ''),
              content: String(latest.content || ''),
              hashtags: Array.isArray(latest.hashtags)
                ? latest.hashtags.map((t: unknown) => String(t))
                : [],
              postType:
                String(latest.visual_type || '').toLowerCase() === 'carousel'
                  ? MediaPostType.CAROUSEL
                  : MediaPostType.SINGLE,
            },
            sourceUrl:
              (latest.performance_prediction as any)?.postMeta?.link ||
              (latest.performance_prediction as any)?.sourceLink ||
              undefined,
          });

          await this.generatedContentRepository.updateContent(latest.id, {
            title: refined.title,
            content: refined.content,
            hashtags: refined.hashtags,
            performance_prediction: mergePerformancePredictionWithRefinementApplied(
              latest.performance_prediction,
            ),
          });

          await this.generationJobRepository.updateWithContent(
            jobId,
            latest.id,
            JobStatus.READY,
            {
              title: refined.title,
              content: refined.content,
              hashtags: refined.hashtags,
              source: 'db-detected-refined',
              refinement: {
                qualityScore: refined.quality.score,
                qualityReasons: refined.quality.reasons,
              },
            },
          );
          await job.updateProgress(100);
          this.logger.log(
            JSON.stringify({
              event: 'generation.db_content_finalized',
              jobId,
              mode: 'post',
              refined: true,
              qualityScore: refined.quality.score,
            }),
          );
          return {
            success: true,
            jobId,
            contentId: latest.id,
            message: 'Content finalized from DB with refinement',
          };
        }

        // Fallback when n8n writes generated_content directly but forgets job_id:
        // with one active job per user, newest unlinked content since job creation
        // is considered this job's result.
        if (!dbJob?.contentId && dbJob?.status !== JobStatus.READY) {
          const unlinked =
            await this.generatedContentRepository.findLatestUnlinkedByUserSince(
              userId,
              new Date(dbJob?.createdAt || startTime).toISOString(),
            );
          if (unlinked) {
            const attached =
              await this.generatedContentRepository.attachJobIdIfMissing(
                (unlinked as any).id,
                jobId,
              );
            const adopted = (attached || unlinked) as any;
            this.logger.log(
              JSON.stringify({
                event: 'generation.unlinked_content_adopted',
                jobId,
                contentId: adopted.id,
                attachedJobId: Boolean(attached),
              }),
            );

            const isTopicLike = this.isTopicContentRecord(adopted);
            if (isTopicLike) {
              await this.generationJobRepository.updateWithContent(
                jobId,
                adopted.id,
                JobStatus.READY,
                {
                  title: String(adopted.title || 'Viral Topic Ideas'),
                  content: String(adopted.content || '').slice(0, 5000),
                  hashtags: Array.isArray(adopted.hashtags) ? adopted.hashtags : [],
                  source: 'db-unlinked-adopted-topics',
                },
              );
              await job.updateProgress(100);
              return {
                success: true,
                jobId,
                contentId: adopted.id,
                message: 'Unlinked DB content adopted and finalized',
              };
            }

            const refined = await this.postRefinementService.refine({
              platform: 'linkedin',
              content: {
                title: String(adopted.title || ''),
                content: String(adopted.content || ''),
                hashtags: Array.isArray(adopted.hashtags)
                  ? adopted.hashtags.map((h: unknown) => String(h))
                  : [],
                postType:
                  String(adopted.visual_type || '').toLowerCase() === 'carousel'
                    ? MediaPostType.CAROUSEL
                    : MediaPostType.SINGLE,
              },
              sourceUrl:
                (adopted.performance_prediction as any)?.postMeta?.link ||
                (adopted.performance_prediction as any)?.sourceLink ||
                undefined,
            });

            await this.generatedContentRepository.updateContent(adopted.id, {
              title: refined.title,
              content: refined.content,
              hashtags: refined.hashtags,
              performance_prediction: mergePerformancePredictionWithRefinementApplied(
                adopted.performance_prediction,
              ),
            });
            await this.generationJobRepository.updateWithContent(
              jobId,
              adopted.id,
              JobStatus.READY,
              {
                title: refined.title,
                content: refined.content,
                hashtags: refined.hashtags,
                source: 'db-unlinked-adopted-refined',
                refinement: {
                  qualityScore: refined.quality.score,
                  qualityReasons: refined.quality.reasons,
                },
              },
            );
            await job.updateProgress(100);
            return {
              success: true,
              jobId,
              contentId: adopted.id,
              message: 'Unlinked DB content adopted, refined, and finalized',
            };
          }
        }

        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        // Avoid noisy per-second logs; this wait is server-side (worker↔n8n), not browser network.
        if (elapsedSec % 10 === 0) {
          this.logger.log(
            `⏳ [GENERATION] Waiting for n8n callback for job ${jobId} ` +
              `(jobType=${String(preferences?.jobType)}, contentType=${String(preferences?.contentType)})... ` +
              `(${elapsedSec}s, independent of /posts/publish)`,
          );
        }
      }

      // Timeout - n8n didn't respond
      this.logger.error(
        `⏰ [GENERATION] Job ${jobId} timed out waiting for n8n (${Math.round(maxWaitTime / 1000)} seconds). ` +
          `Post publishing is unaffected.`,
      );
      await this.generationJobRepository.updateError(
        jobId,
        `n8n workflow timeout - no response after ${Math.round(maxWaitTime / 1000)} seconds`,
        0,
      );

      throw new Error('n8n workflow timeout');
    } catch (error) {
      this.logger.error(
        `Failed to process generation job ${jobId}: ${error.message}`,
      );

      // Mark job as failed in database
      await this.generationJobRepository.updateError(
        jobId,
        error.message,
        0, // No auto-retry
      );

      // Don't throw error to prevent BullMQ from retrying
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

  /**
   * Ensure worker exists for user (called when job is created)
   */
  ensureWorkerForUser(userId: string): void {
    this.getWorkerForUser(userId);
  }

  /**
   * Get all active workers
   */
  getActiveWorkers(): string[] {
    return Array.from(this.activeUsers);
  }

  /**
   * Cleanup worker for user (optional, for resource management)
   */
  async cleanupWorkerForUser(userId: string): Promise<void> {
    const worker = this.workers.get(userId);
    if (worker) {
      await worker.close();
      this.workers.delete(userId);
      this.activeUsers.delete(userId);
      this.logger.log(`Cleaned up worker for user ${userId}`);
    }
  }

  private extractTopicsFromN8nResponse(data: unknown): string[] {
    const root =
      Array.isArray(data) && data.length > 0
        ? (data[0] as Record<string, unknown>)
        : (data as Record<string, unknown>);
    if (!root || typeof root !== 'object') return [];

    const directTopics =
      (Array.isArray((root as any).topics) ? (root as any).topics : undefined) ||
      (Array.isArray((root as any)?.data?.topics)
        ? (root as any).data.topics
        : undefined) ||
      (Array.isArray((root as any)?.output?.topics)
        ? (root as any).output.topics
        : undefined);

    const normalizeTopicArray = (topicsRaw: unknown[]): string[] =>
      topicsRaw
        .map((topic: any) => {
          if (typeof topic === 'string') return topic.trim();
          const title = String(topic?.title || topic?.topic || topic?.name || '').trim();
          const reason = String(topic?.reason || topic?.why || '').trim();
          if (title && reason) return `${title} — ${reason}`;
          return title;
        })
        .filter((v: string) => v.length > 0)
        .slice(0, 12);

    if (Array.isArray(directTopics)) {
      return normalizeTopicArray(directTopics);
    }

    const seen = new Set<unknown>();
    const queue: unknown[] = [root];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || seen.has(current)) {
        continue;
      }
      seen.add(current);
      const obj = current as Record<string, unknown>;

      const nestedTopics = obj.topics;
      if (Array.isArray(nestedTopics)) {
        const normalized = normalizeTopicArray(nestedTopics);
        if (normalized.length > 0) {
          return normalized;
        }
      }

      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') {
          queue.push(value);
        }
      }
    }

    const textCandidates: string[] = [];
    const enqueueText = (value: unknown) => {
      if (typeof value === 'string' && value.trim().length > 0) {
        textCandidates.push(value.trim());
      }
    };
    enqueueText((root as any).content);
    enqueueText((root as any).text);
    enqueueText((root as any).message);
    enqueueText((root as any)?.data?.content);
    enqueueText((root as any)?.output?.content);

    for (const text of textCandidates) {
      const parsed = text
        .split('\n')
        .map((line) =>
          line
            .replace(/^\s*[-*]\s+/, '')
            .replace(/^\s*\d+[.)]\s+/, '')
            .trim(),
        )
        .filter((line) => line.length > 12)
        .slice(0, 12);
      if (parsed.length >= 3) {
        return parsed;
      }
    }

    return [];
  }

  private extractDirectGeneratedPost(data: unknown): DirectGeneratedPost | null {
    const root =
      Array.isArray(data) && data.length > 0
        ? (data[0] as Record<string, unknown>)
        : (data as Record<string, unknown>);
    if (!root || typeof root !== 'object') {
      return null;
    }

    const post = root.post as Record<string, unknown> | undefined;
    if (!post || typeof post !== 'object') {
      return null;
    }
    const title = String(post.title ?? '').trim().slice(0, 180);
    const content = String(post.content ?? '').trim().slice(0, 5000);
    if (!title || !content) {
      return null;
    }

    const hashtags = Array.isArray(root.hashtags)
      ? (root.hashtags as unknown[])
          .map((h) => String(h || '').trim())
          .filter(Boolean)
          .slice(0, 12)
      : undefined;

    const visual = root.visual as Record<string, unknown> | undefined;
    const visualType = String(visual?.type || '').trim().toLowerCase();
    const isCarousel = visualType === 'carousel';
    const slides =
      isCarousel && Array.isArray(visual?.carouselSlides)
        ? (visual.carouselSlides as Array<Record<string, unknown>>).map((s) => ({
            headline: String(s.headline ?? '').trim().slice(0, 200),
            body: String(s.body ?? '').trim().slice(0, 500),
            imagePrompt: String(s.imagePrompt ?? '')
              .trim()
              .slice(0, 1500),
          }))
        : undefined;

    const dto: DirectGeneratedPost = {
      title,
      content,
      hashtags,
      postType: isCarousel ? MediaPostType.CAROUSEL : MediaPostType.SINGLE,
      imagePrompt:
        !isCarousel && typeof visual?.imagePrompt === 'string'
          ? String(visual.imagePrompt).trim().slice(0, 1500)
          : undefined,
      slides,
      aiScore:
        typeof post.finalScore === 'number'
          ? post.finalScore
          : typeof post.aiScore === 'number'
            ? post.aiScore
            : undefined,
      aiReasoning:
        typeof post.reason === 'string' ? String(post.reason).trim() : undefined,
      performancePrediction: {
        source: 'n8n-direct-post-response',
        postMeta: {
          link: typeof post.link === 'string' ? post.link : undefined,
          source: typeof post.source === 'string' ? post.source : undefined,
          category: typeof post.category === 'string' ? post.category : undefined,
          originalScore: post.originalScore,
          finalScore: post.finalScore,
        },
      },
    };
    return dto;
  }

  private async ensureRefinedBeforeFinalize(
    jobId: string,
    contentId: string,
  ): Promise<void> {
    const existing = (await this.generatedContentRepository.findById(
      contentId,
    )) as any;
    if (!existing) return;

    if (isViralTopicsN8nPayload(existing.title, existing.content)) {
      await this.generatedContentRepository.updateContent(contentId, {
        performance_prediction: mergePerformancePredictionWithRefinementApplied(
          existing.performance_prediction,
        ),
      });
      this.logger.log(
        JSON.stringify({
          event: 'generation.refine.skip_topics_list',
          jobId,
          contentId,
        }),
      );
      return;
    }

    const currentText = String(existing.content || '');
    const refinementDone =
      (existing.performance_prediction as any)?.postRefinement?.applied === true;
    if (refinementDone) {
      this.logger.log(
        JSON.stringify({
          event: 'generation.refine.skip_already_applied',
          jobId,
          contentId,
        }),
      );
      return;
    }

    const refined = await this.postRefinementService.refine({
      platform: 'linkedin',
      content: {
        title: String(existing.title || ''),
        content: currentText,
        hashtags: Array.isArray(existing.hashtags)
          ? existing.hashtags.map((h: unknown) => String(h))
          : [],
        postType:
          String(existing.visual_type || '').toLowerCase() === 'carousel'
            ? MediaPostType.CAROUSEL
            : MediaPostType.SINGLE,
      },
      sourceUrl:
        (existing.performance_prediction as any)?.postMeta?.link ||
        (existing.performance_prediction as any)?.sourceLink ||
        undefined,
    });

    await this.generatedContentRepository.updateContent(contentId, {
      title: refined.title,
      content: refined.content,
      hashtags: refined.hashtags,
      performance_prediction: mergePerformancePredictionWithRefinementApplied(
        existing.performance_prediction,
      ),
    });
    await this.generationJobRepository.updateWithContent(
      jobId,
      contentId,
      JobStatus.READY,
      {
        title: refined.title,
        content: refined.content,
        hashtags: refined.hashtags,
        source: 'worker-db-fallback-refine',
        refinement: {
          qualityScore: refined.quality.score,
          qualityReasons: refined.quality.reasons,
        },
      },
    );
    this.logger.log(
      JSON.stringify({
        event: 'generation.refine.applied',
        jobId,
        contentId,
        qualityScore: refined.quality.score,
        outputLength: refined.content.length,
      }),
    );
  }

  private isTopicContentRecord(record: any): boolean {
    const title = String(record?.title || '').toLowerCase();
    const body = String(record?.content || '').toLowerCase();
    const visualType = String(record?.visual_type || '').toLowerCase();
    const hashtagCount = Array.isArray(record?.hashtags) ? record.hashtags.length : 0;
    const looksLikeTopicTitle = title.includes('viral topic');
    const looksLikeTopicBody =
      body.startsWith('here are current viral topic ideas') ||
      body.includes('topic ideas');
    const hasLikelyPostVisual = visualType === 'image' || visualType === 'carousel';
    if (hasLikelyPostVisual) return false;
    if (looksLikeTopicTitle || looksLikeTopicBody) return true;
    return hashtagCount === 0 && /\n\d+\.\s/.test(body);
  }
}
