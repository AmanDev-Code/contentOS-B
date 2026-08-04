/**
 * FasterWhisperEngine — Primary transcription engine.
 *
 * Calls the Python sidecar via HTTP. Zero cost (self-hosted).
 * Lightweight: single HTTP POST with the audio file as multipart.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

import { TranscriptionEngine, TranscriptResult } from '../types';
import { loadAutoCaptionConfig } from '../config';

@Injectable()
export class FasterWhisperEngine implements TranscriptionEngine {
  private readonly logger = new Logger(FasterWhisperEngine.name);
  private readonly sidecarUrl: string;

  readonly name = 'faster-whisper';
  readonly priority = 4; // P4 — self-hosted, only if sidecar deployed
  readonly costPerMinute = 0; // self-hosted = free

  constructor(private readonly configService: ConfigService) {
    this.sidecarUrl = loadAutoCaptionConfig().sidecarUrl;
  }

  supports(_mimeType: string, durationSec: number): boolean {
    // Handles any audio up to 3 min (generous buffer over 1.5min video limit)
    return durationSec <= 180;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${this.sidecarUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  async transcribe(audioPath: string, language?: string): Promise<TranscriptResult> {
    const url = new URL('/transcribe', this.sidecarUrl);
    if (language) url.searchParams.set('language', language);

    // Read file and build FormData
    const fileBuffer = await fs.promises.readFile(audioPath);
    const filename = path.basename(audioPath);

    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: 'audio/wav' }), filename);

    const controller = new AbortController();
    // 90s timeout for transcription (generous for 1.5min audio on CPU)
    const timeout = setTimeout(() => controller.abort(), 90_000);

    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        throw new Error(`Sidecar returned ${res.status}: ${text}`);
      }

      const data = await res.json();

      if (!data.success) {
        throw new Error(data.detail || 'Transcription failed');
      }

      return {
        success: true,
        audioHash: data.audio_hash,
        language: data.language,
        languageProbability: data.language_probability,
        durationSeconds: data.duration_seconds,
        transcriptionMs: data.transcription_ms,
        segments: data.segments,
        words: data.words,
        fullText: data.full_text,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
