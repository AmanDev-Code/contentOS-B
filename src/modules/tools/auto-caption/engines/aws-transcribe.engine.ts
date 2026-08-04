/**
 * AwsTranscribeEngine — AWS Transcribe (P3).
 *
 * Batch API: uploads audio to S3, kicks off transcription job, polls for result.
 * Slower than real-time APIs (10-30s overhead) but reliable and cheap ($0.006/min).
 * Uses your existing AWS credentials.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { TranscriptionEngine, TranscriptResult, WordTiming } from '../types';

@Injectable()
export class AwsTranscribeEngine implements TranscriptionEngine {
  private readonly logger = new Logger(AwsTranscribeEngine.name);

  readonly name = 'aws-transcribe';
  readonly priority = 3; // P3 — slower (batch), but reliable
  readonly costPerMinute = 0.006;

  private readonly accessKeyId: string | undefined;
  private readonly secretAccessKey: string | undefined;
  private readonly region: string;
  private readonly bucket: string;

  constructor() {
    this.accessKeyId = process.env.AWS_TRANSCRIBE_ACCESS_KEY_ID || undefined;
    this.secretAccessKey = process.env.AWS_TRANSCRIBE_SECRET_ACCESS_KEY || undefined;
    this.region = process.env.AWS_TRANSCRIBE_REGION || 'us-east-1';
    this.bucket = process.env.AWS_TRANSCRIBE_BUCKET || 'trndinn-transcribe-temp';
  }

  supports(_mimeType: string, durationSec: number): boolean {
    return durationSec <= 180 && !!this.accessKeyId && !!this.secretAccessKey;
  }

  async isHealthy(): Promise<boolean> {
    return !!this.accessKeyId && !!this.secretAccessKey;
  }

  async transcribe(audioPath: string, language?: string): Promise<TranscriptResult> {
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error('AWS Transcribe credentials not configured');
    }

    const startMs = Date.now();
    const jobName = `trndinn-caption-${crypto.randomUUID().slice(0, 8)}`;
    const s3Key = `audio/${jobName}.wav`;

    try {
      // Step 1: Upload audio to S3
      const audioBuffer = await fs.promises.readFile(audioPath);
      await this.s3PutObject(s3Key, audioBuffer, 'audio/wav');

      // Step 2: Start transcription job
      await this.startTranscriptionJob(jobName, s3Key, language);

      // Step 3: Poll for completion (max 60s)
      const result = await this.pollForResult(jobName, 60_000);

      // Step 4: Parse result
      const words: WordTiming[] = [];
      const items = result?.results?.items || [];

      for (const item of items) {
        if (item.type === 'pronunciation' && item.alternatives?.[0]) {
          words.push({
            word: item.alternatives[0].content || '',
            start: parseFloat(item.start_time || '0'),
            end: parseFloat(item.end_time || '0'),
            probability: parseFloat(item.alternatives[0].confidence || '0.9'),
          });
        } else if (item.type === 'punctuation' && words.length > 0) {
          // Attach punctuation to previous word
          words[words.length - 1].word += item.alternatives?.[0]?.content || '';
        }
      }

      const segments = this.groupWordsIntoSegments(words);
      const fullText = result?.results?.transcripts?.[0]?.transcript || '';
      const duration = words.length > 0 ? words[words.length - 1].end : 0;

      return {
        success: true,
        audioHash: '',
        language: language || 'en',
        languageProbability: 0.9,
        durationSeconds: duration,
        transcriptionMs: Date.now() - startMs,
        segments,
        words,
        fullText,
      };
    } finally {
      // Cleanup S3 object
      this.s3DeleteObject(s3Key).catch(() => {});
    }
  }

  // ─── AWS API calls (no SDK — direct HTTP with SigV4) ──────────────────

  private async startTranscriptionJob(jobName: string, s3Key: string, language?: string): Promise<void> {
    const body = JSON.stringify({
      TranscriptionJobName: jobName,
      Media: { MediaFileUri: `s3://${this.bucket}/${s3Key}` },
      MediaFormat: 'wav',
      LanguageCode: language || 'en-US',
      Settings: { ShowSpeakerLabels: false },
    });

    const res = await this.awsFetch(
      'transcribe',
      'POST',
      '/',
      { 'X-Amz-Target': 'Transcribe.StartTranscriptionJob', 'Content-Type': 'application/x-amz-json-1.1' },
      body,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AWS Transcribe StartJob failed: ${res.status} ${text}`);
    }
  }

  private async pollForResult(jobName: string, timeoutMs: number): Promise<any> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const body = JSON.stringify({ TranscriptionJobName: jobName });
      const res = await this.awsFetch(
        'transcribe',
        'POST',
        '/',
        { 'X-Amz-Target': 'Transcribe.GetTranscriptionJob', 'Content-Type': 'application/x-amz-json-1.1' },
        body,
      );

      if (!res.ok) throw new Error(`AWS Transcribe GetJob failed: ${res.status}`);

      const data = await res.json();
      const status = data.TranscriptionJob?.TranscriptionJobStatus;

      if (status === 'COMPLETED') {
        // Fetch the transcript from the URI
        const uri = data.TranscriptionJob?.Transcript?.TranscriptFileUri;
        if (!uri) throw new Error('No transcript URI in completed job');
        const transcriptRes = await fetch(uri);
        return transcriptRes.json();
      }

      if (status === 'FAILED') {
        throw new Error(`AWS Transcribe job failed: ${data.TranscriptionJob?.FailureReason || 'unknown'}`);
      }

      // IN_PROGRESS — wait 2s and retry
      await new Promise((r) => setTimeout(r, 2000));
    }

    throw new Error('AWS Transcribe timed out');
  }

  private async s3PutObject(key: string, buffer: Buffer, contentType: string): Promise<void> {
    const res = await this.awsFetch(
      's3',
      'PUT',
      `/${key}`,
      { 'Content-Type': contentType },
      buffer,
      this.bucket,
    );
    if (!res.ok) throw new Error(`S3 PUT failed: ${res.status}`);
  }

  private async s3DeleteObject(key: string): Promise<void> {
    await this.awsFetch('s3', 'DELETE', `/${key}`, {}, undefined, this.bucket);
  }

  // ─── AWS SigV4 signing (minimal, no SDK) ──────────────────────────────

  private async awsFetch(
    service: string,
    method: string,
    path: string,
    extraHeaders: Record<string, string>,
    body?: string | Buffer,
    bucket?: string,
  ): Promise<Response> {
    const host = service === 's3'
      ? `${bucket}.s3.${this.region}.amazonaws.com`
      : `${service}.${this.region}.amazonaws.com`;
    const url = `https://${host}${path}`;

    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const shortDate = dateStamp.slice(0, 8);

    const headers: Record<string, string> = {
      host,
      'x-amz-date': dateStamp,
      ...extraHeaders,
    };

    // Create canonical request
    const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
    const signedHeaderKeys = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k]}\n`).join('');

    const canonicalRequest = [
      method, path, '', canonicalHeaders, signedHeaderKeys, bodyHash,
    ].join('\n');

    // Create string to sign
    const credentialScope = `${shortDate}/${this.region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      dateStamp,
      credentialScope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    // Calculate signature
    const signingKey = this.getSignatureKey(shortDate, service);
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderKeys}, Signature=${signature}`;

    return fetch(url, {
      method,
      headers: { ...headers, Authorization: authorization },
      body: body ? (Buffer.isBuffer(body) ? (body as unknown as BodyInit) : body) : undefined,
    });
  }

  private getSignatureKey(dateStamp: string, service: string): Buffer {
    const kDate = crypto.createHmac('sha256', `AWS4${this.secretAccessKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(this.region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    return crypto.createHmac('sha256', kService).update('aws4_request').digest();
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
