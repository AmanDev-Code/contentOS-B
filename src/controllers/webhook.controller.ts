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

@ApiTags('webhook')
@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);
  private redis: Redis;

  constructor(
    private configService: ConfigService,
    private generationJobRepository: GenerationJobRepository,
    private generatedContentRepository: GeneratedContentRepository,
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
    const provided = Array.isArray(raw) ? raw[0] : raw;
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
      const current = await this.generationJobRepository.findById(payload.jobId);
      if (!current) {
        this.logger.warn(`Progress update ignored: job ${payload.jobId} not found`);
        return { success: false, message: 'Job not found' };
      }
      if (current.status === JobStatus.READY || current.status === JobStatus.FAILED) {
        return {
          success: true,
          message: 'Ignored progress update for terminal job',
        };
      }
      const nextProgress = Math.max(current.progress || 0, payload.progress || 0);
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
      this.logger.error(
        `n8n callback normalize failed: ${(e as Error).message}`,
      );
      return { success: false, message: (e as Error).message };
    }

    this.logger.log(`Received n8n callback for job ${payload.jobId}`);

    try {
      const job = await this.generationJobRepository.findById(payload.jobId);
      if (!job) {
        this.logger.error(`Job ${payload.jobId} not found`);
        return { success: false, message: 'Job not found' };
      }

      if (payload.status === 'success' && payload.content) {
        const c = payload.content as N8nGeneratedContentDto;
        this.assertIntentContract(c);

        const visualType =
          c.postType === MediaPostType.CAROUSEL
            ? VisualType.CAROUSEL
            : c.postType === MediaPostType.SINGLE
              ? VisualType.IMAGE
              : (c.visualType as VisualType) || VisualType.NONE;

        const content = await this.generatedContentRepository.create(
          job.userId,
          c.title,
          c.content,
          {
            jobId: payload.jobId,
            aiScore: c.aiScore,
            visualType,
            visualUrl: c.visualUrl,
            carouselUrls: c.carouselUrls,
            hashtags: c.hashtags,
            aiReasoning: c.aiReasoning,
            performancePrediction: payload.content.performancePrediction,
            status:
              visualType === VisualType.NONE
                ? ContentStatus.READY
                : ContentStatus.MEDIA_GENERATING,
          },
        );

        const jobResponsePayload = {
          title: c.title,
          content: c.content,
          hashtags: c.hashtags,
          postType: c.postType,
          imagePrompt: c.imagePrompt,
          slides: c.slides,
          visualUrl: c.visualUrl,
          carouselUrls: c.carouselUrls,
          aiScore: c.aiScore,
          aiReasoning: c.aiReasoning,
          performancePrediction: payload.content.performancePrediction,
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
