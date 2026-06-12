const DEFAULT_RETURN_PATH = '/settings';

/**
 * Validates a post-OAuth redirect path to prevent open redirects.
 * Only same-origin relative paths are allowed.
 */
export function sanitizeReturnTo(
  returnTo: unknown,
  defaultPath = DEFAULT_RETURN_PATH,
): string {
  if (typeof returnTo !== 'string') {
    return defaultPath;
  }

  const trimmed = returnTo.trim();
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('://')
  ) {
    return defaultPath;
  }

  return trimmed;
}

export function buildFrontendOAuthRedirect(
  frontendUrl: string,
  returnTo: unknown,
  query: Record<string, string>,
  defaultPath = DEFAULT_RETURN_PATH,
): string {
  const path = sanitizeReturnTo(returnTo, defaultPath);
  const qs = new URLSearchParams(query).toString();
  return `${frontendUrl}${path}${qs ? `?${qs}` : ''}`;
}
