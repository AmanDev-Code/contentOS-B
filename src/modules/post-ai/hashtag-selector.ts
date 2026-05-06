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

const PLATFORM_EVERGREEN: Record<string, string[]> = {
  linkedin: [
    '#professionaldevelopment',
    '#learning',
    '#skills',
    '#careergrowth',
    '#technology',
  ],
  instagram: ['#instagood', '#photooftheday', '#reels', '#explore', '#viral'],
  x: ['#tech', '#ai', '#trending', '#news', '#thread'],
};

/**
 * Deterministic hashtag selector.
 * Picks from the trending pool + admin-curated tags — never invents hashtags.
 */
export async function selectHashtags(
  keywords: string[],
  platform: string,
  trendingHashtagService: TrendingHashtagEngineService,
  trendingTagsService: TrendingTagsService,
): Promise<string[]> {
  const normalizedKeywords = keywords.map((k) => k.toLowerCase().trim());

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
      const tag = t.tag.startsWith('#') ? t.tag : `#${t.tag}`;
      return { hashtag: tag, priority: t.priority };
    })
    .sort((a, b) => b.priority - a.priority);

  const scored: Array<{ hashtag: string; matchScore: number }> = [];
  for (const row of pool) {
    if (platform === 'linkedin' && LINKEDIN_LOW_SIGNAL_RE.test(row.hashtag)) {
      continue;
    }
    const tag = row.hashtag.replace(/^#/, '').toLowerCase();
    let matchScore = 0;
    for (const kw of normalizedKeywords) {
      if (tag.includes(kw) || kw.includes(tag)) {
        matchScore += 2;
      } else {
        const kwParts = kw.split(/[\s-_]+/);
        for (const part of kwParts) {
          if (part.length >= 3 && tag.includes(part)) {
            matchScore += 1;
          }
        }
      }
    }
    if (matchScore > 0) {
      scored.push({ hashtag: row.hashtag, matchScore });
    }
  }
  scored.sort((a, b) => b.matchScore - a.matchScore);

  const selected = new Set<string>();

  const topMatched = scored.slice(0, 5);
  for (const item of topMatched) {
    selected.add(item.hashtag);
  }

  const adminSlots = Math.min(2, highPriorityAdmin.length);
  for (let i = 0; i < adminSlots; i++) {
    selected.add(highPriorityAdmin[i].hashtag);
  }

  const evergreen = PLATFORM_EVERGREEN[platform] || [];
  let evergreenAdded = 0;
  for (const tag of evergreen) {
    if (evergreenAdded >= 2) break;
    if (!selected.has(tag)) {
      selected.add(tag);
      evergreenAdded++;
    }
  }

  const result = Array.from(selected).slice(0, 8);

  if (result.length < 4 && pool.length > 0) {
    for (const row of pool) {
      if (result.length >= 4) break;
      if (
        platform === 'linkedin' &&
        LINKEDIN_LOW_SIGNAL_RE.test(row.hashtag)
      ) {
        continue;
      }
      if (!selected.has(row.hashtag)) {
        result.push(row.hashtag);
        selected.add(row.hashtag);
      }
    }
  }

  return result;
}
