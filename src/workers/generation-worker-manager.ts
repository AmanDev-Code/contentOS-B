import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { N8nService } from '../services/n8n.service';
import { GenerationJobRepository } from '../repositories/generation-job.repository';
import { GeneratedContentRepository } from '../repositories/generated-content.repository';
import { QUEUE_NAMES, JOB_STAGES } from '../common/constants';
import { JobStatus } from '../common/types';

@Injectable()
export class GenerationWorkerManager implements OnModuleInit {
  private readonly logger = new Logger(GenerationWorkerManager.name);
  private workers: Map<string, Worker> = new Map();
  private activeUsers: Set<string> = new Set();
  private redis: Redis;

  constructor(
    private configService: ConfigService,
    private n8nService: N8nService,
    private generationJobRepository: GenerationJobRepository,
    private generatedContentRepository: GeneratedContentRepository,
  ) {
    // Create Redis client for job completion signaling
    this.redis = new Redis({
      host: this.configService.get<string>('redis.host') || 'localhost',
      port: parseInt(
        this.configService.get<string>('redis.port') || '6380',
        10,
      ),
      password: this.configService.get<string>('redis.password') || undefined,
    });
  }

  async onModuleInit() {
    this.logger.log('Generation Worker Manager initialized');
    // Workers will be created dynamically when users create jobs
  }

  /**
   * Get or create a worker for a specific user
   */
  getWorkerForUser(userId: string): Worker {
    if (!this.workers.has(userId)) {
      const queueName = `${QUEUE_NAMES.CONTENT_GENERATION}-${userId}`;

      const worker = new Worker(
        queueName,
        async (job: Job) => this.processJob(job),
        {
          connection: {
            host: this.configService.get<string>('redis.host') || 'localhost',
            port: parseInt(
              this.configService.get<string>('redis.port') || '6380',
              10,
            ),
            password:
              this.configService.get<string>('redis.password') || undefined,
          },
          concurrency: 1, // One job at a time per user
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
   * Process a job (same logic as before, but per-user)
   */
  private async processJob(job: Job): Promise<any> {
    const { jobId, userId, preferences } = job.data;

    this.logger.log(`Processing generation job ${jobId} for user ${userId}`);

    try {
      await this.generationJobRepository.updateStatus(
        jobId,
        JobStatus.GENERATING,
        10,
        JOB_STAGES.TOPIC_DISCOVERY,
      );

      // Build callback URL for n8n to call when job completes
      const baseUrl =
        this.configService.get<string>('app.baseUrl') ||
        'http://localhost:3000';
      const callbackUrl = `${baseUrl}/webhook/n8n-callback`;

      await this.n8nService.triggerContentGeneration({
        jobId,
        userId,
        callbackUrl,
        preferences,
      });

      await this.generationJobRepository.updateStatus(
        jobId,
        JobStatus.GENERATING,
        30,
        JOB_STAGES.CONTENT_GENERATION,
      );

      this.logger.log(
        `🚀 n8n webhook triggered for job ${jobId}, waiting for completion...`,
      );

      // Wait for n8n to complete by checking Redis completion signal
      // The webhook will set a Redis key when n8n completes
      const maxWaitTime = 120000; // 2 minutes max
      const pollInterval = 1000; // Check every 1 second
      const startTime = Date.now();
      const completionKey = `job:${jobId}:completed`;

      while (Date.now() - startTime < maxWaitTime) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));

        // Check Redis for completion signal
        const completionData = await this.redis.get(completionKey);

        if (completionData) {
          const result = JSON.parse(completionData);
          this.logger.log(`✅ Job ${jobId} completed: ${result.status}`);

          // Clean up the completion signal
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

        this.logger.log(
          `⏳ Waiting for n8n to complete job ${jobId}... (${Math.floor((Date.now() - startTime) / 1000)}s)`,
        );
      }

      // Timeout - n8n didn't respond
      this.logger.error(
        `⏰ Job ${jobId} timed out waiting for n8n (2 minutes)`,
      );
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
}
