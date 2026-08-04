/**
 * AutoCaptionService — Main orchestrator for the caption pipeline.
 *
 * Chains: validate → dedup check → queue job → track progress.
 * The actual processing happens in the BullMQ worker.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';

import { CacheService } from '../../../../services/cache.service';
import { CaptionUploadService } from './caption-upload.service';
import {
  AutoCaptionJobData,
  CaptionStyleId,
  CaptionCustomization,
  PipelineProgress,
  PipelineResult,
} from '../types';
import { loadAutoCaptionConfig, CAPTION_QUEUE, CAPTION_REDIS } from '../config';

@Injectable()
export class AutoCaptionService {
  private readonly logger = new Logger(AutoCaptionService.name);

  constructor(
    @InjectQueue(CAPTION_QUEUE) private readonly captionQueue: Queue,
    private readonly cache: CacheService,
    private readonly uploadService: CaptionUploadService,
  ) {}

  /**
   * Check IP rate limits (2 videos/day + 5 min total).
   * Returns { allowed, reason } — caller returns 429 if not allowed.
   */
  async checkIpLimits(ip: string): Promise<{ allowed: boolean; reason?: string }> {
    const config = loadAutoCaptionConfig();

    // Dev/admin bypass: skip rate limits in development or for whitelisted IPs
    const isDev = process.env.NODE_ENV !== 'production';
    if (isDev) {
      return { allowed: true };
    }

    // Check daily video count
    const countKey = `${CAPTION_REDIS.IP_COUNT}:${ip}`;
    const count = await this.cache.get(countKey);
    if (count && Number(count) >= config.maxVideosPerIpPerDay) {
      return { allowed: false, reason: `Daily limit reached (${config.maxVideosPerIpPerDay} videos/day). Try again tomorrow.` };
    }

    // Check daily minutes
    const minutesKey = `${CAPTION_REDIS.IP_MINUTES}:${ip}`;
    const minutes = await this.cache.get(minutesKey);
    if (minutes && Number(minutes) >= config.maxMinutesPerIpPerDay) {
      return { allowed: false, reason: `Daily processing limit reached (${config.maxMinutesPerIpPerDay} min/day). Try again tomorrow.` };
    }

    return { allowed: true };
  }

  /**
   * Increment IP counters after successful job submission.
   */
  async incrementIpCounters(ip: string, durationSec: number): Promise<void> {
    const countKey = `${CAPTION_REDIS.IP_COUNT}:${ip}`;
    const minutesKey = `${CAPTION_REDIS.IP_MINUTES}:${ip}`;
    const ttl = 86400; // 24h

    const currentCount = (await this.cache.get(countKey)) || 0;
    await this.cache.set(countKey, Number(currentCount) + 1, ttl);

    const currentMinutes = (await this.cache.get(minutesKey)) || 0;
    await this.cache.set(minutesKey, Number(currentMinutes) + Math.ceil(durationSec / 60), ttl);
  }

  /**
   * Check dedup: has this exact video+style been processed before?
   */
  async checkDedup(inputHash: string, styleId: CaptionStyleId, customization?: CaptionCustomization): Promise<string | null> {
    const styleKey = this.buildStyleKey(styleId, customization);
    return this.uploadService.getDedupResult(inputHash, styleKey);
  }

  /**
   * Submit a caption job to the queue.
   */
  async submitJob(params: {
    inputPath: string;
    inputHash: string;
    styleId: CaptionStyleId;
    customization?: CaptionCustomization;
    language?: string;
    ip: string;
    fontSize?: number;
    marginV?: number;
    alignment?: 1 | 2 | 3;
  }): Promise<string> {
    const jobId = this.buildJobId(params.inputHash, params.styleId, params.customization);

    const jobData: AutoCaptionJobData = {
      jobId,
      inputPath: params.inputPath,
      inputHash: params.inputHash,
      styleId: params.styleId,
      customization: params.customization,
      language: params.language,
      ip: params.ip,
      createdAt: new Date().toISOString(),
      fontSize: params.fontSize,
      marginV: params.marginV,
      alignment: params.alignment,
    };

    await this.captionQueue.add('process', jobData, {
      jobId, // idempotent: same jobId = same job, won't duplicate
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600 }, // keep for 1h
      removeOnFail: { age: 7200 }, // keep failures for 2h
    } as any);

    // Set initial progress
    await this.setProgress(jobId, { jobId, stage: 'queued', progress: 0 });

    return jobId;
  }

  /**
   * Get current job progress.
   */
  async getProgress(jobId: string): Promise<PipelineProgress | null> {
    const key = `${CAPTION_REDIS.PROGRESS}:${jobId}`;
    return this.cache.get(key);
  }

  /**
   * Set job progress (called by the worker).
   */
  async setProgress(jobId: string, progress: PipelineProgress): Promise<void> {
    const key = `${CAPTION_REDIS.PROGRESS}:${jobId}`;
    await this.cache.set(key, progress, 7200); // 2h TTL
  }

  /**
   * Get completed job result.
   */
  async getResult(jobId: string): Promise<PipelineResult | null> {
    const key = `${CAPTION_REDIS.PROGRESS}:${jobId}:result`;
    return this.cache.get(key);
  }

  /**
   * Store completed job result (called by the worker).
   */
  async setResult(jobId: string, result: PipelineResult): Promise<void> {
    const key = `${CAPTION_REDIS.PROGRESS}:${jobId}:result`;
    const config = loadAutoCaptionConfig();
    await this.cache.set(key, result, config.resultTtlSec);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private buildJobId(inputHash: string, styleId: CaptionStyleId, customization?: CaptionCustomization): string {
    const payload = `${inputHash}:${styleId}:${JSON.stringify(customization || {})}`;
    return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
  }

  private buildStyleKey(styleId: CaptionStyleId, customization?: CaptionCustomization): string {
    return `${styleId}:${JSON.stringify(customization || {})}`;
  }
}
