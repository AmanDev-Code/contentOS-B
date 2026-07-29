/**
 * Media Engine — Core Constants
 *
 * Redis key prefixes, queue names, and default configurations.
 */

// ─── Redis Key Prefixes ─────────────────────────────────────────────────────

export const REDIS_KEYS = {
  /** Session storage: session:{platform}:{accountId} */
  SESSION: 'media-engine:session',
  /** Device fingerprint: device:{accountId} */
  DEVICE: 'media-engine:device',
  /** Cookie jar: cookies:{platform}:{accountId} */
  COOKIES: 'media-engine:cookies',
  /** Circuit breaker state: circuit:{engineType} */
  CIRCUIT: 'media-engine:circuit',
  /** Cooldown tracker: cooldown:{accountId} */
  COOLDOWN: 'media-engine:cooldown',
  /** Last request timestamp: last-req:{accountId} */
  LAST_REQUEST: 'media-engine:last-req',
  /** URL cache: url-cache:{sha256(url)} */
  URL_CACHE: 'media-engine:url-cache',
  /** Health check result: health:{accountId} */
  HEALTH: 'media-engine:health',
  /** Pool stats: pool-stats:{platform} */
  POOL_STATS: 'media-engine:pool-stats',
  /** Session lock (for rotation): lock:{accountId} */
  LOCK: 'media-engine:lock',
} as const;

// ─── BullMQ Queue Names ─────────────────────────────────────────────────────

export const QUEUES = {
  /** Main download queue */
  DOWNLOAD: 'media-engine-download',
  /** Health check queue (scheduled) */
  HEALTH_CHECK: 'media-engine-health-check',
  /** Session refresh queue */
  SESSION_REFRESH: 'media-engine-session-refresh',
} as const;

// ─── Default Configurations ─────────────────────────────────────────────────

export const DEFAULT_COOLDOWN_CONFIG = {
  /** 30 seconds base cooldown */
  baseCooldownMs: 30_000,
  /** 15 minutes max cooldown */
  maxCooldownMs: 900_000,
  /** Double on each consecutive failure */
  backoffMultiplier: 2,
  /** Minimum 2 seconds between requests per account */
  minRequestIntervalMs: 2_000,
} as const;

export const DEFAULT_CIRCUIT_BREAKER_CONFIG = {
  /** Open circuit after 5 consecutive failures */
  failureThreshold: 5,
  /** Try again after 60 seconds */
  resetTimeout: 60_000,
  /** Close circuit after 2 successes in half-open */
  successThreshold: 2,
} as const;

export const DEFAULT_SESSION_CONFIG = {
  /** Session TTL in Redis: 7 days */
  sessionTtlSeconds: 7 * 24 * 60 * 60,
  /** Device fingerprint TTL: never expires (365 days as safety) */
  deviceTtlSeconds: 365 * 24 * 60 * 60,
  /** Cookie TTL: 30 days */
  cookieTtlSeconds: 30 * 24 * 60 * 60,
  /** URL cache TTL: 1 hour */
  urlCacheTtlSeconds: 3600,
  /** Lock TTL: 30 seconds */
  lockTtlSeconds: 30,
  /** Max consecutive failures before marking dead */
  maxConsecutiveFailures: 10,
  /** Health check interval: 5 minutes */
  healthCheckIntervalMs: 5 * 60 * 1000,
} as const;

// ─── Instagram-Specific Constants ───────────────────────────────────────────

export const INSTAGRAM = {
  /** Instagram app ID for headers */
  APP_ID: '936619743392459',
  /** Latest app version to mimic */
  APP_VERSION: '332.0.0.38.90',
  /** Version code */
  VERSION_CODE: '595530069',
  /** GraphQL endpoint */
  GRAPHQL_URL: 'https://www.instagram.com/graphql/query',
  /** Private API base */
  PRIVATE_API_URL: 'https://i.instagram.com/api/v1',
  /** Known doc_ids for GraphQL queries */
  DOC_IDS: {
    /** Reel/post media query */
    MEDIA_INFO: '8845758582119845',
    /** User info query */
    USER_INFO: '7862754640456692',
  },
  /** Rate limit thresholds */
  RATE_LIMITS: {
    /** Max requests per minute per account */
    requestsPerMinute: 20,
    /** Max requests per hour per account */
    requestsPerHour: 200,
  },
} as const;
