import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../services/supabase.service';

export interface PublishedPostStyleSample {
  caption: string;
  visualType: string | null;
  charCount: number | null;
  publishedAt: string;
  // Populated by the engagement-sync cron (Sprint 1.6) once a post is 24h+ old.
  // Null when engagement hasn't been pulled (or isn't available for the account).
  engagementScore?: number | null;
}

/**
 * A published post that is ready for an engagement pull: it's old enough, has a
 * LinkedIn post id to look up, and hasn't been scored yet. Returned to the
 * engagement-sync cron.
 */
export interface PendingEngagementPost {
  id: string;
  userId: string;
  platform: string;
  linkedinPostId: string;
}

/**
 * Per-user corpus of captions the user actually published (after manual edits).
 * Backs the "learn from your past posts" style personalization in custom-topic
 * generation (Sprint 1.6, task #1132). Writes happen at the single publish
 * chokepoint; reads feed the text-LLM system prompt.
 */
@Injectable()
export class UserPublishedPostRepository {
  private readonly logger = new Logger(UserPublishedPostRepository.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * Upsert a published caption keyed by content_id. Best-effort: a learning
   * sample failing to persist must never break the publish flow, so callers
   * should treat a throw here as non-fatal.
   */
  async record(sample: {
    userId: string;
    contentId: string;
    platform: string;
    caption: string;
    visualType?: string | null;
    linkedinPostId?: string | null;
  }): Promise<void> {
    const caption = (sample.caption || '').trim();
    if (!caption) return;

    const { error } = await this.supabaseService
      .getServiceClient()
      .from('user_published_posts')
      .upsert(
        {
          user_id: sample.userId,
          content_id: sample.contentId,
          platform: sample.platform || 'linkedin',
          caption,
          visual_type: sample.visualType ?? null,
          linkedin_post_id: sample.linkedinPostId ?? null,
          char_count: caption.length,
          published_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'content_id' },
      );

    if (error) throw error;
  }

  /**
   * Most recent published captions for a user on a platform. Primary source for
   * the style block.
   */
  async getRecentSamples(
    userId: string,
    platform: string,
    limit = 12,
  ): Promise<PublishedPostStyleSample[]> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('user_published_posts')
      .select('caption,visual_type,char_count,published_at')
      .eq('user_id', userId)
      .eq('platform', platform)
      .order('published_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []).map((row) => ({
      caption: row.caption,
      visualType: row.visual_type ?? null,
      charCount: row.char_count ?? null,
      publishedAt: row.published_at,
    }));
  }

  /**
   * Fallback corpus for users who published before this table existed: read
   * already-published rows straight from `generated_content`. Lets the feature
   * deliver value on day one without a backfill job.
   */
  async getFallbackFromGeneratedContent(
    userId: string,
    limit = 12,
  ): Promise<PublishedPostStyleSample[]> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('content,visual_type,published_at')
      .eq('user_id', userId)
      .eq('publish_status', 'published')
      .not('published_at', 'is', null)
      .is('deleted_at', null)
      .order('published_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []).map((row) => ({
      caption: row.content || '',
      visualType: row.visual_type ?? null,
      charCount: (row.content || '').length || null,
      publishedAt: row.published_at,
    }));
  }

  /**
   * Top-performing samples for the style block (Sprint 1.6 engagement ranking).
   * Sorts by `engagement_score DESC NULLS LAST`, then recency — so once the
   * engagement-sync cron has scored posts, the best performers lead; until then
   * (all scores null) it degrades to the exact recency behavior of
   * `getRecentSamples`. Same shape as `getRecentSamples` so it's a drop-in.
   */
  async getTopPerformingSamples(
    userId: string,
    platform: string,
    limit = 12,
  ): Promise<PublishedPostStyleSample[]> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('user_published_posts')
      .select('caption,visual_type,char_count,published_at,engagement_score')
      .eq('user_id', userId)
      .eq('platform', platform)
      .order('engagement_score', { ascending: false, nullsFirst: false })
      .order('published_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []).map((row) => ({
      caption: row.caption,
      visualType: row.visual_type ?? null,
      charCount: row.char_count ?? null,
      publishedAt: row.published_at,
      engagementScore: row.engagement_score ?? null,
    }));
  }

  /**
   * Posts ready for an engagement pull: not yet scored, published before the
   * cutoff (24h delay window), and carrying a LinkedIn post id to look up.
   * Drives the engagement-sync cron.
   */
  async getPostsAwaitingEngagement(
    cutoffIso: string,
    limit = 100,
  ): Promise<PendingEngagementPost[]> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('user_published_posts')
      .select('id,user_id,platform,linkedin_post_id')
      .is('engagement_score', null)
      .not('linkedin_post_id', 'is', null)
      .lt('published_at', cutoffIso)
      .order('published_at', { ascending: true })
      .limit(limit);

    if (error) throw error;
    return (data || [])
      .filter((row) => !!row.linkedin_post_id)
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        platform: row.platform || 'linkedin',
        linkedinPostId: row.linkedin_post_id as string,
      }));
  }

  /**
   * Persist a freshly-pulled engagement reading for one published post.
   * `engagementScore` is the ranking value (see the cron for the formula).
   */
  async updateEngagement(params: {
    id: string;
    reactions: number;
    comments: number;
    engagementScore: number;
  }): Promise<void> {
    const { error } = await this.supabaseService
      .getServiceClient()
      .from('user_published_posts')
      .update({
        reactions: params.reactions,
        comments: params.comments,
        engagement_score: params.engagementScore,
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.id);

    if (error) throw error;
  }
}
