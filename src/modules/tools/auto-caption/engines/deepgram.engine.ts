/**
 * DeepgramEngine — Primary transcription engine (P0).
 *
 * Cheapest ($0.0043/min), fastest (sub-200ms latency), excellent accuracy.
 * Uses Deepgram Nova-3 with word-level timestamps.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { TranscriptionEngine, TranscriptResult, WordTiming } from '../types';

@Injectable()
export class DeepgramEngine implements TranscriptionEngine {
  private readonly logger = new Logger(DeepgramEngine.name);
  private readonly apiKey: string | undefined;

  readonly name = 'deepgram-nova3';
  readonly priority = 1; // P1 — cheapest per-minute, second in line
  readonly costPerMinute = 0.0043;

  constructor() {
    this.apiKey = process.env.DEEPGRAM_API_KEY || undefined;
  }

  supports(_mimeType: string, durationSec: number): boolean {
    return durationSec <= 180 && !!this.apiKey;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch('https://api.deepgram.com/v1/projects', {
        headers: { Authorization: `Token ${this.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  async transcribe(audioPath: string, language?: string): Promise<TranscriptResult> {
    if (!this.apiKey) throw new Error('Deepgram API key not configured');

    const fileBuffer = await fs.promises.readFile(audioPath);

    // Build URL with query params
    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'true',
      punctuate: 'true',
      utterances: 'false',
      // Word-level timestamps
      words: 'true',
    });
    if (language) params.set('language', language);
    else params.set('detect_language', 'true');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);

    try {
      const startMs = Date.now();
      const res = await fetch(
        `https://api.deepgram.com/v1/listen?${params.toString()}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${this.apiKey}`,
            'Content-Type': 'audio/wav',
          },
          body: fileBuffer,
          signal: controller.signal,
        },
      );

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        throw new Error(`Deepgram returned ${res.status}: ${text}`);
      }

      const data = await res.json();
      const elapsed = Date.now() - startMs;

      // Extract from Deepgram response structure
      const channel = data.results?.channels?.[0];
      const alternative = channel?.alternatives?.[0];

      if (!alternative) {
        throw new Error('No transcription result from Deepgram');
      }

      // Map Deepgram words to our format
      const words: WordTiming[] = (alternative.words || []).map((w: any) => ({
        word: w.punctuated_word || w.word || '',
        start: w.start ?? 0,
        end: w.end ?? 0,
        probability: w.confidence ?? 0.9,
      }));

      const segments = this.groupWordsIntoSegments(words);
      const detectedLang = data.results?.channels?.[0]?.detected_language || language || 'en';
      const duration = data.metadata?.duration || (words.length > 0 ? words[words.length - 1].end : 0);

      return {
        success: true,
        audioHash: '', // caller sets this
        language: detectedLang,
        languageProbability: 0.95,
        durationSeconds: duration,
        transcriptionMs: elapsed,
        segments,
        words,
        fullText: alternative.transcript || words.map((w) => w.word).join(' '),
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
