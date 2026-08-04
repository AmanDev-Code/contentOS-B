/**
 * GoogleCloudSttEngine — Google Cloud Speech-to-Text (P2).
 *
 * Uses your $2000 GCP credits. Chirp model for best accuracy.
 * Word-level timestamps via enable_word_time_offsets.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { TranscriptionEngine, TranscriptResult, WordTiming } from '../types';

// Google auth token cache
let cachedToken: { token: string; expiresAt: number } | null = null;

@Injectable()
export class GoogleCloudSttEngine implements TranscriptionEngine {
  private readonly logger = new Logger(GoogleCloudSttEngine.name);
  private readonly credentialsPath: string | undefined;
  private credentials: any = null;

  readonly name = 'google-cloud-stt';
  readonly priority = 2; // P2
  readonly costPerMinute = 0.006;

  constructor() {
    this.credentialsPath = process.env.GOOGLE_CLOUD_STT_CREDENTIALS_PATH || undefined;
    if (this.credentialsPath) {
      try {
        // Resolve relative to backend root
        const fullPath = path.isAbsolute(this.credentialsPath)
          ? this.credentialsPath
          : path.resolve(process.cwd(), this.credentialsPath);
        const raw = fs.readFileSync(fullPath, 'utf-8');
        this.credentials = JSON.parse(raw);
      } catch (e: any) {
        this.logger.warn(`Failed to load GCP credentials: ${e.message}`);
      }
    }
  }

  supports(_mimeType: string, durationSec: number): boolean {
    // Sync recognition limit is 60s; for longer, use async (but our max is 90s)
    return durationSec <= 180 && !!this.credentials;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.credentials) return false;
    try {
      const token = await this.getAccessToken();
      return !!token;
    } catch {
      return false;
    }
  }

  async transcribe(audioPath: string, language?: string): Promise<TranscriptResult> {
    if (!this.credentials) throw new Error('Google Cloud credentials not configured');

    const token = await this.getAccessToken();
    const audioBytes = await fs.promises.readFile(audioPath);
    const audioContent = audioBytes.toString('base64');

    const startMs = Date.now();

    // Use v1p1beta1 for enhanced models + word-level timestamps
    const body = {
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: language || 'en-US',
        enableWordTimeOffsets: true,
        enableAutomaticPunctuation: true,
        model: 'latest_long', // best accuracy
        useEnhanced: true,
      },
      audio: { content: audioContent },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);

    try {
      const res = await fetch(
        'https://speech.googleapis.com/v1/speech:recognize',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        throw new Error(`Google STT returned ${res.status}: ${text}`);
      }

      const data = await res.json();
      const elapsed = Date.now() - startMs;

      // Extract words from all results
      const words: WordTiming[] = [];
      const results = data.results || [];

      for (const result of results) {
        const alt = result.alternatives?.[0];
        if (!alt?.words) continue;

        for (const w of alt.words) {
          words.push({
            word: w.word || '',
            start: this.parseDuration(w.startTime),
            end: this.parseDuration(w.endTime),
            probability: alt.confidence || 0.9,
          });
        }
      }

      const segments = this.groupWordsIntoSegments(words);
      const fullText = results
        .map((r: any) => r.alternatives?.[0]?.transcript || '')
        .join(' ')
        .trim();

      const duration = words.length > 0 ? words[words.length - 1].end : 0;

      return {
        success: true,
        audioHash: '',
        language: language || 'en',
        languageProbability: results[0]?.alternatives?.[0]?.confidence || 0.9,
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

  // ─── Auth ─────────────────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
      return cachedToken.token;
    }

    // Generate JWT and exchange for access token
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.credentials.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };

    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signInput = `${headerB64}.${payloadB64}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signInput);
    const signature = sign.sign(this.credentials.private_key, 'base64url');

    const jwt = `${signInput}.${signature}`;

    // Exchange JWT for access token
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!res.ok) {
      throw new Error(`Google token exchange failed: ${res.status}`);
    }

    const tokenData = await res.json();
    cachedToken = {
      token: tokenData.access_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
    };

    return cachedToken.token;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private parseDuration(d: string | { seconds?: string; nanos?: number }): number {
    if (!d) return 0;
    if (typeof d === 'string') {
      // Format: "1.500s"
      return parseFloat(d.replace('s', '')) || 0;
    }
    const seconds = parseInt(d.seconds || '0', 10);
    const nanos = d.nanos || 0;
    return seconds + nanos / 1e9;
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
