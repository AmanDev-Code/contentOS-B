export type PolarBillingReturnParam = 'success' | 'portal_return' | 'cancel';

/**
 * Build an absolute billing return URL from FRONTEND_URL.
 * Ignores client-supplied URLs unless they share the same origin (avoids localhost redirects in prod).
 */
export function resolvePolarBillingReturnUrl(
  frontendUrl: string | undefined,
  polarParam: PolarBillingReturnParam,
  candidate?: string | null,
): string {
  const base = (frontendUrl || 'http://localhost:3000').replace(/\/$/, '');
  const canonical = `${base}/billing?polar=${polarParam}`;

  const trimmed = candidate?.trim();
  if (!trimmed) {
    return canonical;
  }

  try {
    const parsed = new URL(trimmed);
    const expected = new URL(base);
    if (parsed.origin === expected.origin) {
      return trimmed;
    }
  } catch {
    /* use canonical */
  }

  return canonical;
}
