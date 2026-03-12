import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { GenerationJobRepository } from '../repositories/generation-job.repository';
import { GeneratedContentRepository } from '../repositories/generated-content.repository';
import type { N8nCallbackPayload } from '../common/types';
import { JobStatus } from '../common/types';

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
      port: parseInt(this.configService.get<string>('redis.port') || '6380', 10),
      password: this.configService.get<string>('redis.password') || undefined,
    });
  }

  @Post('n8n-progress')
  @ApiOperation({ summary: 'Receive progress updates from n8n workflow' })
  async handleN8nProgress(@Body() payload: { jobId: string; progress: number; stage?: string }) {
    this.logger.log(`Received progress update for job ${payload.jobId}: ${payload.progress}%`);

    try {
      await this.generationJobRepository.updateStatus(
        payload.jobId,
        JobStatus.GENERATING,
        payload.progress,
        payload.stage,
      );

      return {
        success: true,
        message: 'Progress updated successfully',
      };
    } catch (error) {
      this.logger.error(
        `Error updating progress for job ${payload.jobId}: ${error.message}`,
      );
      return {
        success: false,
        message: 'Failed to update progress',
      };
    }
  }

  @Post('n8n-callback')
  @ApiOperation({ summary: 'Receive callback from n8n workflow' })
  async handleN8nCallback(@Body() payload: N8nCallbackPayload) {
    this.logger.log(`Received n8n callback for job ${payload.jobId}`);

    try {
      const job = await this.generationJobRepository.findById(payload.jobId);
      if (!job) {
        this.logger.error(`Job ${payload.jobId} not found`);
        return { success: false, message: 'Job not found' };
      }

      if (payload.status === 'success' && payload.content) {
        const content = await this.generatedContentRepository.create(
          job.userId,
          payload.content.title,
          payload.content.content,
          {
            jobId: payload.jobId,
            aiScore: payload.content.aiScore,
            visualType: payload.content.visualType,
            visualUrl: payload.content.visualUrl,
            carouselUrls: payload.content.carouselUrls,
            hashtags: payload.content.hashtags,
            aiReasoning: payload.content.aiReasoning,
          },
        );

        try {
          await this.generationJobRepository.updateWithContent(
            payload.jobId,
            content.id,
            JobStatus.READY,
            payload.content,
          );
          this.logger.log(
            `✅ Job ${payload.jobId} status updated to READY with content ${content.id}`,
          );
          
          // Wait a bit to ensure Supabase write is committed and visible to all connections
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Signal completion to waiting worker via Redis
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
          this.logger.log(`🔔 Redis completion signal set for job ${payload.jobId}`);
          
        } catch (updateError) {
          this.logger.error(
            `❌ Failed to update job status to READY: ${updateError.message}`,
          );
          throw updateError;
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
        `Error processing n8n callback: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        message: 'Internal error processing callback',
      };
    }
  }
}
