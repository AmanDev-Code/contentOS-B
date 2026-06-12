import { TrendingHashtagEngineService } from '../../services/trending-hashtag-engine.service';
import { TrendingTagsService } from '../../services/trending-tags.service';

interface TrendingHashtagRow {
  hashtag: string;
  score: number;
  usage_count: number;
  source_breakdown?: Record<string, number>;
}

const LINKEDIN_LOW_SIGNAL_RE =
  /reel|fyp|tiktok|officereel|office\s*reel|instagood|photooftheday|explorepage/i;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when',
  'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'about', 'into', 'through', 'during', 'before',
  'after', 'above', 'below', 'up', 'down', 'out', 'off', 'over', 'under',
  'again', 'further', 'then', 'once', 'here', 'there', 'post', 'create', 'write',
  'make', 'generate', 'build', 'linkedin', 'instagram', 'content', 'caption',
]);

function normalizeTag(raw: string): string {
  const inner = raw.trim().replace(/^#+/, '').replace(/\s+/g, '');
  if (!inner) return '';
  return `#${inner.toLowerCase()}`;
}

/** Extract searchable tokens from the topic + LLM keywords for hashtag matching. */
function buildSearchTerms(keywords: string[], topic?: string): string[] {
  const terms = new Set<string>();

  for (const kw of keywords) {
    const k = kw.toLowerCase().trim();
    if (k.length >= 3) terms.add(k);
    for (const part of k.split(/[\s\-_/,]+/)) {
      if (part.length >= 3 && !STOP_WORDS.has(part)) terms.add(part);
    }
  }

  if (topic) {
    const topicLower = topic.toLowerCase();
    for (const part of topicLower.split(/[\s\-_/,]+/)) {
      const clean = part.replace(/[^a-z0-9]/g, '');
      if (clean.length >= 4 && !STOP_WORDS.has(clean)) terms.add(clean);
    }
    // Also keep meaningful multi-word phrases (2+ words, 8+ chars)
    const phrases = topicLower.match(/[a-z0-9][a-z0-9\s\-]{6,}[a-z0-9]/g) || [];
    for (const phrase of phrases) {
      const compact = phrase.replace(/\s+/g, '');
      if (compact.length >= 6) terms.add(compact);
    }
  }

  return Array.from(terms);
}

function scoreTagAgainstTerms(tag: string, terms: string[]): number {
  const normalized = tag.replace(/^#/, '').toLowerCase();
  let matchScore = 0;
  for (const term of terms) {
    if (normalized === term) {
      matchScore += 5;
    } else if (normalized.includes(term) || term.includes(normalized)) {
      matchScore += 3;
    } else {
      for (const part of term.split(/[\s\-_]+/)) {
        if (part.length >= 4 && normalized.includes(part)) {
          matchScore += 1;
        }
      }
    }
  }
  return matchScore;
}

/**
 * Deterministic hashtag selector.
 * Picks from the trending pool + admin-curated tags based on topic/keyword
 * relevance — never falls back to the same fixed evergreen set every time.
 */
export async function selectHashtags(
  keywords: string[],
  platform: string,
  trendingHashtagService: TrendingHashtagEngineService,
  trendingTagsService: TrendingTagsService,
  topic?: string,
): Promise<string[]> {
  const searchTerms = buildSearchTerms(keywords, topic);

  const { items } = await trendingHashtagService.getTrendingPaged(
    undefined,
    200,
    0,
  );
  const pool = (items as TrendingHashtagRow[]).filter((row) => {
    if (!row.hashtag || typeof row.hashtag !== 'string') return false;
    if (platform === 'linkedin' && LINKEDIN_LOW_SIGNAL_RE.test(row.hashtag)) {
      return false;
    }
    return true;
  });

  const adminTags = await trendingTagsService.getActiveTags();
  const highPriorityAdmin = adminTags
    .filter((t) => t.priority >= 5 && t.is_active)
    .map((t) => {
      const tag = normalizeTag(t.tag.startsWith('#') ? t.tag : `#${t.tag}`);
      return { hashtag: tag, priority: t.priority };
    })
    .filter((t) => t.hashtag)
    .sort((a, b) => b.priority - a.priority);

  // Score every pool tag by keyword/topic relevance + trending score.
  const scored: Array<{ hashtag: string; combined: number }> = [];
  for (const row of pool) {
    const tag = normalizeTag(row.hashtag);
    if (!tag) continue;
    const matchScore = scoreTagAgainstTerms(tag, searchTerms);
    const trendingBoost = (row.score || 0) * 0.5;
    const combined = matchScore + trendingBoost;
    if (matchScore > 0 || trendingBoost > 0.3) {
      scored.push({ hashtag: tag, combined });
    }
  }
  scored.sort((a, b) => b.combined - a.combined);

  const selected = new Set<string>();
  const result: string[] = [];

  const add = (tag: string) => {
    const n = normalizeTag(tag);
    if (!n || selected.has(n)) return;
    selected.add(n);
    result.push(n);
  };

  // 1. Top keyword/topic-matched tags from trending pool (primary source).
  const matched = scored.filter((s) => scoreTagAgainstTerms(s.hashtag, searchTerms) > 0);
  for (const item of matched.slice(0, 5)) {
    add(item.hashtag);
  }

  // 2. Relevant admin tags that match the topic.
  for (const admin of highPriorityAdmin) {
    if (result.length >= 6) break;
    if (scoreTagAgainstTerms(admin.hashtag, searchTerms) > 0) {
      add(admin.hashtag);
    }
  }

  // 3. If still short, fill with highest-trending pool tags (varies per refresh).
  if (result.length < 4) {
    const byTrending = [...pool]
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const row of byTrending) {
      if (result.length >= 6) break;
      add(row.hashtag);
    }
  }

  // 4. Last resort: derive compact tags from search terms themselves.
  if (result.length < 3 && searchTerms.length > 0) {
    for (const term of searchTerms) {
      if (result.length >= 5) break;
      if (term.length >= 4 && term.length <= 30) {
        add(`#${term.replace(/\s+/g, '')}`);
      }
    }
  }

  return result.slice(0, 8);
}
