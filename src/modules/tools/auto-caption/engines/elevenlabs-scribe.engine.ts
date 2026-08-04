/**
 * ElevenLabsScribeEngine — Secondary transcription engine.
 *
 * Uses ElevenLabs Speech-to-Text (Scribe) API.
 * Paid but user has credits. Activated when sidecar is down.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { TranscriptionEngine, TranscriptResult, WordTiming } from '../types';
import { loadAutoCaptionConfig } from '../config';

@Injectable()
export class ElevenLabsScribeEngine implements TranscriptionEngine {
  private readonly logger = new Logger(ElevenLabsScribeEngine.name);
  private readonly apiKey: string | undefined;

  readonly name = 'elevenlabs-scribe';
  readonly priority = 0; // P0 — user's primary choice
  readonly costPerMinute = 0.01;

  constructor() {
    this.apiKey = loadAutoCaptionConfig().elevenLabsApiKey;
  }

  supports(_mimeType: string, durationSec: number): boolean {
    return durationSec <= 180 && !!this.apiKey;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': this.apiKey },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  async transcribe(audioPath: string, language?: string): Promise<TranscriptResult> {
    if (!this.apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const fileBuffer = await fs.promises.readFile(audioPath);
    const filename = path.basename(audioPath);

    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: 'audio/wav' }), filename);
    formData.append('model_id', 'scribe_v1');
    if (language) formData.append('language_code', language);
    formData.append('timestamps_granularity', 'word');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);

    try {
      const startMs = Date.now();
      const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey },
        body: formData,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        throw new Error(`ElevenLabs returned ${res.status}: ${text}`);
      }

      const data = await res.json();
      const elapsed = Date.now() - startMs;

      // Transform ElevenLabs response to our TranscriptResult format
      const words: WordTiming[] = (data.words || []).map((w: any) => ({
        word: w.text || w.word || '',
        start: w.start ?? 0,
        end: w.end ?? 0,
        probability: w.confidence ?? 0.9,
      }));

      // Group words into segments by sentence boundaries
      const segments = this.groupWordsIntoSegments(words);
      const fullText = words.map((w) => w.word).join(' ');

      // Estimate duration from last word end
      const duration = words.length > 0 ? words[words.length - 1].end : 0;

      return {
        success: true,
        audioHash: '', // caller sets this
        language: data.language_code || language || 'en',
        languageProbability: 0.95,
        durationSeconds: duration,
        transcriptionMs: elapsed,
        segments,
        words,
        fullText,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private groupWordsIntoSegments(words: WordTiming[]) {
    if (words.length === 0) return [];

    const segments: { start: number; end: number; text: string; words: WordTiming[] }[] = [];
    let current: WordTiming[] = [];

    for (const word of words) {
      current.push(word);
      // Split on sentence-ending punctuation or every 10 words
      if (/[.!?]$/.test(word.word) || current.length >= 10) {
        segments.push({
          start: current[0].start,
          end: current[current.length - 1].end,
          text: current.map((w) => w.word).join(' '),
          words: [...current],
        });
        current = [];
      }
    }

    // Flush remaining
    if (current.length > 0) {
      segments.push({
        start: current[0].start,
        end: current[current.length - 1].end,
        text: current.map((w) => w.word).join(' '),
        words: [...current],
      });
    }

    return segments;
  }
}
