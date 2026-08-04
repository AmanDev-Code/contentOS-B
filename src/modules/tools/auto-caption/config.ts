/**
 * Auto Caption Generator — Configuration
 *
 * All tunables in one place. Reads from env with sensible defaults
 * so the tool works locally without any env setup.
 */

import { AutoCaptionConfig } from './types';

export function loadAutoCaptionConfig(): AutoCaptionConfig {
  return {
    maxDurationSec: int(process.env.AUTO_CAPTION_MAX_DURATION_SEC, 90),
    maxSizeBytes: int(process.env.AUTO_CAPTION_MAX_SIZE_BYTES, 100 * 1024 * 1024),
    maxVideosPerIpPerDay: int(process.env.AUTO_CAPTION_MAX_VIDEOS_PER_DAY, 5),
    maxMinutesPerIpPerDay: int(process.env.AUTO_CAPTION_IP_MINUTES_DAILY_CAP, 10),
    resultTtlSec: int(process.env.AUTO_CAPTION_RESULT_TTL_SEC, 3600),
    bucket: process.env.AUTO_CAPTION_BUCKET || 'trndinn-tools',
    sidecarUrl: process.env.TRANSCRIPTION_SIDECAR_URL || 'http://localhost:8010',
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY || undefined,
  };
}

function int(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/** BullMQ queue name for caption jobs */
export const CAPTION_QUEUE = 'auto-caption-pipeline';

/** Redis key prefixes for auto-caption */
export const CAPTION_REDIS = {
  /** Dedup cache: caption:dedup:{inputHash}:{styleId} → jobId */
  DEDUP: 'caption:dedup',
  /** IP daily video count: caption:ip-count:{ip} */
  IP_COUNT: 'caption:ip-count',
  /** IP daily minutes: caption:ip-minutes:{ip} */
  IP_MINUTES: 'caption:ip-minutes',
  /** Job progress: caption:progress:{jobId} */
  PROGRESS: 'caption:progress',
  /** Circuit breaker: caption:circuit:{engineName} */
  CIRCUIT: 'caption:circuit',
} as const;
