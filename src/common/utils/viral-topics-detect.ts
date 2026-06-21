/** Topic-generation jobs: list of ideas, not a LinkedIn post body. */
export function isViralTopicsN8nPayload(
  title: unknown,
  body: unknown,
): boolean {
  const t = String(title || '').toLowerCase();
  const b = String(body || '').toLowerCase();
  return (
    t.includes('viral topic') ||
    b.startsWith('here are current viral topic ideas')
  );
}
