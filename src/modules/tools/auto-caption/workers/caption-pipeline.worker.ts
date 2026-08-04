/**
 * CaptionPipelineWorker — BullMQ processor for caption jobs.
 *
 * Stages: probe → extract-audio → transcribe → render-ASS → burn-subtitles → upload output
 *
 * Lightweight: each stage is a direct function call, no sub-queues.
 * Concurrency: 2 (CPU-bound by ffmpeg encode).
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { CAPTION_QUEUE } from '../config';
import { AutoCaptionJobData, PipelineProgress, PipelineResult, WordTiming } from '../types';
import { AutoCaptionService } from '../services/auto-caption.service';
import { CaptionOrchestratorService } from '../services/caption-orchestrator.service';
import { CaptionUploadService } from '../services/caption-upload.service';
import { AssSubtitleService } from '../services/ass-subtitle.service';
import { FfmpegService } from '../services/ffmpeg.service';

@Processor(CAPTION_QUEUE, { concurrency: 2 })
export class CaptionPipelineWorker extends WorkerHost {
  private readonly logger = new Logger(CaptionPipelineWorker.name);

  constructor(
    private readonly captionService: AutoCaptionService,
    private readonly orchestrator: CaptionOrchestratorService,
    private readonly uploadService: CaptionUploadService,
    private readonly assService: AssSubtitleService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<AutoCaptionJobData>): Promise<PipelineResult> {
    const { jobId, inputPath, inputHash, styleId, customization, language, fontSize, marginV, alignment } = job.data;
    const workDir = path.join(os.tmpdir(), `caption-${jobId}`);

    try {
      // Create temp working directory
      await fs.promises.mkdir(workDir, { recursive: true });

      const videoPath = path.join(workDir, 'input.mp4');
      const audioPath = path.join(workDir, 'audio.wav');
      const assPath = path.join(workDir, 'captions.ass');
      const outputPath = path.join(workDir, 'output.mp4');

      // ─── Stage 1: Download input ─────────────────────────────────────
      await this.updateProgress(jobId, 'probing', 10);
      await this.uploadService.downloadToLocal(inputPath, videoPath);

      // ─── Stage 2: Probe ───────────────────────────────────────────────
      const probe = await this.ffmpegService.probe(videoPath);
      this.logger.log(`[${jobId}] Probe: ${probe.durationSec}s, ${probe.width}x${probe.height}`);

      // ─── Stage 3: Extract audio ───────────────────────────────────────
      await this.updateProgress(jobId, 'extracting-audio', 25);
      await this.ffmpegService.extractAudio(videoPath, audioPath);

      // ─── Stage 4: Transcribe ──────────────────────────────────────────
      await this.updateProgress(jobId, 'transcribing', 40);
      const transcript = await this.orchestrator.transcribe(audioPath, language);
      this.logger.log(`[${jobId}] Transcribed: ${transcript.words.length} words via ${transcript.engine} in ${transcript.transcriptionMs}ms`);

      if (transcript.words.length === 0) {
        throw new Error('No words detected in audio. The video may not contain clear speech.');
      }

      // ─── Stage 5: Generate ASS subtitles ──────────────────────────────
      await this.updateProgress(jobId, 'rendering', 65);
      const assContent = this.assService.generate(
        transcript.words,
        styleId,
        probe.width || 1080,
        probe.height || 1920,
        customization,
        { fontSize, marginV, alignment },
      );
      await fs.promises.writeFile(assPath, assContent, 'utf-8');

      // ─── Stage 6: Burn subtitles into video ───────────────────────────
      await this.updateProgress(jobId, 'rendering', 75);
      await this.ffmpegService.burnSubtitles(videoPath, assPath, outputPath, 1080, {
        styleId,
        fontSize,
        marginV,
        alignment,
      });

      // ─── Stage 7: Upload output ───────────────────────────────────────
      await this.updateProgress(jobId, 'rendering', 90);
      const outputKey = `caption-output/${jobId}.mp4`;
      await this.uploadService.uploadOutput(outputPath, outputKey);

      // Generate SRT content for optional download
      const srtContent = this.generateSrt(transcript.words, 5);

      // Store dedup result
      const styleKey = `${styleId}:${JSON.stringify(customization || {})}`;
      await this.uploadService.setDedupResult(inputHash, styleKey, outputKey);

      // ─── Done ─────────────────────────────────────────────────────────
      const result: PipelineResult = {
        jobId,
        success: true,
        outputPath: outputKey,
        srtContent,
        durationMs: Date.now() - new Date(job.data.createdAt).getTime(),
      };

      await this.captionService.setResult(jobId, result);
      await this.updateProgress(jobId, 'complete', 100);

      this.logger.log(`[${jobId}] Complete in ${result.durationMs}ms`);
      return result;
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown processing error';
      this.logger.error(`[${jobId}] Failed: ${errorMsg}`);

      const result: PipelineResult = {
        jobId,
        success: false,
        error: errorMsg,
      };

      await this.captionService.setResult(jobId, result);
      await this.updateProgress(jobId, 'failed', 0, errorMsg);
      throw err; // let BullMQ handle retry
    } finally {
      // Cleanup temp directory
      fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async updateProgress(
    jobId: string,
    stage: PipelineProgress['stage'],
    progress: number,
    error?: string,
  ): Promise<void> {
    await this.captionService.setProgress(jobId, { jobId, stage, progress, error });
  }

  /**
   * Generate SRT subtitle content from word timings.
   */
  private generateSrt(words: WordTiming[], maxWordsPerLine: number): string {
    const lines: string[] = [];
    let index = 1;

    for (let i = 0; i < words.length; i += maxWordsPerLine) {
      const group = words.slice(i, i + maxWordsPerLine);
      if (group.length === 0) continue;

      const start = this.formatSrtTime(group[0].start);
      const end = this.formatSrtTime(group[group.length - 1].end);
      const text = group.map((w) => w.word).join(' ');

      lines.push(`${index}`);
      lines.push(`${start} --> ${end}`);
      lines.push(text);
      lines.push('');
      index++;
    }

    return lines.join('\n');
  }

  private formatSrtTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }
}
