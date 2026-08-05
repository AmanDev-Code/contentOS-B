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
   * Strategy (in order of preference):
   * 1. ASS direct via `subtitles=<assPath>` (preserves all animations + positioning)
   * 2. SRT fallback with `force_style` if libass is unavailable
   * 3. Docker `trndinn-ffmpeg` with `ass=<assPath>` as last resort
   *
   * Using ASS directly preserves:
   * - Word-by-word highlight animations (Hormozi, Karaoke)
   * - Bounce/scale animations (Gradient Pop)
   * - Typewriter progressive reveal
   * - Correct MarginV positioning from the ASS header
   *
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

    const fsModule = await import('fs');

    // Verify ASS file exists and has content
    const assContent = await fsModule.promises.readFile(assPath, 'utf-8');
    const dialogueCount = assContent.split('\n').filter(l => l.startsWith('Dialogue:')).length;
    this.logger.log(`ASS file: ${dialogueCount} dialogue events, size=${assContent.length} bytes`);

    if (dialogueCount === 0) {
      this.logger.error(`ASS file has no Dialogue events! Header: ${assContent.slice(0, 300)}`);
      throw new Error('ASS generation failed — no dialogue events produced from transcript');
    }

    // Escape the ASS path for ffmpeg subtitles filter (colons, backslashes, single quotes)
    const escapedAssPath = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

    // PRIMARY: Use ASS directly with the `subtitles` filter (libass renders all ASS features)
    // The `subtitles` filter supports ASS natively — no need for force_style overrides.
    // All styling (position, font, colors, animations) comes from the ASS file itself.
    const vfAss = `subtitles=${escapedAssPath}`;

    this.logger.log(`Burn strategy: ASS direct. Filter: ${vfAss}`);
    this.logger.log(`Video: ${videoPath}, Output: ${outputPath}`);

    try {
      // Try #1: Local ffmpeg with ASS direct (subtitles filter supports .ass natively)
      try {
        const { stderr } = await exec(
          'ffmpeg',
          ['-y', '-i', videoPath, '-vf', vfAss, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath],
          { signal: controller.signal, maxBuffer: 4 * 1024 * 1024 },
        );

        if (stderr) {
          const hasSubWarning = stderr.includes('Glyph 0x') || stderr.includes('fontselect') ||
            stderr.includes('Unable to') || stderr.includes('Cannot find') || stderr.includes('subtitle');
          if (hasSubWarning) {
            this.logger.warn(`FFmpeg subtitle warnings: ${stderr.slice(-500)}`);
          } else {
            this.logger.debug(`FFmpeg stderr (last 300): ${stderr.slice(-300)}`);
          }
        }

        // Verify output was created
        const outputStat = await fsModule.promises.stat(outputPath);
        this.logger.log(`Burn complete (ASS direct): output ${(outputStat.size / 1024 / 1024).toFixed(1)}MB`);
        return;
      } catch (assErr: any) {
        const stderr = assErr.stderr || '';
        // Check if the failure is due to missing libass/subtitle filter support
        const isFilterMissing = stderr.includes('No such filter') ||
          stderr.includes('Unrecognized option') ||
          stderr.includes('Cannot load default config') ||
          stderr.includes('Error opening input') ||
          stderr.includes('Option ass not found');

        if (!isFilterMissing) {
          // Real encoding error (not a missing filter issue) — propagate
          throw assErr;
        }

        this.logger.warn(`ASS direct failed (libass likely unavailable): ${stderr.slice(-200)}`);
      }

      // Try #2: SRT fallback with force_style (loses animations but at least shows text)
      this.logger.warn('Falling back to SRT + force_style (animations will be lost)');
      const srtPath = assPath.replace(/\.ass$/, '.srt');
      await this.convertAssToSrt(assPath, srtPath);

      const srtContent = await fsModule.promises.readFile(srtPath, 'utf-8');
      const srtLineCount = srtContent.split('\n').filter(l => l.trim()).length;
      this.logger.log(`SRT fallback: ${srtLineCount} lines`);

      if (srtLineCount < 3) {
        this.logger.error(`SRT file is empty or malformed! Full content: ${srtContent}`);
        throw new Error('SRT generation failed — no subtitle lines produced from transcript');
      }

      const forceStyle = this.getForceStyle(options?.styleId || 'hormozi', options);
      const escapedSrtPath = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
      const vfSrt = `subtitles=${escapedSrtPath}:force_style='${forceStyle}'`;

      try {
        const { stderr } = await exec(
          'ffmpeg',
          ['-y', '-i', videoPath, '-vf', vfSrt, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath],
          { signal: controller.signal, maxBuffer: 4 * 1024 * 1024 },
        );

        if (stderr) {
          this.logger.debug(`FFmpeg SRT fallback stderr (last 300): ${stderr.slice(-300)}`);
        }

        const outputStat = await fsModule.promises.stat(outputPath);
        this.logger.log(`Burn complete (SRT fallback): output ${(outputStat.size / 1024 / 1024).toFixed(1)}MB`);
        return;
      } catch (srtErr: any) {
        const stderr = srtErr.stderr || '';
        if (!stderr.includes('No such filter') && !stderr.includes('No option name') && !stderr.includes('Cannot load default config')) {
          throw srtErr;
        }
        this.logger.warn('Local SRT burn also unavailable — using Docker trndinn-ffmpeg');
      }

      // Try #3: Docker with trndinn-ffmpeg (has fonts + libass, uses ASS directly)
      const workDir = this.getParentDir(videoPath);
      const dockerEscapedAssPath = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
      const dockerVf = `ass=${dockerEscapedAssPath}`;

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

      const outputStat = await fsModule.promises.stat(outputPath);
      this.logger.log(`Burn complete (Docker ASS): output ${(outputStat.size / 1024 / 1024).toFixed(1)}MB`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get force_style string for ffmpeg subtitles filter based on caption style.
   * Colors are in ASS format: &HAABBGGRR (alpha, blue, green, red).
   *
   * IMPORTANT: FontSize in the subtitles filter's force_style is relative to
   * a ~384px height baseline. For 1280px vertical video, multiply by ~3.3x.
   * Base presets use sizes calibrated for 720x1280 vertical video.
   *
   * When `overrides` are provided, they merge on top of the preset values:
   * - fontSize → user's UI value (12-28), scaled to FFmpeg size
   * - marginV → replaces MarginV
   * - alignment → replaces Alignment
   */
  private getForceStyle(styleId: string, overrides?: Omit<BurnOptions, 'styleId'>): string {
    const styles: Record<string, string> = {
      // Hormozi: White bold, black outline — large and punchy
      hormozi: 'FontName=DejaVu Sans,FontSize=56,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,Outline=4,Shadow=0,Bold=1,Alignment=2,MarginV=120',
      // MrBeast: Yellow bold, dark red/orange outline
      mrbeast: 'FontName=DejaVu Sans,FontSize=60,PrimaryColour=&H0000FFFF&,OutlineColour=&H00003399&,Outline=5,Shadow=0,Bold=1,Alignment=2,MarginV=120',
      // Minimal: White, very thin outline, slightly smaller, italic
      minimal: 'FontName=DejaVu Sans,FontSize=48,PrimaryColour=&H00FFFFFF&,OutlineColour=&H80000000&,Outline=2,Shadow=1,Bold=0,Italic=1,Alignment=2,MarginV=100',
      // Karaoke: White bold, orange outline
      karaoke: 'FontName=DejaVu Sans,FontSize=56,PrimaryColour=&H00FFFFFF&,OutlineColour=&H000080FF&,Outline=4,Shadow=0,Bold=1,Alignment=2,MarginV=120',
      // Typewriter: Green monospace, thin outline
      typewriter: 'FontName=DejaVu Sans Mono,FontSize=44,PrimaryColour=&H0088FF00&,OutlineColour=&H00000000&,Outline=3,Shadow=0,Bold=0,Alignment=2,MarginV=100',
      // Gradient Pop: Pink/magenta bold, black outline
      'gradient-pop': 'FontName=DejaVu Sans,FontSize=60,PrimaryColour=&H00FF00FF&,OutlineColour=&H00000000&,Outline=4,Shadow=0,Bold=1,Alignment=2,MarginV=120',
    };

    let style = styles[styleId] || styles.hormozi;

    // Merge user overrides on top of the style preset
    // User fontSize (12-28 from UI slider) is scaled to FFmpeg subtitle size
    // Scale factor: UI value * 3 ≈ visible FFmpeg size for 1280px height video
    if (overrides?.fontSize != null) {
      const scaledSize = Math.round(overrides.fontSize * 3);
      style = style.replace(/FontSize=\d+/, `FontSize=${scaledSize}`);
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
