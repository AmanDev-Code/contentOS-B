import {
  Controller,
  Post,
  Body,
  Logger,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import Redis from 'ioredis';
import { GenerationJobRepository } from '../repositories/generation-job.repository';
import { GeneratedContentRepository } from '../repositories/generated-content.repository';
import { ContentStatus, JobStatus, VisualType } from '../common/types';
import {
  MediaPostType,
  N8nGeneratedContentDto,
} from '../common/dto/media-intent.dto';
import { normalizeN8nCallbackBody } from '../common/utils/n8n-callback-normalize';
import { mergePerformancePredictionWithRefinementApplied } from '../common/utils/merge-performance-prediction';
import { isViralTopicsN8nPayload } from '../common/utils/viral-topics-detect';
import { PostRefinementService } from '../services/post-refinement.service';

@ApiTags('webhook')
@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);
  private redis: Redis;

  constructor(
    private configService: ConfigService,
    private generationJobRepository: GenerationJobRepository,
    private generatedContentRepository: GeneratedContentRepository,
    private postRefinementService: PostRefinementService,
  ) {
    // Create Redis client for signaling job completion to workers
    this.redis = new Redis({
      host: this.configService.get<string>('redis.host') || 'localhost',
      port: parseInt(
        this.configService.get<string>('redis.port') || '6379',
        10,
      ),
      password: this.configService.get<string>('redis.password') || undefined,
    });
  }

  /**
   * When N8N_WEBHOOK_SECRET is set, require header X-N8N-Webhook-Secret (constant-time compare).
   * If unset, behavior matches previous open webhooks (backward compatible).
   */
  private assertN8nWebhookSecret(req: Request): void {
    const expected = this.configService.get<string>('n8n.webhookSecret');
    if (!expected) {
      return;
    }
    const raw = req.headers['x-n8n-webhook-secret'];
    const providedHeader = Array.isArray(raw) ? raw[0] : raw;
    const querySecretRaw = (req.query as any)?.secret;
    const providedQuery = Array.isArray(querySecretRaw)
      ? querySecretRaw[0]
      : querySecretRaw;
    const provided =
      (typeof providedHeader === 'string' && providedHeader) ||
      (typeof providedQuery === 'string' && providedQuery) ||
      '';
    if (!provided || typeof provided !== 'string') {
      throw new UnauthorizedException('Missing webhook secret');
    }
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    if (!timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
  }

  @Post('n8n-progress')
  @ApiOperation({ summary: 'Receive progress updates from n8n workflow' })
  async handleN8nProgress(
    @Req() req: Request,
    @Body() payload: { jobId: string; progress: number; stage?: string },
  ) {
    this.assertN8nWebhookSecret(req);
    this.logger.log(
      `Received progress update for job ${payload.jobId}: ${payload.progress}%`,
    );

    try {
      const current = await this.generationJobRepository.findById(
        payload.jobId,
      );
      if (!current) {
        this.logger.warn(
          `Progress update ignored: job ${payload.jobId} not found`,
        );
        return { success: false, message: 'Job not found' };
      }
      if (
        current.status === JobStatus.READY ||
        current.status === JobStatus.FAILED
      ) {
        return {
          success: true,
          message: 'Ignored progress update for terminal job',
        };
      }
      const nextProgress = Math.max(
        current.progress || 0,
        payload.progress || 0,
      );
      await this.generationJobRepository.updateStatus(
        payload.jobId,
        JobStatus.GENERATING,
        nextProgress,
        payload.stage,
      );

      return {
        success: true,
        message: 'Progress updated successfully',
      };
    } catch (error) {
      this.logger.error(
        `Error updating progress for job ${payload.jobId}: ${(error as Error).message}`,
      );
      return {
        success: false,
        message: 'Failed to update progress',
      };
    }
  }

  @Post('n8n-callback')
  @ApiOperation({ summary: 'Receive callback from n8n workflow' })
  async handleN8nCallback(@Req() req: Request, @Body() body: unknown) {
    this.assertN8nWebhookSecret(req);
    let payload: ReturnType<typeof normalizeN8nCallbackBody>;
    try {
      payload = normalizeN8nCallbackBody(body);
    } catch (e) {
      const normalizeError = (e as Error).message;
      this.logger.error(`n8n callback normalize failed: ${normalizeError}`);

      // Best-effort recovery: if jobId is present in raw body, mark the job failed
      // and signal workers, so UI doesn't remain "processing" until timeout.
      const raw = Array.isArray(body) && body.length > 0 ? (body[0] as any) : (body as any);
      const rawJobId =
        raw && typeof raw === 'object' && typeof raw.jobId === 'string'
          ? String(raw.jobId).trim()
          : '';
      const queryJobIdRaw = (req.query as any)?.jobId;
      const queryJobId =
        typeof queryJobIdRaw === 'string' ? queryJobIdRaw.trim() : '';
      const recoverJobId = rawJobId || queryJobId;

      if (recoverJobId) {
        try {
          const job = await this.generationJobRepository.findById(recoverJobId);
          if (job) {
            await this.generationJobRepository.updateError(
              recoverJobId,
              `Invalid n8n callback payload: ${normalizeError}`,
              (job.retryCount || 0) + 1,
            );

            const completionKey = `job:${recoverJobId}:completed`;
            await this.redis.setex(
              completionKey,
              300,
              JSON.stringify({
                status: 'failed',
                error: `Invalid n8n callback payload: ${normalizeError}`,
                timestamp: new Date().toISOString(),
              }),
            );
            this.logger.warn(
              `Marked job ${recoverJobId} failed due to invalid callback shape and signaled worker`,
            );
          }
        } catch (recoverErr) {
          this.logger.error(
            `Failed to mark job ${recoverJobId} failed after normalize error: ${(recoverErr as Error).message}`,
          );
        }
      }

      return { success: false, message: normalizeError };
    }

    this.logger.log(`Received n8n callback for job ${payload.jobId}`);

    try {
      const job = await this.generationJobRepository.findById(payload.jobId);
      if (!job) {
        this.logger.error(`Job ${payload.jobId} not found`);
        return { success: false, message: 'Job not found' };
      }
      if (job.status === JobStatus.READY && job.contentId) {
        this.logger.log(
          `Job ${payload.jobId} already READY with content ${job.contentId}; ignoring duplicate callback`,
        );
        return {
          success: true,
          message: 'Job already completed',
          contentId: job.contentId,
        };
      }

      if (payload.status === 'success' && payload.content) {
        const c = payload.content as N8nGeneratedContentDto;
        const topicList = isViralTopicsN8nPayload(c.title, c.content);
        if (!topicList) {
          this.assertIntentContract(c);
        }

        const sourceUrl =
          (payload.content?.performancePrediction?.postMeta as any)?.link ||
          (payload.content?.performancePrediction as any)?.sourceLink ||
          undefined;

        const refined = topicList
          ? {
              title: String(c.title || 'Viral Topic Ideas').slice(0, 180),
              content: String(c.content || '').slice(0, 5000),
              hashtags: Array.isArray(c.hashtags) ? c.hashtags : [],
              quality: {
                score: 100,
                passed: true,
                reasons: ['topics_list_persisted_without_linkedin_refinement'],
              },
            }
          : await this.postRefinementService.refine({
              platform: 'linkedin',
              content: c,
              sourceUrl,
            });

        if (!topicList && !refined.quality.passed) {
          this.logger.warn(
            `n8n callback: refined content quality marginal (${refined.quality.score}) for job ${payload.jobId}; persisting anyway`,
          );
        }

        const perfBase = {
          ...(payload.content.performancePrediction || {}),
          ...(topicList
            ? { source: 'n8n-topics-callback' }
            : {
                refinement: {
                  platform: 'linkedin',
                  qualityScore: refined.quality.score,
                  qualityReasons: refined.quality.reasons,
                },
              }),
        };
        const performancePredictionForDb =
          mergePerformancePredictionWithRefinementApplied(perfBase);

        const visualType =
          c.postType === MediaPostType.CAROUSEL
            ? VisualType.CAROUSEL
            : c.postType === MediaPostType.SINGLE
              ? VisualType.IMAGE
              : (c.visualType as VisualType) || VisualType.NONE;

        const content = await this.generatedContentRepository.create(
          job.userId,
          refined.title,
          refined.content,
          {
            jobId: payload.jobId,
            aiScore: c.aiScore,
            visualType,
            visualUrl: c.visualUrl,
            carouselUrls: c.carouselUrls,
            hashtags: refined.hashtags,
            aiReasoning:
              c.aiReasoning ||
              (topicList
                ? 'Viral topics from n8n'
                : `Refined for LinkedIn (${refined.quality.score}/100): ${refined.quality.reasons.join(', ') || 'passed'}`),
            performancePrediction: performancePredictionForDb,
            status:
              visualType === VisualType.NONE
                ? ContentStatus.READY
                : ContentStatus.MEDIA_GENERATING,
          },
        );

        const jobResponsePayload = {
          title: refined.title,
          content: refined.content,
          hashtags: refined.hashtags,
          postType: c.postType,
          imagePrompt: c.imagePrompt,
          slides: c.slides,
          visualUrl: c.visualUrl,
          carouselUrls: c.carouselUrls,
          aiScore: c.aiScore,
          aiReasoning: c.aiReasoning,
          performancePrediction: performancePredictionForDb,
        };

        await this.generationJobRepository.updateWithContent(
          payload.jobId,
          content.id,
          JobStatus.READY,
          jobResponsePayload,
        );
        this.logger.log(
          `✅ Job ${payload.jobId} status updated to READY with content ${content.id}`,
        );

        // Wait a bit to ensure Supabase write is committed and visible to all connections
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Signal completion to waiting worker via Redis (best effort only).
        try {
          const completionKey = `job:${payload.jobId}:completed`;
          await this.redis.setex(
            completionKey,
            300, // Expire after 5 minutes
            JSON.stringify({
              status: 'success',
              contentId: content.id,
              timestamp: new Date().toISOString(),
            }),
          );
          this.logger.log(
            `🔔 Redis completion signal set for job ${payload.jobId}`,
          );
        } catch (redisErr) {
          this.logger.warn(
            `Redis completion signal failed for job ${payload.jobId}: ${(redisErr as Error).message}`,
          );
        }

        return {
          success: true,
          message: 'Content saved successfully',
          contentId: content.id,
        };
      } else {
        await this.generationJobRepository.updateError(
          payload.jobId,
          payload.error || 'Unknown error from n8n',
          job.retryCount + 1,
        );

        this.logger.error(`❌ Job ${payload.jobId} failed: ${payload.error}`);

        // Signal failure to waiting worker via Redis
        const completionKey = `job:${payload.jobId}:completed`;
        await this.redis.setex(
          completionKey,
          300, // Expire after 5 minutes
          JSON.stringify({
            status: 'failed',
            error: payload.error || 'Unknown error from n8n',
            timestamp: new Date().toISOString(),
          }),
        );
        this.logger.log(`🔔 Redis failure signal set for job ${payload.jobId}`);

        return {
          success: false,
          message: 'Generation failed',
          error: payload.error,
        };
      }
    } catch (error) {
      this.logger.error(
        `Error processing n8n callback: ${(error as Error).message}`,
        (error as Error).stack,
      );
      // Ensure jobs don't stay stuck in generating when callback handling crashes.
      try {
        const raw = Array.isArray(body) && body.length > 0 ? (body[0] as any) : (body as any);
        const rawJobId =
          raw && typeof raw === 'object' && typeof raw.jobId === 'string'
            ? String(raw.jobId).trim()
            : '';
        if (rawJobId) {
          const job = await this.generationJobRepository.findById(rawJobId);
          if (job && job.status !== JobStatus.FAILED && job.status !== JobStatus.READY) {
            await this.generationJobRepository.updateError(
              rawJobId,
              `n8n callback processing error: ${(error as Error).message}`,
              (job.retryCount || 0) + 1,
            );
            const completionKey = `job:${rawJobId}:completed`;
            await this.redis.setex(
              completionKey,
              300,
              JSON.stringify({
                status: 'failed',
                error: `n8n callback processing error: ${(error as Error).message}`,
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }
      } catch (secondaryError) {
        this.logger.error(
          `Failed to mark callback-crashed job failed: ${(secondaryError as Error).message}`,
        );
      }
      return {
        success: false,
        message: 'Internal error processing callback',
      };
    }
  }

  private assertIntentContract(content: N8nGeneratedContentDto): void {
    if (content.postType === MediaPostType.SINGLE && !content.imagePrompt) {
      throw new Error(
        'Invalid n8n intent: single postType requires imagePrompt',
      );
    }
    if (content.postType === MediaPostType.CAROUSEL) {
      if (!content.slides || content.slides.length < 2) {
        throw new Error(
          'Invalid n8n intent: carousel postType requires slides[]',
        );
      }
    }
  }
}
