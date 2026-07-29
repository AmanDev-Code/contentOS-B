import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import axios from 'axios';

import {
  DownloadJob,
  DownloadJobResult,
  Platform,
  QUEUES,
} from '../core';
import { EngineOrchestratorService } from '../services/engine-orchestrator.service';

/**
 * Media Download Worker — BullMQ processor for download jobs.
 *
 * Key principle: NEVER hit Instagram directly from an API handler.
 * All extraction requests go through BullMQ → this worker.
 *
 * Responsibilities:
 * - Process download jobs from the queue
 * - Use the Engine Orchestrator for extraction
 * - Download the actual media file
 * - Store in MinIO/R2 (future: currently returns direct URLs)
 * - Report results via callback or job return value
 *
 * Configured with: attempts: 3, exponential backoff.
 */
@Processor(QUEUES.DOWNLOAD)
@Injectable()
export class MediaDownloadWorker extends WorkerHost {
  private readonly logger = new Logger(MediaDownloadWorker.name);

  constructor(
    private readonly orchestrator: EngineOrchestratorService,
  ) {
    super();
  }

  async process(job: Job<DownloadJob>): Promise<DownloadJobResult> {
    const { url, platform, id: jobId } = job.data;

    this.logger.log(
      `Processing download job ${jobId}: ${url} (attempt ${job.attemptsMade + 1}/${job.opts.attempts || 3})`,
    );

    try {
      // Step 1: Extract media URLs using the engine orchestrator
      const extraction = await this.orchestrator.extract(url, platform);

      if (!extraction.success || extraction.items.length === 0) {
        const result: DownloadJobResult = {
          jobId,
          success: false,
          extraction,
          error: extraction.error || {
            code: 'NO_MEDIA',
            message: 'Extraction returned no media items',
            retryable: true,
          },
          completedAt: new Date().toISOString(),
        };

        // If not retryable, don't throw (prevents BullMQ retry)
        if (!extraction.error?.retryable) {
          return result;
        }

        throw new Error(extraction.error?.message || 'Extraction failed');
      }

      // Step 2: Get the best media item (highest quality video, or first item)
      const bestItem = this.selectBestItem(extraction.items);

      // Step 3: Download the media file (if needed for storage)
      // For now, we return the direct URL — MinIO storage is Phase 2
      const result: DownloadJobResult = {
        jobId,
        success: true,
        accessUrl: bestItem.url,
        extraction,
        completedAt: new Date().toISOString(),
      };

      this.logger.log(
        `Download job ${jobId} completed: ${bestItem.type} ${bestItem.quality || ''} via ${extraction.engine}`,
      );

      // Step 4: Fire callback if configured
      if (job.data.callbackUrl) {
        await this.fireCallback(job.data.callbackUrl, result);
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Download job ${jobId} failed: ${message}`);

      // BullMQ will retry if we throw
      throw err;
    }
  }

  /**
   * Select the best media item from extraction results.
   * Prefers: video > image, highest quality first.
   */
  private selectBestItem(items: any[]): any {
    // Prefer videos
    const videos = items.filter((i) => i.type === 'video');
    if (videos.length > 0) {
      // Sort by height (quality) descending
      return videos.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    }

    // Fall back to first image
    return items[0];
  }

  /**
   * Fire a webhook callback with the download result.
   */
  private async fireCallback(
    callbackUrl: string,
    result: DownloadJobResult,
  ): Promise<void> {
    try {
      await axios.post(callbackUrl, result, {
        timeout: 5_000,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Callback to ${callbackUrl} failed: ${message}`);
      // Don't throw — callback failure shouldn't fail the job
    }
  }
}
