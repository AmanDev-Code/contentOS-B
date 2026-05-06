export interface RateLimitRule {
  windowMs: number;
  max: number;
  message?: string;
}

/** Per-authenticated-user limits; keys are URL path prefixes (guard + middleware). */
export const RATE_LIMIT_BY_PATH: Record<string, RateLimitRule> = {
  '/generation/topics': {
    windowMs: 60 * 60 * 1000,
    max: 50,
    message: 'Too many topic generation requests. Please try again later.',
  },
  '/generation/content': {
    windowMs: 60 * 60 * 1000,
    max: 600,
    message: 'Too many content list requests. Please try again later.',
  },
  '/media/generate-image': {
    windowMs: 60 * 60 * 1000,
    max: 100,
    message: 'Too many image generation requests. Please try again later.',
  },
  '/media/generate-carousel': {
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: 'Too many carousel generation requests. Please try again later.',
  },
  '/posts/publish': {
    windowMs: 60 * 60 * 1000,
    max: 50,
    message: 'Too many publishing requests. Please try again later.',
  },
  '/posts/schedule': {
    windowMs: 60 * 60 * 1000,
    max: 100,
    message: 'Too many scheduling requests. Please try again later.',
  },
  '/linkedin/publish': {
    windowMs: 60 * 60 * 1000,
    max: 25,
    message: 'Too many LinkedIn publishing requests. Please try again later.',
  },
  '/linkedin/oauth/start': {
    windowMs: 60 * 60 * 1000,
    max: 40,
    message: 'Too many LinkedIn connect attempts. Please try again later.',
  },
  '/generation/start': {
    windowMs: 60 * 60 * 1000,
    max: 50,
    message: 'Too many content generation requests. Please try again later.',
  },
  '/generation/custom-topic': {
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: 'Too many custom topic requests. Please try again later.',
  },
  '/posts/draft': {
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: 'Too many draft saves. Please try again later.',
  },
  '/media/upload': {
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many file uploads. Please try again later.',
  },
  '/content': {
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: 'Too many content requests. Please try again later.',
  },
};

export function resolveRateLimitEndpoint(
  path: string,
  rules: Record<string, RateLimitRule>,
): string | null {
  const normalizedPath = path.replace(/\/+$/, '');
  if (rules[normalizedPath]) return normalizedPath;
  for (const endpoint of Object.keys(rules)) {
    if (
      normalizedPath === endpoint ||
      normalizedPath.startsWith(endpoint + '/')
    ) {
      return endpoint;
    }
  }
  return null;
}
