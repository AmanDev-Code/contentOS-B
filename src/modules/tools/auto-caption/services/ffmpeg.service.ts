/**
 * FfmpegService — Lightweight wrapper around child_process ffmpeg/ffprobe.
 *
 * No heavy npm deps (fluent-ffmpeg adds 2MB+ and abstractions we don't need).
 * Direct execFile with AbortSignal timeouts. Fast, predictable, debuggable.
 */

import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const exec = promisify(execFile);

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  codec: string;
  hasAudio: boolean;
  audioRmsDb: number; // average RMS in dB (< -50 = silence)
  fileSizeBytes: number;
}

export interface BurnOptions {
  styleId: string;
  fontSize?: number; // 12-36, user-controlled
  marginV?: number; // 0-200, pixels from bottom (mapped from user's Y position)
  alignment?: 1 | 2 | 3; // ASS alignment: 1=bottom-left, 2=bottom-center, 3=bottom-right
}

@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  /**
   * Probe video file for metadata + silence detection.
   * Timeout: 10s hard kill.
   */
  async probe(filePath: string): Promise<ProbeResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      // Get format + stream info in one call
      const { stdout } = await exec(
        'ffprobe',
        [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_format',
          '-show_streams',
          filePath,
        ],
        { signal: controller.signal, maxBuffer: 1024 * 1024 },
      );

      const info = JSON.parse(stdout);
      const videoStream = info.streams?.find((s: any) => s.codec_type === 'video');
      const audioStream = info.streams?.find((s: any) => s.codec_type === 'audio');

      const durationSec = parseFloat(info.format?.duration || '0');
      const fileSizeBytes = parseInt(info.format?.size || '0', 10);

      // Quick RMS check for silence detection (only if audio exists)
      let audioRmsDb = -100; // default = silence
      if (audioStream) {
        audioRmsDb = await this.measureRms(filePath, durationSec);
      }

      return {
        durationSec,
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        codec: videoStream?.codec_name || 'unknown',
        hasAudio: !!audioStream,
        audioRmsDb,
        fileSizeBytes,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Extract audio as 16kHz mono WAV (optimal for Whisper).
   * Timeout: 30s hard kill.
   */
  async extractAudio(videoPath: string, outputPath: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      await exec(
        'ffmpeg',
        [
          '-y', '-i', videoPath,
          '-vn',           // no video
          '-ac', '1',      // mono
          '-ar', '16000',  // 16kHz (Whisper optimal)
          '-f', 'wav',
          outputPath,
        ],
        { signal: controller.signal, maxBuffer: 1024 * 1024 },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Extract the first frame of a video as a JPEG for thumbnail/preview use.
   * Timeout: 10s hard kill.
   */
  async extractFrame(videoPath: string, outputPath: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      await exec(
        'ffmpeg',
        [
          '-y', '-i', videoPath,
          '-ss', '0',
          '-frames:v', '1',
          '-q:v', '2',
          '-f', 'image2',
          outputPath,
        ],
        { signal: controller.signal, maxBuffer: 1024 * 1024 },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Burn ASS subtitles into video. Output H.264 + AAC MP4.
   * Timeout: 120s hard kill (encoding is CPU-heavy).
   */
  /**
   * Burn subtitles into video with the selected caption style.
   *
   * Strategy:
   * 1. Try local ffmpeg `subtitles` filter (production Ubuntu)
   * 2. Fallback to Docker `trndinn-ffmpeg` (dev Mac)
   *
   * Style-specific colors, fonts, and sizes are passed via force_style.
   * Optional `options` overrides (fontSize/marginV/alignment) merge on top
   * of the style preset — used when the user customizes position/size in the UI.
   * Timeout: 120s hard kill.
   */
  async burnSubtitles(
    videoPath: string,
    assPath: string,
    outputPath: string,
    maxHeight = 1080,
    options?: BurnOptions,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    // Generate SRT from ASS for the subtitles filter
    const srtPath = assPath.replace(/\.ass$/, '.srt');
    await this.convertAssToSrt(assPath, srtPath);

    // Log SRT content for debugging
    const fsModule = await import('fs');
    const srtContent = await fsModule.promises.readFile(srtPath, 'utf-8');
    const srtLineCount = srtContent.split('\n').filter(l => l.trim()).length;
    this.logger.log(`SRT generated: ${srtLineCount} lines, first 200 chars: ${srtContent.slice(0, 200)}`);

    if (srtLineCount < 3) {
      this.logger.error(`SRT file is empty or malformed! Full content: ${srtContent}`);
      throw new Error('SRT generation failed — no subtitle lines produced from transcript');
    }

    // Get style-specific force_style string, merged with user overrides
    const forceStyle = this.getForceStyle(options?.styleId || 'hormozi', options);

    // Escape the SRT path for ffmpeg subtitles filter (colons, backslashes, single quotes)
    const escapedSrtPath = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

    // Build the vf filter string — NO single quotes around force_style value
    // execFile passes args directly to the process (no shell), so no shell quoting needed
    const vf = `subtitles=${escapedSrtPath}:force_style='${forceStyle}'`;

    this.logger.log(`Burn filter: ${vf.slice(0, 150)}...`);

    try {
      // Try local ffmpeg first (production Ubuntu)
      try {
        await exec(
          'ffmpeg',
          ['-y', '-i', videoPath, '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath],
          { signal: controller.signal, maxBuffer: 2 * 1024 * 1024 },
        );
        return;
      } catch (localErr: any) {
        const stderr = localErr.stderr || '';
        if (!stderr.includes('No such filter') && !stderr.includes('No option name') && !stderr.includes('Cannot load default config')) {
          throw localErr;
        }
        this.logger.warn('Local subtitle burn unavailable — using Docker trndinn-ffmpeg');
      }

      // Fallback: Docker with trndinn-ffmpeg (has fonts + libass)
      // Docker uses the ASS file directly (it has libass) instead of SRT+force_style
      const workDir = this.getParentDir(videoPath);
      const escapedAssPath = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
      const dockerVf = `ass=${escapedAssPath}`;

      this.logger.log(`Docker burn with ASS filter: ${dockerVf}`);

      await exec(
        'docker',
        [
          'run', '--rm',
          '-v', `${workDir}:${workDir}`,
          'trndinn-ffmpeg',
          '-y', '-i', videoPath,
          '-vf', dockerVf,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart',
          outputPath,
        ],
        { signal: controller.signal, maxBuffer: 2 * 1024 * 1024 },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get force_style string for ffmpeg subtitles filter based on caption style.
   * Colors are in ASS format: &HAABBGGRR (alpha, blue, green, red).
   * Font sizes calibrated for 720x1280 vertical video.
   *
   * When `overrides` are provided, they merge on top of the preset values:
   * - fontSize → replaces FontSize
   * - marginV → replaces MarginV
   * - alignment → replaces Alignment
   */
  private getForceStyle(styleId: string, overrides?: Omit<BurnOptions, 'styleId'>): string {
    const styles: Record<string, string> = {
      // Hormozi: White bold, black outline, medium size
      hormozi: 'FontName=DejaVu Sans,FontSize=18,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,Outline=3,Shadow=0,Bold=1,Alignment=2,MarginV=80',
      // MrBeast: Yellow bold, dark red/orange outline, slightly larger
      mrbeast: 'FontName=DejaVu Sans,FontSize=20,PrimaryColour=&H0000FFFF&,OutlineColour=&H00003399&,Outline=4,Shadow=0,Bold=1,Alignment=2,MarginV=80',
      // Minimal: White, very thin outline, smaller, italic
      minimal: 'FontName=DejaVu Sans,FontSize=16,PrimaryColour=&H00FFFFFF&,OutlineColour=&H80000000&,Outline=1,Shadow=1,Bold=0,Italic=1,Alignment=2,MarginV=60',
      // Karaoke: White bold, orange outline
      karaoke: 'FontName=DejaVu Sans,FontSize=18,PrimaryColour=&H00FFFFFF&,OutlineColour=&H000080FF&,Outline=3,Shadow=0,Bold=1,Alignment=2,MarginV=80',
      // Typewriter: Green monospace, thin outline
      typewriter: 'FontName=DejaVu Sans Mono,FontSize=14,PrimaryColour=&H0088FF00&,OutlineColour=&H00000000&,Outline=2,Shadow=0,Bold=0,Alignment=2,MarginV=60',
      // Gradient Pop: Pink/magenta bold, black outline
      'gradient-pop': 'FontName=DejaVu Sans,FontSize=20,PrimaryColour=&H00FF00FF&,OutlineColour=&H00000000&,Outline=3,Shadow=0,Bold=1,Alignment=2,MarginV=80',
    };

    let style = styles[styleId] || styles.hormozi;

    // Merge user overrides on top of the style preset
    if (overrides?.fontSize != null) {
      style = style.replace(/FontSize=\d+/, `FontSize=${overrides.fontSize}`);
    }
    if (overrides?.marginV != null) {
      style = style.replace(/MarginV=\d+/, `MarginV=${overrides.marginV}`);
    }
    if (overrides?.alignment != null) {
      style = style.replace(/Alignment=\d+/, `Alignment=${overrides.alignment}`);
    }

    return style;
  }

  /** Get parent directory of a file path */
  private getParentDir(filePath: string): string {
    return path.dirname(filePath);
  }

  /**
   * Convert ASS subtitle to SRT format (for subtitles filter compatibility).
   */
  private async convertAssToSrt(assPath: string, srtPath: string): Promise<void> {
    const fsModule = await import('fs');
    const content = await fsModule.promises.readFile(assPath, 'utf-8');
    const lines = content.split('\n');
    const srtLines: string[] = [];
    let index = 1;

    for (const line of lines) {
      if (!line.startsWith('Dialogue:')) continue;
      const parts = line.substring('Dialogue:'.length).split(',');
      if (parts.length < 10) continue;

      const start = this.assTimeToSrt(parts[1].trim());
      const end = this.assTimeToSrt(parts[2].trim());
      const text = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').trim();

      if (!text) continue;

      srtLines.push(`${index}`);
      srtLines.push(`${start} --> ${end}`);
      srtLines.push(text);
      srtLines.push('');
      index++;
    }

    await fsModule.promises.writeFile(srtPath, srtLines.join('\n'), 'utf-8');
  }

  /** Convert ASS time (H:MM:SS.CS) to SRT time (HH:MM:SS,mmm) */
  private assTimeToSrt(assTime: string): string {
    const match = assTime.match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
    if (!match) return '00:00:00,000';
    const [, h, m, s, cs] = match;
    return `${h.padStart(2, '0')}:${m}:${s},${(parseInt(cs) * 10).toString().padStart(3, '0')}`;
  }

  /**
   * Measure average RMS of audio track (silence detection).
   * Returns dB value. Below -50 dB = effectively silent.
   */
  private async measureRms(filePath: string, durationSec: number): Promise<number> {
    const controller = new AbortController();
    // Shorter timeout for RMS: 10s max
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      // Sample first 10 seconds max for speed
      const analyzeDuration = Math.min(durationSec, 10);

      const { stderr } = await exec(
        'ffmpeg',
        [
          '-y', '-t', String(analyzeDuration),
          '-i', filePath,
          '-af', 'volumedetect',
          '-f', 'null', '-',
        ],
        { signal: controller.signal, maxBuffer: 1024 * 1024 },
      );

      // Parse mean_volume from stderr
      const match = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
      return match ? parseFloat(match[1]) : -100;
    } catch {
      // If RMS check fails, assume there IS audio (don't block the pipeline)
      return -20;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Escape path for ffmpeg filter (backslash special chars) */
  private escapeFilterPath(p: string): string {
    return p.replace(/([\\':[\]])/g, '\\$1');
  }
}
