/**
 * Unified rate limit configuration for Trndinn.
 *
 * All rate limiting is handled by `rate-limiter-flexible` via `RateLimiterService`.
 * Strategies:
 *   - Sliding Window (default): Atomic Lua-based, prevents boundary gaming
 *   - Fixed Window: For API keys (industry-standard hourly resets)
 */

export interface RateLimitConfig {
  /** Max requests (points) allowed in the window */
  points: number;
  /** Window duration in seconds */
  durationSeconds: number;
  /** Seconds to block after limit exceeded (0 = no block, requests drip back) */
  blockDurationSeconds?: number;
  /** If true, reject requests when Redis is down (tools). If false, fail-open (core product). */
  failClosed?: boolean;
  /** Custom error message */
  message?: string;
}

// ---------------------------------------------------------------------------
// CORE PRODUCT — Authenticated user limits (keyed by userId + endpoint)
// ---------------------------------------------------------------------------

export const CORE_LIMITS: Record<string, RateLimitConfig> = {
  'gen-start': {
    points: 50,
    durationSeconds: 3600,
    message: 'Too many content generation requests. Please try again later.',
  },
  'gen-custom': {
    points: 30,
    durationSeconds: 3600,
    message: 'Too many custom topic requests. Please try again later.',
  },
  'gen-topics': {
    points: 50,
    durationSeconds: 3600,
    message: 'Too many topic generation requests. Please try again later.',
  },
  'gen-content': {
    points: 600,
    durationSeconds: 3600,
    message: 'Too many content list requests. Please try again later.',
  },
  'media-image': {
    points: 100,
    durationSeconds: 3600,
    message: 'Too many image generation requests. Please try again later.',
  },
  'media-carousel': {
    points: 20,
    durationSeconds: 3600,
    blockDurationSeconds: 300,
    message: 'Too many carousel generation requests. Please try again later.',
  },
  'media-upload': {
    points: 100,
    durationSeconds: 900, // 15 min
    message: 'Too many file uploads. Please try again later.',
  },
  'posts-publish': {
    points: 50,
    durationSeconds: 3600,
    message: 'Too many publishing requests. Please try again later.',
  },
  'posts-schedule': {
    points: 100,
    durationSeconds: 3600,
    message: 'Too many scheduling requests. Please try again later.',
  },
  'posts-draft': {
    points: 200,
    durationSeconds: 900, // 15 min
    message: 'Too many draft saves. Please try again later.',
  },
  'li-publish': {
    points: 25,
    durationSeconds: 3600,
    blockDurationSeconds: 600,
    message: 'Too many LinkedIn publishing requests. Please try again later.',
  },
  'li-oauth': {
    points: 40,
    durationSeconds: 3600,
    blockDurationSeconds: 300,
    message: 'Too many LinkedIn connect attempts. Please try again later.',
  },
  content: {
    points: 500,
    durationSeconds: 900, // 15 min
    message: 'Too many content requests. Please try again later.',
  },
};

/**
 * Maps URL path prefixes → limiter names from CORE_LIMITS.
 * Used by UserRateLimitGuard to resolve which limiter to apply.
 */
export const PATH_TO_LIMITER: Record<string, string> = {
  '/generation/start': 'gen-start',
  '/generation/custom-topic': 'gen-custom',
  '/generation/topics': 'gen-topics',
  '/generation/content': 'gen-content',
  '/media/generate-image': 'media-image',
  '/media/generate-carousel': 'media-carousel',
  '/media/upload': 'media-upload',
  '/posts/publish': 'posts-publish',
  '/posts/schedule': 'posts-schedule',
  '/posts/draft': 'posts-draft',
  '/linkedin/publish': 'li-publish',
  '/linkedin/oauth/start': 'li-oauth',
  '/content': 'content',
};

// ---------------------------------------------------------------------------
// API KEY — Public API v1 (keyed by API key ID)
// ---------------------------------------------------------------------------

export const API_KEY_LIMITS: Record<string, RateLimitConfig> = {
  default: {
    points: 30,
    durationSeconds: 3600,
    message: 'API rate limit exceeded. Retry after the reset window.',
  },
};

/** Plan-based API key limits (points per hour) */
export const API_KEY_PLAN_LIMITS: Record<string, number> = {
  free: 30,
  starter: 30,
  solo: 30,
  standard: 30,
  pro: 100,
  growth: 100,
  agency: 300,
  enterprise: 300,
};

// ---------------------------------------------------------------------------
// FREE TOOLS — IP-based (no auth required)
// ---------------------------------------------------------------------------

export const TOOL_LIMITS: Record<string, RateLimitConfig> = {
  'text-ai': {
    points: 15,
    durationSeconds: 3600,
    blockDurationSeconds: 1800, // 30 min block on abuse
    failClosed: true,
    message: 'Rate limit reached. Please try again later.',
  },
  utility: {
    points: 60,
    durationSeconds: 3600,
    failClosed: true,
    message: 'Rate limit reached. Please try again later.',
  },
  'file-processing': {
    points: 5,
    durationSeconds: 3600,
    blockDurationSeconds: 3600, // 1 hour block on abuse
    failClosed: true,
    message: 'Rate limit reached. Please try again later.',
  },
  'file-processing-heavy': {
    points: 2,
    durationSeconds: 86400, // 24 hours
    blockDurationSeconds: 86400, // 24 hr block on abuse
    failClosed: true,
    message: 'You have used your 2 free captioned videos for today. Sign up for unlimited processing.',
  },
};

/** Global per-IP limit across ALL tools (prevents distributed abuse) */
export const GLOBAL_TOOL_LIMIT: RateLimitConfig = {
  points: 200,
  durationSeconds: 3600,
  blockDurationSeconds: 3600,
  failClosed: true,
  message: 'Global rate limit reached. Please try again later.',
};

// ---------------------------------------------------------------------------
// Utility: resolve URL path to limiter name
// ---------------------------------------------------------------------------

/**
 * Resolves a request path to its limiter name.
 * Returns null if no limiter is configured for this path.
 */
export function resolvePathToLimiter(path: string): string | null {
  const normalizedPath = path.replace(/\/+$/, '');

  // Exact match first
  if (PATH_TO_LIMITER[normalizedPath]) {
    return PATH_TO_LIMITER[normalizedPath];
  }

  // Prefix match
  for (const [prefix, limiterName] of Object.entries(PATH_TO_LIMITER)) {
    if (normalizedPath === prefix || normalizedPath.startsWith(prefix + '/')) {
      return limiterName;
    }
  }

  return null;
}
