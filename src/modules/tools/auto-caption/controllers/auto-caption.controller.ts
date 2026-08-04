/**
 * AutoCaptionController — Lightweight endpoints for the caption pipeline.
 *
 * POST /upload          → upload video file directly (multipart)
 * POST /generate        → submit caption job
 * GET  /status/:jobId   → SSE progress stream
 * GET  /result/:jobId   → download result
 *
 * Flow: Frontend uploads file via multipart → backend stores in MinIO → generate kicks BullMQ job.
 * No presigned URL complexity — direct upload is simpler and more reliable.
 */

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  Res,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { AutoCaptionService } from '../services/auto-caption.service';
import { CaptionUploadService } from '../services/caption-upload.service';
import { FfmpegService } from '../services/ffmpeg.service';
import { loadAutoCaptionConfig } from '../config';
import { CaptionStyleId } from '../types';

interface GenerateBody {
  inputPath: string;
  styleId: CaptionStyleId;
  customization?: Record<string, any>;
  language?: string;
  /** User-controlled font size override (12-36) */
  fontSize?: number;
  /** Pixels from bottom, mapped from user's Y position (0-200) */
  marginV?: number;
  /** ASS alignment: 1=bottom-left, 2=bottom-center, 3=bottom-right */
  alignment?: 1 | 2 | 3;
}

@Controller('api/tools/auto-caption-generator')
export class AutoCaptionController {
  private readonly logger = new Logger(AutoCaptionController.name);

  constructor(
    private readonly captionService: AutoCaptionService,
    private readonly uploadService: CaptionUploadService,
    private readonly ffmpegService: FfmpegService,
  ) {}

  /**
   * POST /api/tools/auto-caption-generator/upload
   * Accepts multipart file upload directly. Stores in MinIO. Returns objectPath.
   * Frontend sends the video file here, gets back the path to use in /generate.
   */
  @Post('upload')
  async upload(@Req() req: FastifyRequest) {
    // With attachFieldsToBody: true, the file is on req.body.file
    const body = req.body as any;
    const fileField = body?.file;

    if (!fileField) {
      throw new HttpException('No file uploaded. Send as multipart with field name "file".', HttpStatus.BAD_REQUEST);
    }

    const mimetype = fileField.mimetype || fileField.type || '';
    const filename = fileField.filename || 'video.mp4';

    // Validate MIME
    const allowed = ['video/mp4', 'video/quicktime', 'video/webm'];
    if (!allowed.includes(mimetype)) {
      throw new HttpException(
        'Unsupported format. Accepted: MP4, MOV, WebM.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Get buffer from multipart field
    const buffer: Buffer = await fileField.toBuffer();
    const config = loadAutoCaptionConfig();

    if (buffer.length > config.maxSizeBytes) {
      throw new HttpException(
        `File too large. Max: ${Math.round(config.maxSizeBytes / 1024 / 1024)} MB.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const ext = (filename).split('.').pop() || 'mp4';
    const id = crypto.randomUUID();
    const objectPath = `caption-input/${id}.${ext}`;

    // Upload to MinIO
    await this.uploadService.uploadBuffer(buffer, objectPath, mimetype);

    return {
      success: true,
      objectPath,
      size: buffer.length,
    };
  }

  /**
   * POST /api/tools/auto-caption-generator/upload-init
   * Legacy endpoint — returns object path for direct MinIO upload.
   * Kept for backward compat but /upload (multipart) is preferred.
   */
  @Post('upload-init')
  async uploadInit(@Body() body: { filename: string; contentType: string }) {
    const { filename, contentType } = body;

    if (!filename || !contentType) {
      throw new HttpException('filename and contentType are required', HttpStatus.BAD_REQUEST);
    }

    const allowed = ['video/mp4', 'video/quicktime', 'video/webm'];
    if (!allowed.includes(contentType)) {
      throw new HttpException(
        'Unsupported format. Accepted: MP4, MOV, WebM.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.uploadService.getPresignedUpload(filename, contentType);
    return { success: true, ...result };
  }

  /**
   * POST /api/tools/auto-caption-generator/generate
   * Validates input, checks limits, submits BullMQ job.
   */
  @Post('generate')
  async generate(@Body() body: GenerateBody, @Req() req: FastifyRequest) {
    const { inputPath, styleId, customization, language, fontSize, marginV, alignment } = body;
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;

    if (!inputPath || !styleId) {
      throw new HttpException('inputPath and styleId are required', HttpStatus.BAD_REQUEST);
    }

    const validStyles: CaptionStyleId[] = ['hormozi', 'mrbeast', 'minimal', 'karaoke', 'typewriter', 'gradient-pop'];
    if (!validStyles.includes(styleId)) {
      throw new HttpException(`Invalid styleId. Valid: ${validStyles.join(', ')}`, HttpStatus.BAD_REQUEST);
    }

    // Validate optional overrides
    if (fontSize != null && (fontSize < 12 || fontSize > 36)) {
      throw new HttpException('fontSize must be between 12 and 36', HttpStatus.BAD_REQUEST);
    }
    if (marginV != null && (marginV < 0 || marginV > 1920)) {
      throw new HttpException('marginV must be between 0 and 1920', HttpStatus.BAD_REQUEST);
    }
    if (alignment != null && ![1, 2, 3].includes(alignment)) {
      throw new HttpException('alignment must be 1 (left), 2 (center), or 3 (right)', HttpStatus.BAD_REQUEST);
    }

    // Check IP limits
    const limits = await this.captionService.checkIpLimits(ip);
    if (!limits.allowed) {
      throw new HttpException(limits.reason || 'Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    const config = loadAutoCaptionConfig();
    const tmpPath = `/tmp/caption-probe-${Date.now()}.mp4`;

    try {
      await this.uploadService.downloadToLocal(inputPath, tmpPath);

      // Probe: check duration + size + audio presence
      const probe = await this.ffmpegService.probe(tmpPath);

      if (probe.durationSec > config.maxDurationSec) {
        throw new HttpException(
          `Video too long (${Math.round(probe.durationSec)}s). Max: ${config.maxDurationSec}s (${(config.maxDurationSec / 60).toFixed(1)} min).`,
          HttpStatus.BAD_REQUEST,
        );
      }

      if (!probe.hasAudio || probe.audioRmsDb < -50) {
        throw new HttpException(
          'No speech detected in this video. The auto-caption tool requires audio with speech.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      // Compute hash for dedup
      const inputHash = await this.uploadService.computeHash(tmpPath);

      // Check dedup cache
      const cached = await this.captionService.checkDedup(inputHash, styleId, customization);
      if (cached) {
        const downloadUrl = await this.uploadService.getDownloadUrl(cached);
        return {
          success: true,
          jobId: null,
          cached: true,
          downloadUrl,
          message: 'Already processed — instant delivery.',
        };
      }

      // Increment IP counters
      await this.captionService.incrementIpCounters(ip, probe.durationSec);

      // Submit job
      const jobId = await this.captionService.submitJob({
        inputPath,
        inputHash,
        styleId,
        customization,
        language,
        ip,
        fontSize,
        marginV,
        alignment,
      });

      return {
        success: true,
        jobId,
        cached: false,
        message: 'Processing started. Poll /status/:jobId for progress.',
      };
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {});
    }
  }

  /**
   * GET /api/tools/auto-caption-generator/status/:jobId
   * Returns current progress of a caption job.
   */
  @Get('status/:jobId')
  async status(@Param('jobId') jobId: string) {
    const progress = await this.captionService.getProgress(jobId);
    if (!progress) {
      return { jobId, stage: 'queued', progress: 0 };
    }
    return progress;
  }

  /**
   * GET /api/tools/auto-caption-generator/result/:jobId
   * Returns download URL for completed job.
   */
  @Get('result/:jobId')
  async result(@Param('jobId') jobId: string) {
    const result = await this.captionService.getResult(jobId);

    if (!result) {
      throw new HttpException('Job not found or still processing', HttpStatus.NOT_FOUND);
    }

    if (!result.success || !result.outputPath) {
      throw new HttpException(result.error || 'Processing failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const downloadUrl = await this.uploadService.getDownloadUrl(result.outputPath);

    return {
      success: true,
      downloadUrl,
      srtContent: result.srtContent || null,
      vttContent: result.vttContent || null,
      durationMs: result.durationMs,
    };
  }

  /**
   * GET /api/tools/auto-caption-generator/frame?path=caption-input/xxx.mp4
   * Extract the first frame of a video as JPEG for thumbnail/preview.
   * Returns binary image/jpeg response.
   */
  @Get('frame')
  async extractFrame(
    @Query('path') objectPath: string,
    @Res() reply: FastifyReply,
  ) {
    if (!objectPath) {
      throw new HttpException('path query parameter is required', HttpStatus.BAD_REQUEST);
    }

    // Basic path validation — only allow caption-input/ prefix
    if (!objectPath.startsWith('caption-input/')) {
      throw new HttpException('Invalid path. Must be a caption-input/ object.', HttpStatus.BAD_REQUEST);
    }

    const id = crypto.randomUUID();
    const tmpVideo = path.join(os.tmpdir(), `frame-video-${id}.mp4`);
    const tmpFrame = path.join(os.tmpdir(), `frame-thumb-${id}.jpg`);

    try {
      // Download video from MinIO to temp file
      await this.uploadService.downloadToLocal(objectPath, tmpVideo);

      // Extract first frame as JPEG
      await this.ffmpegService.extractFrame(tmpVideo, tmpFrame);

      // Read the JPEG into a buffer
      const frameBuffer = await fs.promises.readFile(tmpFrame);

      // Return binary JPEG response
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Content-Length', String(frameBuffer.length));
      reply.header('Cache-Control', 'public, max-age=3600');
      return reply.send(frameBuffer);
    } catch (error: any) {
      this.logger.error(`Frame extraction failed for ${objectPath}`, { error: error.message });
      throw new HttpException(
        'Failed to extract frame from video',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    } finally {
      // Cleanup temp files
      fs.promises.unlink(tmpVideo).catch(() => {});
      fs.promises.unlink(tmpFrame).catch(() => {});
    }
  }
}
