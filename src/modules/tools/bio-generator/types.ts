/**
 * Bio Generator types — shared between controller, service, prompt builder.
 */

import type { BioPlatform, BioTone } from './config';

export interface BioGenerateInput {
  /** Free-form user role/summary — "Senior product designer at Figma" */
  role: string;
  /** Optional facts/keywords the user wants included — comma-separated or short list */
  facts?: string;
  /** Optional goal — "get recruiter DMs", "grow inbound leads", "meet co-founders" */
  goal?: string;
  /** Target audience — "recruiters", "customers", "peers", "investors" */
  audience?: string;
  /** Optional length hint — "short", "medium", "long" (defaults to platform-optimal) */
  length?: 'short' | 'medium' | 'long';
  /** Whether emojis are allowed in the output */
  emojis?: boolean;
  /** Selected platforms — bios generated per platform */
  platforms: BioPlatform[];
  /** Tone selector */
  tone: BioTone;
  /** Number of variations per platform (1-4). Defaults to 3. */
  variations?: number;
  /** Personal (first-person) vs brand (we/company-name voice). Defaults to 'personal'. */
  bioType?: 'personal' | 'brand';
  /** Optional focus-area weights the AI biases toward (e.g. ['achievements', 'skills']). */
  focusAreas?: string[];
  /** Optional AI-model preference. Falls back to the gateway's default text chain. */
  modelPreference?: 'fast' | 'balanced' | 'best' | 'creative' | 'reasoning';
}

export interface BioVariation {
  /** The bio text itself */
  text: string;
  /** Character count (Unicode-safe) */
  charCount: number;
  /** Recruiter/discovery keywords found (LinkedIn only) */
  keywordsFound?: string[];
  /** Buzzwords flagged for user attention */
  buzzwordsFound?: string[];
  /** Fits within platform limit? */
  withinLimit: boolean;
}

export interface BioPlatformResult {
  platform: BioPlatform;
  variations: BioVariation[];
  /** Platform character limit for reference */
  limit: number;
  /** Platform soft-fold (visible before truncation) */
  softFold: number;
}

export interface BioGenerateResult {
  /** UUID for referencing this generation */
  generationId: string;
  /** Results keyed by platform */
  results: BioPlatformResult[];
  /** The model that succeeded */
  model: string;
  /** Total generation time (ms) */
  durationMs: number;
}

export interface BioScoreInput {
  /** The bio text to score */
  text: string;
  /** Platform to score against */
  platform: BioPlatform;
  /** Optional goal context so scoring is calibrated */
  goal?: string;
}

export interface BioScoreResult {
  /** Overall score 0-100 (weighted average) */
  overall: number;
  /** Dimensional scores 0-20 each */
  dimensions: {
    hook: number;         // Does the opening grab attention?
    clarity: number;      // Is it clear who the person is + what they do?
    platformFit: number;  // Does it use the platform's affordances?
    impact: number;       // Are there specific outcomes / proof?
    originality: number;  // Does it stand out from templates?
  };
  /** 3 improvement suggestions */
  tips: string[];
}

// ── SSE streaming events ────────────────────────────────────────────────────

/** Fired once at the start with the plan (which platforms are being generated). */
export interface BioStreamStartEvent {
  type: 'start';
  generationId: string;
  platforms: BioPlatform[];
}

/** Fired each time a platform's generation finishes successfully. Emitted in
 *  completion order — the fastest platform's result reaches the client first. */
export interface BioStreamPlatformEvent {
  type: 'platform';
  platform: BioPlatform;
  result: BioPlatformResult;
}

/** Fired when a specific platform fails (non-fatal) or the whole run fails (fatal). */
export interface BioStreamErrorEvent {
  type: 'error';
  platform?: BioPlatform;
  message: string;
  fatal: boolean;
}

/** Fired once at the very end after every platform has settled. */
export interface BioStreamEndEvent {
  type: 'end';
  generationId: string;
  model: string;
  durationMs: number;
  succeeded: number;
  failed: number;
}

export type BioStreamEvent =
  | BioStreamStartEvent
  | BioStreamPlatformEvent
  | BioStreamErrorEvent
  | BioStreamEndEvent;
