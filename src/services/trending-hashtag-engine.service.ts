import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { CacheService } from './cache.service';
import { AdminTagRecord, TrendingTagsService } from './trending-tags.service';
import { InstagramScraperService } from './scrapers/instagram.scraper';
import { LinkedinScraperService } from './scrapers/linkedin.scraper';
import { TwitterScraperService } from './scrapers/twitter.scraper';

type Source = 'instagram' | 'twitter' | 'linkedin';

interface SourcePost {
  id: string;
  text: string;
  hashtags: string[];
  publishedAt: string;
  permalink?: string;
  /** From scrapers when available */
  contentType?: string;
}

interface SourcePayload {
  source: Source;
  posts: SourcePost[];
  hashtags: string[];
  status: 'ok' | 'not_configured' | 'error';
  detail: string;
  filteredOutCount?: number;
}

type EngineMode = 'playwright' | 'api';

@Injectable()
export class TrendingHashtagEngineService {
  private readonly logger = new Logger(TrendingHashtagEngineService.name);
  private readonly engineMode: EngineMode =
    process.env.TRENDING_ENGINE === 'api' ? 'api' : 'playwright';
  private readonly allowInhouseFallback =
    process.env.TRENDING_ALLOW_INHOUSE_FALLBACK === 'true' ||
    process.env.TRENDING_ALLOW_INHOUSE_FALLBACK === '1';

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
    private readonly tagsService: TrendingTagsService,
    private readonly instagramScraper: InstagramScraperService,
    private readonly twitterScraper: TwitterScraperService,
    private readonly linkedinScraper: LinkedinScraperService,
  ) {}

  private normalizeHashtag(raw: string): string | null {
    const trimmed = raw.trim().toLowerCase().replace(/^#+/, '');
    if (!trimmed) return null;
    if (!/^[a-z0-9][a-z0-9-_]{0,48}$/.test(trimmed)) return null;
    return `#${trimmed}`;
  }

  private extractHashtags(text: string): string[] {
    const matches = text.match(/#([a-zA-Z0-9][a-zA-Z0-9_-]{0,48})/g) || [];
    return matches
      .map((value) => this.normalizeHashtag(value))
      .filter((value): value is string => Boolean(value));
  }

  /** Only IG / X / LI post counts count as “external”; format sub-keys do not. */
  private externalSignalTotal(sb: unknown): number {
    if (!sb || typeof sb !== 'object') return 0;
    const o = sb as Record<string, unknown>;
    return (
      Number(o.instagram || 0) + Number(o.twitter || 0) + Number(o.linkedin || 0)
    );
  }

  private hasExternalSignal(rows: unknown[]): boolean {
    const items = Array.isArray(rows) ? rows : [];
    return items.some((row: any) => this.externalSignalTotal(row?.source_breakdown) > 0);
  }

  /** Merge duplicate hashtag rows (e.g. same tag tracked under multiple admin scope_tag). */
  private mergeTrendingByHashtag(rows: any[]): any[] {
    const map = new Map<string, any>();
    for (const r of rows) {
      const raw = String(r.hashtag || '').trim().toLowerCase();
      const key = raw.startsWith('#') ? raw : `#${raw.replace(/^#/, '')}`;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, {
          ...r,
          hashtag: key,
          usage_count: Number(r.usage_count || 0),
          score: Number(r.score || 0),
          source_breakdown: { ...(r.source_breakdown || {}) },
        });
      } else {
        prev.usage_count = Number(prev.usage_count || 0) + Number(r.usage_count || 0);
        prev.score = Number(prev.score || 0) + Number(r.score || 0);
        prev.source_breakdown = this.sumNumericBreakdown(
          prev.source_breakdown,
          r.source_breakdown,
        );
        const lu = r.last_updated;
        if (lu && (!prev.last_updated || String(lu) > String(prev.last_updated))) {
          prev.last_updated = lu;
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  }

  private sumNumericBreakdown(a: Record<string, unknown>, b: Record<string, unknown>) {
    const out: Record<string, number> = {};
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
      const na = Number((a as any)?.[k]);
      const nb = Number((b as any)?.[k]);
      const va = Number.isFinite(na) ? na : 0;
      const vb = Number.isFinite(nb) ? nb : 0;
      out[k] = va + vb;
    }
    return out;
  }

  private classifyBlockedReason(detail: string): string | null {
    const d = String(detail || '').toLowerCase();
    if (d.includes('login') || d.includes('sign in')) return 'login_wall';
    if (d.includes('challenge') || d.includes('verification')) return 'challenge';
    if (d.includes('timeout')) return 'timeout';
    if (d.includes('selector')) return 'selector_miss';
    if (d.includes('empty') || d.includes('fetched 0')) return 'empty_result';
    return null;
  }

  private isLowQualityHashtag(tag: string): boolean {
    const normalized = tag.replace(/^#/, '');
    if (!normalized) return true;
    if (normalized.length < 2 || normalized.length > 30) return true;
    const digitCount = (normalized.match(/[0-9]/g) || []).length;
    if (digitCount > Math.floor(normalized.length * 0.5)) return true;
    if (/(.)\1{4,}/.test(normalized)) return true;
    if (/^[a-z]+[0-9]{4,}$/.test(normalized)) return true;
    return false;
  }

  private async fetchFromInternalScraper(
    source: Source,
    tag: string,
    limit: number,
  ): Promise<SourcePayload> {
    try {
      const delayMs = Number(process.env.SCRAPER_DELAY_MS || '0');
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const posts =
        source === 'twitter'
          ? await this.twitterScraper.fetch(tag, limit)
          : source === 'instagram'
            ? await this.instagramScraper.fetch(tag, limit)
            : await this.linkedinScraper.fetch(tag, limit);

      const normalizedPosts: SourcePost[] = posts.map((post) => ({
        id: String(post.id || ''),
        text: String(post.text || ''),
        hashtags: (post.hashtags || [])
          .map((v) => this.normalizeHashtag(v))
          .filter((v): v is string => Boolean(v)),
        publishedAt: String(post.publishedAt || new Date().toISOString()),
        permalink: post.permalink,
        contentType: (post as { contentType?: string }).contentType,
      }));

      let filteredOutCount = 0;
      for (const post of normalizedPosts) {
        const before = post.hashtags.length;
        post.hashtags = post.hashtags.filter((h) => !this.isLowQualityHashtag(h));
        filteredOutCount += Math.max(0, before - post.hashtags.length);
      }

      if (normalizedPosts.length === 0) {
        return {
          source,
          posts: [],
          hashtags: [],
          status: 'error',
          detail:
            `Fetched 0 ${source} posts. Most likely blocked by login wall/anti-bot or selector drift.`,
          filteredOutCount,
        };
      }

      return {
        source,
        posts: normalizedPosts,
        hashtags: normalizedPosts.flatMap((post) => post.hashtags),
        status: 'ok',
        detail: `Fetched ${normalizedPosts.length} ${source} posts via internal Playwright scraper`,
        filteredOutCount,
      };
    } catch (error) {
      return {
        source,
        posts: [],
        hashtags: [],
        status: 'error',
        detail: `Internal scraper failed: ${(error as Error).message}`,
        filteredOutCount: 0,
      };
    }
  }

  private async fetchX(tag: string, limit: number): Promise<SourcePayload> {
    if (this.engineMode === 'playwright') {
      return this.fetchFromInternalScraper('twitter', tag, limit);
    }
    const token = process.env.X_BEARER_TOKEN || '';
    if (!token) {
      return {
        source: 'twitter',
        posts: [],
        hashtags: [],
        status: 'not_configured',
        detail: 'X_BEARER_TOKEN missing',
      };
    }

    try {
      const query = encodeURIComponent(`#${tag} -is:retweet lang:en`);
      const max = Math.max(10, Math.min(limit, 100));
      const url =
        `https://api.x.com/2/tweets/search/recent?query=${query}` +
        `&max_results=${max}&tweet.fields=created_at,text,entities`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          source: 'twitter',
          posts: [],
          hashtags: [],
          status: 'error',
          detail: `X API error ${response.status}: ${text.slice(0, 180)}`,
        };
      }

      const payload = (await response.json()) as { data?: any[] };
      const posts: SourcePost[] = (payload.data || []).map((row) => {
        const extracted =
          Array.isArray(row?.entities?.hashtags) && row.entities.hashtags.length > 0
            ? row.entities.hashtags
                .map((h: any) => this.normalizeHashtag(String(h?.tag || '')))
                .filter((v: string | null): v is string => Boolean(v))
            : this.extractHashtags(String(row?.text || ''));
        return {
          id: String(row?.id || ''),
          text: String(row?.text || ''),
          hashtags: extracted,
          publishedAt: String(row?.created_at || new Date().toISOString()),
          permalink: row?.id ? `https://x.com/i/web/status/${row.id}` : undefined,
        };
      });
      return {
        source: 'twitter',
        posts,
        hashtags: posts.flatMap((post) => post.hashtags),
        status: 'ok',
        detail: `Fetched ${posts.length} X posts`,
      };
    } catch (error) {
      return {
        source: 'twitter',
        posts: [],
        hashtags: [],
        status: 'error',
        detail: `X fetch failed: ${(error as Error).message}`,
      };
    }
  }

  private async fetchInstagram(tag: string, limit: number): Promise<SourcePayload> {
    if (this.engineMode === 'playwright') {
      return this.fetchFromInternalScraper('instagram', tag, limit);
    }
    const token = process.env.INSTAGRAM_ACCESS_TOKEN || '';
    const userId = process.env.INSTAGRAM_USER_ID || '';
    if (!token || !userId) {
      return {
        source: 'instagram',
        posts: [],
        hashtags: [],
        status: 'not_configured',
        detail: 'INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID missing',
      };
    }

    try {
      const searchUrl =
        `https://graph.facebook.com/v23.0/ig_hashtag_search?` +
        `user_id=${encodeURIComponent(userId)}&q=${encodeURIComponent(tag)}&access_token=${encodeURIComponent(token)}`;
      const searchResponse = await fetch(searchUrl);
      if (!searchResponse.ok) {
        const txt = await searchResponse.text();
        return {
          source: 'instagram',
          posts: [],
          hashtags: [],
          status: 'error',
          detail: `IG hashtag_search error ${searchResponse.status}: ${txt.slice(0, 180)}`,
        };
      }

      const searchPayload = (await searchResponse.json()) as { data?: Array<{ id: string }> };
      const hashtagId = searchPayload?.data?.[0]?.id;
      if (!hashtagId) {
        return {
          source: 'instagram',
          posts: [],
          hashtags: [],
          status: 'ok',
          detail: 'No hashtag id returned',
        };
      }

      const mediaUrl =
        `https://graph.facebook.com/v23.0/${encodeURIComponent(hashtagId)}/recent_media?` +
        `user_id=${encodeURIComponent(userId)}&fields=id,caption,timestamp,permalink&limit=${Math.max(5, Math.min(limit, 50))}` +
        `&access_token=${encodeURIComponent(token)}`;
      const mediaResponse = await fetch(mediaUrl);
      if (!mediaResponse.ok) {
        const txt = await mediaResponse.text();
        return {
          source: 'instagram',
          posts: [],
          hashtags: [],
          status: 'error',
          detail: `IG recent_media error ${mediaResponse.status}: ${txt.slice(0, 180)}`,
        };
      }

      const mediaPayload = (await mediaResponse.json()) as { data?: any[] };
      const posts: SourcePost[] = (mediaPayload.data || []).map((row) => {
        const text = String(row?.caption || '');
        return {
          id: String(row?.id || ''),
          text,
          hashtags: this.extractHashtags(text),
          publishedAt: String(row?.timestamp || new Date().toISOString()),
          permalink: row?.permalink ? String(row.permalink) : undefined,
        };
      });
      return {
        source: 'instagram',
        posts,
        hashtags: posts.flatMap((post) => post.hashtags),
        status: 'ok',
        detail: `Fetched ${posts.length} Instagram posts`,
      };
    } catch (error) {
      return {
        source: 'instagram',
        posts: [],
        hashtags: [],
        status: 'error',
        detail: `Instagram fetch failed: ${(error as Error).message}`,
      };
    }
  }

  private async fetchLinkedin(tag: string, limit: number): Promise<SourcePayload> {
    if (this.engineMode === 'playwright') {
      return this.fetchFromInternalScraper('linkedin', tag, limit);
    }
    return {
      source: 'linkedin',
      posts: [],
      hashtags: [],
      status: 'not_configured',
      detail:
        'LinkedIn public discovery is not available via official API in this mode. Use TRENDING_ENGINE=playwright.',
    };
  }

  private scoreFromSource(source: Source, count: number): number {
    if (source === 'twitter') return count * 1.1;
    if (source === 'instagram') return count * 1.0;
    return count * 1.25;
  }

  async processTag(input: AdminTagRecord, force = false): Promise<void> {
    this.logger.log(`processTag start tag=${input.tag} force=${force}`);
    if (!force && input.last_fetched_at) {
      const age = Date.now() - new Date(input.last_fetched_at).getTime();
      if (age < 6 * 60 * 60 * 1000) {
        this.logger.debug(`Skipping ${input.tag}; fetched recently.`);
        return;
      }
    }

    const [instagram, twitter, linkedin] = await Promise.all([
      this.fetchInstagram(input.tag, 30),
      this.fetchX(input.tag, 50),
      this.fetchLinkedin(input.tag, 20),
    ]);
    this.logger.log(
      `processTag source status tag=${input.tag} | ig=${instagram.status}(${instagram.detail}) tw=${twitter.status}(${twitter.detail}) li=${linkedin.status}(${linkedin.detail})`,
    );
    this.logger.log(
      `processTag source results tag=${input.tag} | ig=${instagram.posts.length} tw=${twitter.posts.length} li=${linkedin.posts.length}`,
    );

    type FormatCounts = { ig_reel: number; ig_post: number; tweet: number; li_post: number };
    const emptyFormats = (): FormatCounts => ({
      ig_reel: 0,
      ig_post: 0,
      tweet: 0,
      li_post: 0,
    });

    const aggregate = new Map<
      string,
      {
        usageCount: number;
        score: number;
        sourceBreakdown: Record<Source, number>;
        formats: FormatCounts;
      }
    >();

    const bumpFormat = (
      formats: FormatCounts,
      source: Source,
      contentType: string | undefined,
      delta: number,
    ) => {
      if (source === 'instagram') {
        if (contentType === 'reel') formats.ig_reel += delta;
        else formats.ig_post += delta;
      } else if (source === 'twitter') {
        formats.tweet += delta;
      } else {
        formats.li_post += delta;
      }
    };

    for (const payload of [instagram, twitter, linkedin]) {
      for (const post of payload.posts) {
        for (const hashtag of post.hashtags) {
          const current = aggregate.get(hashtag) || {
            usageCount: 0,
            score: 0,
            sourceBreakdown: { instagram: 0, twitter: 0, linkedin: 0 },
            formats: emptyFormats(),
          };
          current.usageCount += 1;
          current.sourceBreakdown[payload.source] += 1;
          current.score += this.scoreFromSource(payload.source, 1);
          bumpFormat(current.formats, payload.source, post.contentType, 1);
          aggregate.set(hashtag, current);
        }
      }
    }

    const records = Array.from(aggregate.entries()).map(([hashtag, metrics]) => ({
      scope_tag: input.tag,
      hashtag,
      score: Number((metrics.score + input.priority * 0.2).toFixed(4)),
      usage_count: metrics.usageCount,
      source_breakdown: {
        ...metrics.sourceBreakdown,
        ig_reel: metrics.formats.ig_reel,
        ig_post: metrics.formats.ig_post,
        tweet: metrics.formats.tweet,
        li_post: metrics.formats.li_post,
      },
      last_updated: new Date().toISOString(),
    }));
    this.logger.log(
      `processTag aggregate tag=${input.tag} hashtags=${records.length}`,
    );

    if (records.length > 0) {
      const { error } = await this.supabaseService
        .getServiceClient()
        .from('trending_hashtags')
        .upsert(records, { onConflict: 'scope_tag,hashtag' });
      if (error) {
        throw new Error(`Failed to upsert hashtags: ${error.message}`);
      }
    }
    if (records.length === 0) {
      this.logger.warn(
        `processTag produced zero hashtags for tag=${input.tag} (external sources empty or blocked)`,
      );
    }

    await this.tagsService.touchFetched(input.id);
    await this.refreshCacheForTag(input.tag);
    await this.refreshGlobalCache();
  }

  async refreshCacheForTag(tag: string): Promise<void> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('trending_hashtags')
      .select('hashtag, score, usage_count, source_breakdown, last_updated')
      .eq('scope_tag', tag)
      .order('score', { ascending: false })
      .limit(2000);

    if (error) {
      throw new Error(`Failed to read tag trends: ${error.message}`);
    }
    const rows = this.filterExternalOnly(data || []);
    await this.cacheService.set(`trending:${tag}`, rows, 60 * 60);
  }

  /** Full merged global list for cache + pagination (not capped at 20). */
  private readonly globalTrendRawCap = 12_000;

  async refreshGlobalCache(): Promise<void> {
    const rows = await this.loadGlobalTrendingMergedFromDb(this.globalTrendRawCap);
    const listKey = 'trending:global:list';
    if (rows.length > 0) {
      await this.cacheService.set(listKey, rows, 60 * 60);
      await this.cacheService.delete('trending:global').catch(() => {});
      return;
    }
    if (this.allowInhouseFallback) {
      const fallback = await this.buildFallbackFromGeneratedContent(500, undefined);
      if (fallback.length > 0) {
        await this.cacheService.set(listKey, fallback, 60 * 10);
        return;
      }
    }
    await this.cacheService.delete(listKey).catch(() => {});
  }

  private async loadGlobalTrendingMergedFromDb(maxRawRows: number): Promise<any[]> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('trending_hashtags')
      .select('scope_tag, hashtag, score, usage_count, source_breakdown, last_updated')
      .order('score', { ascending: false })
      .limit(maxRawRows);
    if (error) {
      throw new Error(`Failed to fetch global trends: ${error.message}`);
    }
    let rows = data || [];
    if (this.engineMode === 'playwright' && !this.allowInhouseFallback) {
      rows = rows.filter((r: any) => this.externalSignalTotal(r?.source_breakdown) > 0);
    }
    if (rows.length === 0) return [];
    return this.mergeTrendingByHashtag(rows);
  }

  private async loadScopedTrendingFromDb(tag: string, maxRaw = 2000): Promise<any[]> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('trending_hashtags')
      .select('scope_tag, hashtag, score, usage_count, source_breakdown, last_updated')
      .eq('scope_tag', tag)
      .order('score', { ascending: false })
      .limit(maxRaw);
    if (error) {
      throw new Error(`Failed to fetch scoped trends: ${error.message}`);
    }
    return this.filterExternalOnly(data || []);
  }

  /** Keep only rows with real external (IG/X/LinkedIn) signal. */
  private filterExternalOnly<T extends { source_breakdown?: any }>(rows: T[]): T[] {
    if (this.allowInhouseFallback || this.engineMode !== 'playwright') return rows;
    return rows.filter((r) => this.externalSignalTotal(r?.source_breakdown) > 0);
  }

  async decayScores(): Promise<void> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('trending_hashtags')
      .select('id, score');

    if (error) {
      throw new Error(`Failed to read scores for decay: ${error.message}`);
    }

    for (const row of data || []) {
      await this.supabaseService
        .getServiceClient()
        .from('trending_hashtags')
        .update({
          score: Number((Number(row.score || 0) * 0.9).toFixed(4)),
          last_updated: new Date().toISOString(),
        })
        .eq('id', row.id);
    }
  }

  async cleanupStale(): Promise<void> {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await this.supabaseService
      .getServiceClient()
      .from('trending_hashtags')
      .delete()
      .lt('last_updated', cutoff);

    if (error) {
      throw new Error(`Failed to cleanup stale rows: ${error.message}`);
    }
  }

  private async buildFallbackFromGeneratedContent(
    limit: number,
    tag?: string,
  ): Promise<
    Array<{
      scope_tag: string;
      hashtag: string;
      score: number;
      usage_count: number;
      source_breakdown: Record<Source, number>;
      last_updated: string;
    }>
  > {
    const q = this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('hashtags, content, updated_at')
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .limit(800);

    if (tag) q.ilike('content', `%${tag}%`);

    const { data, error } = await q;
    if (error) {
      throw new Error(`Fallback trend query failed: ${error.message}`);
    }

    const byTag = new Map<
      string,
      { usage_count: number; score: number; last_updated: string }
    >();
    for (const row of data || []) {
      const direct = Array.isArray(row.hashtags)
        ? row.hashtags
            .map((value: string) => this.normalizeHashtag(value))
            .filter((value): value is string => Boolean(value))
        : [];
      const extracted = this.extractHashtags(String(row.content || ''));
      const unique = Array.from(new Set([...direct, ...extracted]));
      for (const hashtag of unique) {
        const current = byTag.get(hashtag) || {
          usage_count: 0,
          score: 0,
          last_updated: row.updated_at || new Date().toISOString(),
        };
        current.usage_count += 1;
        current.score += 1;
        if (
          new Date(row.updated_at || 0).getTime() >
          new Date(current.last_updated || 0).getTime()
        ) {
          current.last_updated = row.updated_at;
        }
        byTag.set(hashtag, current);
      }
    }

    return Array.from(byTag.entries())
      .map(([hashtag, v]) => ({
        scope_tag: tag || 'global',
        hashtag,
        score: Number(v.score.toFixed(4)),
        usage_count: v.usage_count,
        source_breakdown: { instagram: 0, twitter: 0, linkedin: 0 },
        last_updated: v.last_updated,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Paginated trending: merges all admin scope rows for global view so every
   * admin tag’s scraped hashtags can surface (not only the top N raw DB rows).
   */
  /** Redis JSON must deserialize to a real array; some clients store array-like objects. */
  private normalizeCachedTrendingRows(raw: unknown): unknown[] {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => /^\d+$/.test(k));
      if (keys.length > 0) {
        return keys
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => o[k])
          .filter((v) => v != null);
      }
    }
    return [];
  }

  async getTrendingPaged(
    tag?: string,
    limit = 20,
    offset = 0,
  ): Promise<{
    items: unknown[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    const lim = Number(limit);
    const off = Number(offset);
    const safeLimit =
      Number.isFinite(lim) && lim >= 1 ? Math.min(Math.floor(lim), 100) : 20;
    const safeOffset =
      Number.isFinite(off) && off >= 0 ? Math.min(Math.floor(off), 100_000) : 0;
    const normalizedTag = tag ? tag.toLowerCase().replace(/^#+/, '') : '';

    if (!normalizedTag) {
      const listKey = 'trending:global:list';
      const fullRows = await this.cacheService.get(listKey);
      let arr = this.normalizeCachedTrendingRows(fullRows);
      if (
        arr.length > 0 &&
        this.engineMode === 'playwright' &&
        !this.allowInhouseFallback &&
        !this.hasExternalSignal(arr)
      ) {
        await this.cacheService.delete(listKey);
        arr = [];
      }
      if (arr.length === 0) {
        arr = await this.loadGlobalTrendingMergedFromDb(this.globalTrendRawCap);
        if (arr.length > 0) {
          await this.cacheService.set(listKey, arr, 60 * 60);
        } else if (this.allowInhouseFallback) {
          const fallback = await this.buildFallbackFromGeneratedContent(500, undefined);
          if (fallback.length > 0) {
            await this.cacheService.set(listKey, fallback, 60 * 10);
            arr = fallback;
          }
        }
      }
      const total = arr.length;
      const items = arr.slice(safeOffset, safeOffset + safeLimit);
      return {
        items,
        total,
        limit: safeLimit,
        offset: safeOffset,
        hasMore: safeOffset + items.length < total,
      };
    }

    const cacheKey = `trending:${normalizedTag}`;
    const cachedTag = await this.cacheService.get(cacheKey);
    let rows = this.normalizeCachedTrendingRows(cachedTag);
    if (
      rows.length > 0 &&
      this.engineMode === 'playwright' &&
      !this.allowInhouseFallback &&
      !this.hasExternalSignal(rows)
    ) {
      await this.cacheService.delete(cacheKey);
      rows = [];
    }
    if (rows.length === 0) {
      rows = await this.loadScopedTrendingFromDb(normalizedTag, 2000);
      if (rows.length > 0) {
        await this.cacheService.set(cacheKey, rows, 60 * 60);
      } else if (this.allowInhouseFallback) {
        const fallback = await this.buildFallbackFromGeneratedContent(500, normalizedTag);
        rows = fallback;
        if (rows.length > 0) {
          await this.cacheService.set(cacheKey, rows, 60 * 10);
        }
      }
    }
    const total = rows.length;
    const items = rows.slice(safeOffset, safeOffset + safeLimit);
    return {
      items,
      total,
      limit: safeLimit,
      offset: safeOffset,
      hasMore: safeOffset + items.length < total,
    };
  }

  async getTrendingDebug(tag?: string, limit = 20): Promise<{
    api: { endpoint: string; tag: string | null; limit: number };
    cache: { key: string; hit: boolean; size: number };
    dataSource: 'cache' | 'aggregated_table' | 'fallback_generated_content' | 'empty';
    aggregatedCount: number;
    fallbackCandidateCount: number;
    topFromAggregated: unknown[];
    topFromFallback: unknown[];
    sampleGeneratedContent: Array<{
      id: string;
      title: string;
      hashtags: string[] | null;
      updated_at: string;
      content_preview: string;
    }>;
    sourceFetch: Record<
      Source,
      {
        status: 'ok' | 'not_configured' | 'error';
        detail: string;
        blockedReason: string | null;
        filteredOutCount: number;
        postsFetched: number;
        samplePosts: Array<{
          id: string;
          publishedAt: string;
          permalink?: string;
          hashtags: string[];
          text_preview: string;
        }>;
      }
    >;
    notes: string[];
  }> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const normalizedTag = tag ? tag.toLowerCase().replace(/^#+/, '') : null;
    const cacheKey = normalizedTag ? `trending:${normalizedTag}` : 'trending:global:list';
    const subjectTag = normalizedTag || 'ai';

    const cached = await this.cacheService.get(cacheKey);
    const cacheRows = Array.isArray(cached) ? cached : [];

    const aggQuery = this.supabaseService
      .getServiceClient()
      .from('trending_hashtags')
      .select('scope_tag, hashtag, score, usage_count, source_breakdown, last_updated')
      .order('score', { ascending: false })
      .limit(safeLimit);
    if (normalizedTag) aggQuery.eq('scope_tag', normalizedTag);
    const { data: aggregatedRows, error: aggError } = await aggQuery;
    if (aggError) throw new Error(`Debug aggregate read failed: ${aggError.message}`);

    const [ig, x, li] = await Promise.all([
      this.fetchInstagram(subjectTag, 10),
      this.fetchX(subjectTag, 10),
      this.fetchLinkedin(subjectTag, 10),
    ]);

    const fallbackRows = this.allowInhouseFallback
      ? await this.buildFallbackFromGeneratedContent(safeLimit, normalizedTag || undefined)
      : [];

    const sampleRows = this.allowInhouseFallback
      ? (
          await (async () => {
            const sampleQuery = this.supabaseService
              .getServiceClient()
              .from('generated_content')
              .select('id, title, hashtags, content, updated_at')
              .is('deleted_at', null)
              .order('updated_at', { ascending: false })
              .limit(15);
            if (normalizedTag) sampleQuery.ilike('content', `%${normalizedTag}%`);
            const { data } = await sampleQuery;
            return data || [];
          })()
        )
      : [];

    let dataSource: 'cache' | 'aggregated_table' | 'fallback_generated_content' | 'empty' =
      'empty';
    if (cacheRows.length > 0) dataSource = 'cache';
    else if ((aggregatedRows || []).length > 0) dataSource = 'aggregated_table';
    else if (fallbackRows.length > 0) dataSource = 'fallback_generated_content';

    const toDebugSource = (payload: SourcePayload) => ({
      status: payload.status,
      detail: payload.detail,
      blockedReason: this.classifyBlockedReason(payload.detail),
      filteredOutCount: Number(payload.filteredOutCount || 0),
      postsFetched: payload.posts.length,
      samplePosts: payload.posts.slice(0, 5).map((post) => ({
        id: post.id,
        publishedAt: post.publishedAt,
        permalink: post.permalink,
        hashtags: post.hashtags,
        text_preview: post.text.slice(0, 180),
      })),
    });

    return {
      api: { endpoint: '/content/trending', tag: normalizedTag, limit: safeLimit },
      cache: { key: cacheKey, hit: cacheRows.length > 0, size: cacheRows.length },
      dataSource,
      aggregatedCount: (aggregatedRows || []).length,
      fallbackCandidateCount: fallbackRows.length,
      topFromAggregated: (aggregatedRows || []).slice(0, 10),
      topFromFallback: fallbackRows.slice(0, 10),
      sampleGeneratedContent: (sampleRows || []).map((row: any) => ({
        id: row.id,
        title: row.title || '',
        hashtags: Array.isArray(row.hashtags) ? row.hashtags : null,
        updated_at: row.updated_at,
        content_preview: String(row.content || '').slice(0, 180),
      })),
      sourceFetch: {
        instagram: toDebugSource(ig),
        twitter: toDebugSource(x),
        linkedin: toDebugSource(li),
      },
      notes: [
        `Primary source mode: ${this.engineMode}.`,
        'In playwright mode, engine runs internal Playwright scrapers (no external scraper URL endpoints).',
        this.allowInhouseFallback
          ? 'In-house fallback is enabled by env and may serve generated_content when no external data exists.'
          : 'In-house fallback is disabled: generated_content is excluded from trend response/debug.',
      ],
    };
  }
}
