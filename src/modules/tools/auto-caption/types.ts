/**
 * Auto Caption Generator — Types & Interfaces
 *
 * Lightweight contracts for the transcription pipeline.
 * Designed for speed: minimal abstractions, direct data flow.
 */

// ─── Transcription ──────────────────────────────────────────────────────────

export interface WordTiming {
  word: string;
  start: number; // seconds
  end: number; // seconds
  probability: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: WordTiming[];
}

export interface TranscriptResult {
  success: boolean;
  audioHash: string;
  language: string;
  languageProbability: number;
  durationSeconds: number;
  transcriptionMs: number;
  segments: TranscriptSegment[];
  words: WordTiming[];
  fullText: string;
}

// ─── Caption Styles ─────────────────────────────────────────────────────────

export type CaptionStyleId =
  | 'hormozi'
  | 'mrbeast'
  | 'minimal'
  | 'karaoke'
  | 'typewriter'
  | 'gradient-pop';

export interface CaptionStyleConfig {
  id: CaptionStyleId;
  name: string;
  fontFamily: string;
  fontSize: number; // ASS font size
  primaryColor: string; // ASS color format (&HBBGGRR&)
  highlightColor: string;
  outlineColor: string;
  outlineWidth: number;
  position: 'top' | 'center' | 'bottom';
  bold: boolean;
  uppercase: boolean;
  maxWordsPerLine: number;
  /** Word-by-word highlight animation */
  wordHighlight: boolean;
}

export interface CaptionCustomization {
  fontFamily?: string;
  primaryColor?: string; // hex (#FFFFFF)
  highlightColor?: string; // hex
  position?: 'top' | 'center' | 'bottom';
  fontSize?: 'small' | 'medium' | 'large';
  maxWordsPerLine?: number;
  background?: 'none' | 'shadow' | 'box' | 'blur';
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

export type PipelineStage =
  | 'queued'
  | 'uploading'
  | 'probing'
  | 'extracting-audio'
  | 'transcribing'
  | 'rendering'
  | 'complete'
  | 'failed';

export interface PipelineProgress {
  jobId: string;
  stage: PipelineStage;
  progress: number; // 0-100
  message?: string;
  error?: string;
}

export interface PipelineResult {
  jobId: string;
  success: boolean;
  outputPath?: string; // MinIO path
  outputUrl?: string; // presigned download URL
  srtContent?: string; // SRT subtitle text
  vttContent?: string; // WebVTT subtitle text
  transcript?: TranscriptResult;
  durationMs?: number;
  error?: string;
}

// ─── Job Data ───────────────────────────────────────────────────────────────

export interface AutoCaptionJobData {
  jobId: string;
  inputPath: string; // MinIO path to uploaded video
  inputHash: string; // SHA256 of uploaded file
  styleId: CaptionStyleId;
  customization?: CaptionCustomization;
  language?: string; // ISO 639-1 or null for auto-detect
  ip: string; // for rate-limit tracking
  createdAt: string;
  /** User-controlled font size override (12-36) */
  fontSize?: number;
  /** Pixels from bottom, mapped from user's Y position (0-200) */
  marginV?: number;
  /** ASS alignment: 1=bottom-left, 2=bottom-center, 3=bottom-right */
  alignment?: 1 | 2 | 3;
}

// ─── Transcription Engine ───────────────────────────────────────────────────

export interface TranscriptionEngine {
  /** Unique engine identifier */
  readonly name: string;

  /** Priority (lower = tried first) */
  readonly priority: number;

  /** Cost per minute of audio in USD (0 for self-hosted) */
  readonly costPerMinute: number;

  /** Check if engine can handle this audio */
  supports(mimeType: string, durationSec: number): boolean;

  /** Check if engine is healthy right now */
  isHealthy(): Promise<boolean>;

  /** Transcribe audio file, return word-level result */
  transcribe(audioPath: string, language?: string): Promise<TranscriptResult>;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface AutoCaptionConfig {
  /** Max video duration in seconds */
  maxDurationSec: number;
  /** Max file size in bytes */
  maxSizeBytes: number;
  /** Max videos per IP per day */
  maxVideosPerIpPerDay: number;
  /** Max total minutes of video per IP per day */
  maxMinutesPerIpPerDay: number;
  /** Result TTL in seconds (files auto-deleted after this) */
  resultTtlSec: number;
  /** MinIO bucket for caption tool */
  bucket: string;
  /** Transcription sidecar URL */
  sidecarUrl: string;
  /** ElevenLabs API key (optional) */
  elevenLabsApiKey?: string;
  /** OpenAI API key (optional, last resort) */
  openaiApiKey?: string;
}
