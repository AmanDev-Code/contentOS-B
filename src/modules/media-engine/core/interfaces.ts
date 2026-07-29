/**
 * Media Engine — Core Interfaces
 *
 * Universal extraction architecture inspired by NeoDLP/instagrapi/Ensta.
 * Platform-agnostic contracts for all media downloaders.
 */

// ─── Platform & Media Types ─────────────────────────────────────────────────

export type Platform = 'instagram' | 'tiktok' | 'youtube' | 'twitter' | 'linkedin';

export type MediaType = 'video' | 'image' | 'audio' | 'carousel' | 'story' | 'reel';

export type SessionHealth = 'healthy' | 'cooldown' | 'dead' | 'checkpoint';

export type EngineType = 'private-api' | 'mobile-api' | 'browser' | 'embed' | 'oembed';

export type CircuitState = 'closed' | 'open' | 'half-open';

// ─── Device Fingerprint ─────────────────────────────────────────────────────

export interface DeviceFingerprint {
  deviceId: string;
  phoneId: string;
  uuid: string;
  advertisingId: string;
  familyDeviceId: string;
  androidId: string;
  androidVersion: string;
  androidRelease: string;
  manufacturer: string;
  model: string;
  appVersion: string;
  versionCode: string;
  userAgent: string;
  createdAt: string;
}

// ─── Cookie & Header ────────────────────────────────────────────────────────

export interface CookieJar {
  /** Account identifier this jar belongs to */
  accountId: string;
  /** Complete cookie map — every cookie, not just session ones */
  cookies: Record<string, string>;
  /** When the jar was last refreshed */
  updatedAt: string;
  /** Domain the cookies belong to */
  domain: string;
}

export interface HeaderProfile {
  /** Must match the device fingerprint exactly */
  'User-Agent': string;
  'X-IG-Device-ID'?: string;
  'X-IG-Android-ID'?: string;
  'X-IG-App-ID'?: string;
  'X-MID'?: string;
  'X-CSRF-Token'?: string;
  /** Any additional platform-specific headers */
  [key: string]: string | undefined;
}

// ─── Session ────────────────────────────────────────────────────────────────

export interface Session {
  accountId: string;
  platform: Platform;
  cookies: CookieJar;
  headers: HeaderProfile;
  device: DeviceFingerprint;
  proxy?: string;
  lastUsed: string;
  health: SessionHealth;
  cooldownUntil?: string;
  failedRequests: number;
  consecutiveFailures: number;
  totalRequests: number;
  createdAt: string;
}

// ─── Extraction Result ──────────────────────────────────────────────────────

export interface MediaItem {
  url: string;
  type: MediaType;
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: string;
  /** Quality label (e.g., '720p', '1080p') */
  quality?: string;
}

export interface ExtractionResult {
  success: boolean;
  platform: Platform;
  sourceUrl: string;
  /** Which engine produced this result */
  engine: EngineType;
  /** Account used for extraction */
  accountId?: string;
  /** Extracted media items (multiple for carousels) */
  items: MediaItem[];
  /** Post metadata */
  metadata?: ExtractionMetadata;
  /** Error info if failed */
  error?: ExtractionError;
  /** Time taken in ms */
  durationMs: number;
  /** Timestamp */
  extractedAt: string;
}

export interface ExtractionMetadata {
  postId?: string;
  shortcode?: string;
  authorUsername?: string;
  authorId?: string;
  caption?: string;
  likeCount?: number;
  commentCount?: number;
  viewCount?: number;
  timestamp?: string;
}

export interface ExtractionError {
  code: string;
  message: string;
  retryable: boolean;
  /** Which engine failed */
  engine?: EngineType;
}

// ─── Extractor Interface (NeoDLP pattern) ───────────────────────────────────

export interface Extractor {
  /** Platform this extractor handles */
  readonly platform: Platform;

  /** Check if this extractor can handle the given URL */
  supports(url: string): boolean;

  /** Extract media metadata and download URLs */
  extract(url: string): Promise<ExtractionResult>;

  /** Download the actual media file to buffer */
  download(url: string): Promise<DownloadResult>;
}

export interface DownloadResult {
  success: boolean;
  buffer?: Buffer;
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  error?: ExtractionError;
}

// ─── Engine Interface ───────────────────────────────────────────────────────

export interface Engine {
  /** Unique engine identifier */
  readonly name: EngineType;

  /** Priority (lower = tried first) */
  readonly priority: number;

  /** Whether this engine is currently available */
  isAvailable(): Promise<boolean>;

  /** Attempt extraction with this engine */
  extract(url: string, session?: Session): Promise<ExtractionResult>;
}

// ─── Engine Orchestrator ────────────────────────────────────────────────────

export interface EngineOrchestrator {
  /** Register an engine */
  registerEngine(engine: Engine): void;

  /** Extract using engines in priority order with fallback */
  extract(url: string): Promise<ExtractionResult>;

  /** Get status of all engines */
  getEngineStatus(): Promise<EngineStatus[]>;
}

export interface EngineStatus {
  name: EngineType;
  available: boolean;
  circuitState: CircuitState;
  successRate: number;
  lastUsed?: string;
}

// ─── Session Pool ───────────────────────────────────────────────────────────

export interface SessionPool {
  /** Get a healthy session for the given platform */
  acquire(platform: Platform): Promise<Session | null>;

  /** Return a session after use (updates lastUsed, health) */
  release(session: Session, outcome: RequestOutcome): Promise<void>;

  /** Get pool stats */
  getStats(platform: Platform): Promise<PoolStats>;
}

export interface RequestOutcome {
  success: boolean;
  statusCode?: number;
  /** Was this a rate limit (429)? */
  rateLimited?: boolean;
  /** Was this a checkpoint/challenge? */
  checkpoint?: boolean;
}

export interface PoolStats {
  total: number;
  healthy: number;
  cooldown: number;
  dead: number;
  checkpoint: number;
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time in ms to keep circuit open before half-open */
  resetTimeout: number;
  /** Number of successes in half-open to close circuit */
  successThreshold: number;
}

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure?: string;
  lastStateChange: string;
}

// ─── Cooldown Manager ───────────────────────────────────────────────────────

export interface CooldownConfig {
  /** Base cooldown in ms after rate limit */
  baseCooldownMs: number;
  /** Max cooldown in ms (exponential backoff cap) */
  maxCooldownMs: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
  /** Min delay between requests per account in ms */
  minRequestIntervalMs: number;
}

// ─── Health Checker ─────────────────────────────────────────────────────────

export interface HealthCheckResult {
  accountId: string;
  healthy: boolean;
  statusCode?: number;
  latencyMs: number;
  checkedAt: string;
  error?: string;
}

// ─── Download Job ───────────────────────────────────────────────────────────

export interface DownloadJob {
  id: string;
  url: string;
  platform: Platform;
  requestedBy: string;
  organizationId: string;
  priority: number;
  createdAt: string;
  /** Optional: preferred engine to try first */
  preferredEngine?: EngineType;
  /** Optional: callback URL for webhook notification */
  callbackUrl?: string;
}

export interface DownloadJobResult {
  jobId: string;
  success: boolean;
  /** MinIO/R2 path where media was stored */
  storagePath?: string;
  /** Public/signed URL to access the file */
  accessUrl?: string;
  extraction?: ExtractionResult;
  error?: ExtractionError;
  completedAt: string;
}
