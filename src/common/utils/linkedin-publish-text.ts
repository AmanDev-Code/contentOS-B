/**
 * Plain-text shaping for LinkedIn REST `commentary` (no markdown, no `hashtag#` tokens).
 */

/** LinkedIn Marketing API `commentary` character cap (platform-enforced). */
export const LINKEDIN_MAX_TEXT_LENGTH = 3000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strips common markdown wrappers LinkedIn would show literally. */
export function stripMarkdownForLinkedIn(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function coerceHashtagInput(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      for (const part of item.split(/\s+/)) {
        const p = part.trim();
        if (p) out.push(p);
      }
    }
    return out;
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Normalizes tags from DB / API: `hashtag#AI`, `AI`, `#AI` → `#AI`. */
export function normalizeHashtagToken(tag: string): string {
  let t = String(tag || '').trim();
  t = t.replace(/^hashtag#/i, '#');
  t = t.replace(/^#+/, '#');
  if (!t.startsWith('#')) t = `#${t}`;
  return t;
}

export function normalizeHashtagList(raw: unknown): string[] {
  const tokens = coerceHashtagInput(raw).map(normalizeHashtagToken);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!/^#[a-z0-9_]+$/i.test(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function isHashtagOnlyLine(trimmed: string): boolean {
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  return tokens.every((tok) => /^#[a-z0-9_]+$/i.test(tok));
}

/** Removes trailing blank lines, then lines that are only hashtags (repeat). */
export function stripTrailingHashtagOnlyLines(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    const trimmed = last.trim();
    if (trimmed === '') {
      lines.pop();
      continue;
    }
    if (isHashtagOnlyLine(trimmed)) {
      lines.pop();
      continue;
    }
    break;
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.join('\n').trimEnd();
}

function bodyAlreadyEndsWithHashtagSuffix(body: string, suffix: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const b = norm(body);
  const s = norm(suffix);
  if (!s) return true;
  return b.endsWith(s);
}

/** Drops tags that already appear in the body as `#tag` (case-insensitive). */
export function filterHashtagsAbsentFromBody(
  body: string,
  tags: string[],
): string[] {
  return tags.filter((tag) => {
    const word = tag.replace(/^#+/, '');
    if (!word) return false;
    const re = new RegExp(`#${escapeRegExp(word)}\\b`, 'i');
    return !re.test(body);
  });
}

/**
 * Builds final `commentary`: fixes `hashtag#`, strips markdown, strips trailing tag lines,
 * appends normalized hashtags once (no duplicates vs body or suffix).
 */
export function buildLinkedInCommentary(
  body: unknown,
  hashtagsRaw: unknown,
): string {
  let text = String(body ?? '');
  text = text.replace(/\bhashtag#/gi, '#');
  text = stripMarkdownForLinkedIn(text);
  text = stripTrailingHashtagOnlyLines(text);

  const normalized = normalizeHashtagList(hashtagsRaw);
  const toAppend = filterHashtagsAbsentFromBody(text, normalized);
  const suffix = toAppend.join(' ').trim();

  const trimmed = text.trim();
  if (!suffix) return trimmed;

  if (bodyAlreadyEndsWithHashtagSuffix(trimmed, suffix)) return trimmed;

  return `${trimmed}\n\n${suffix}`.trim();
}

export function linkedInCommentaryLength(
  body: unknown,
  hashtagsRaw: unknown,
): number {
  return buildLinkedInCommentary(body, hashtagsRaw).length;
}

export function formatLinkedInLengthError(length: number): string {
  return `Post exceeds LinkedIn's ${LINKEDIN_MAX_TEXT_LENGTH}-character limit (${length}). Shorten the caption or remove hashtags.`;
}

/** Returns final commentary or throws if over LinkedIn's limit. */
export function assertLinkedInCommentaryWithinLimit(
  body: unknown,
  hashtagsRaw: unknown,
): string {
  const text = buildLinkedInCommentary(body, hashtagsRaw);
  if (text.length > LINKEDIN_MAX_TEXT_LENGTH) {
    throw new Error(formatLinkedInLengthError(text.length));
  }
  return text;
}
