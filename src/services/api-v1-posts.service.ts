import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { PostSchedulingService } from './post-scheduling.service';
import { ImmediatePostPublishService } from './immediate-post-publish.service';
import { QuotaService } from './quota.service';
import { CacheService } from './cache.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { GeneratedContentRepository } from '../repositories/generated-content.repository';
import { ContentStatus, VisualType } from '../common/types';

export type ApiPostType = 'now' | 'schedule';

export interface ApiCreatePostInput {
  userId: string;
  type: ApiPostType;
  content: string;
  title?: string;
  hashtags?: string[];
  mediaUrls?: string[];
  carouselUrls?: string[];
  pdfUrl?: string;
  scheduledFor?: string;
  platform?: string;
  actorType?: 'member' | 'organization';
  organizationUrn?: string;
}

export interface ApiListPostsInput {
  userId: string;
  status?: string;
  page?: number;
  limit?: number;
}

/**
 * Orchestrates Public API v1 post operations on top of the EXISTING publish
 * pipeline (Sprint 1.4) — it creates a `generated_content` row from the API
 * payload, then routes to the same services the web UI uses:
 *   - `type=now`      -> ImmediatePostPublishService (charges credits + fires
 *                        post.published / post.failed webhooks)
 *   - `type=schedule` -> PostSchedulingService.schedulePost (enqueues the shared
 *                        social-publish BullMQ job) + post.scheduled webhook.
 *
 * No new publishing logic is introduced; this is purely an API-facing seam.
 */
@Injectable()
export class ApiV1PostsService {
  private readonly logger = new Logger(ApiV1PostsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly postScheduling: PostSchedulingService,
    private readonly immediatePublish: ImmediatePostPublishService,
    private readonly quota: QuotaService,
    private readonly cache: CacheService,
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly contentRepo: GeneratedContentRepository,
  ) {}

  async createPost(input: ApiCreatePostInput): Promise<{
    success: boolean;
    type: ApiPostType;
    postId: string;
    contentId: string;
    status: string;
    platformPostId?: string;
    scheduledFor?: string;
  }> {
    const {
      userId,
      type,
      content,
      title,
      hashtags,
      mediaUrls,
      carouselUrls,
      pdfUrl,
      platform = 'linkedin',
      actorType,
      organizationUrn,
    } = input;

    if (!content || !content.trim()) {
      throw new BadRequestException('`content` is required.');
    }
    if (type !== 'now' && type !== 'schedule') {
      throw new BadRequestException("`type` must be 'now' or 'schedule'.");
    }

    const hasCarousel = Array.isArray(carouselUrls) && carouselUrls.length > 0;
    const hasImage = Array.isArray(mediaUrls) && mediaUrls.length > 0;
    const visualType = hasCarousel
      ? VisualType.CAROUSEL
      : hasImage
        ? VisualType.IMAGE
        : VisualType.NONE;

    // 1. Create the backing content row (source='custom' so it is attributable
    //    to API creation and excluded from the viral-template corpus).
    const created = await this.contentRepo.create(
      userId,
      title?.trim() || this.deriveTitle(content),
      content,
      {
        visualType,
        visualUrl: hasImage ? mediaUrls![0] : undefined,
        carouselUrls: hasCarousel ? carouselUrls : undefined,
        hashtags,
        pdfUrl,
        status: ContentStatus.READY,
        source: 'custom',
      },
    );
    const contentId = created.id;

    if (type === 'now') {
      const result = await this.immediatePublish.publishImmediate({
        userId,
        contentId,
        platform,
        actorType,
        organizationUrn,
      });
      return {
        success: true,
        type,
        postId: contentId,
        contentId,
        status: 'published',
        platformPostId: result.postId,
      };
    }

    // type === 'schedule'
    const scheduledDate = this.parseScheduledFor(input.scheduledFor);

    const creditCost = hasCarousel ? 15 : hasImage ? 7.5 : 4;
    const totalCost = creditCost + (pdfUrl ? 12 : 0);
    const operationId = `api-schedule:${contentId}`;

    const hasQuota = await this.quota.checkQuotaAvailable(userId, totalCost);
    if (!hasQuota) {
      throw new BadRequestException(
        `Insufficient credits. Scheduling requires ${totalCost} credits.`,
      );
    }

    const contentType = hasCarousel ? 'carousel' : hasImage ? 'image' : 'text';
    await this.quota.debitOnce({
      userId,
      operationId,
      amount: totalCost,
      description: `API post scheduled for ${scheduledDate.toISOString()} (${totalCost} credits)`,
      operationType: 'schedule',
      contentType,
      contentId,
    });

    try {
      const jobId = await this.postScheduling.schedulePost({
        contentId,
        userId,
        scheduledFor: scheduledDate,
        platform: platform as 'linkedin',
        actorType,
        organizationUrn,
      });

      await this.cache.invalidateUser(userId);

      try {
        await this.webhookDispatcher.emitPostScheduled({
          userId,
          contentId,
          platform,
          scheduledFor: scheduledDate.toISOString(),
        });
      } catch {
        // best-effort
      }

      return {
        success: true,
        type,
        postId: jobId,
        contentId,
        status: 'scheduled',
        scheduledFor: scheduledDate.toISOString(),
      };
    } catch (err) {
      await this.quota.refundOnce({
        userId,
        operationId,
        amount: totalCost,
        description: `Refund for failed API post scheduling (${totalCost} credits)`,
        operationType: 'refund',
        contentType,
        contentId,
      });
      throw err;
    }
  }

  /**
   * List the caller's posts (scheduled + published) for status checks. Joins
   * `scheduled_posts` to `generated_content` and merges already-published
   * content, newest first.
   */
  async listPosts(input: ApiListPostsInput): Promise<{
    data: Array<{
      id: string;
      contentId: string | null;
      status: string;
      platform: string | null;
      scheduledFor: string | null;
      publishedAt: string | null;
      platformPostId: string | null;
      content: string | null;
      title: string | null;
    }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasMore: boolean;
    };
  }> {
    const { userId, status } = input;
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const offset = (page - 1) * limit;
    const client = this.supabase.getServiceClient();

    let query = client
      .from('scheduled_posts')
      .select(
        `id, content_id, status, platform, scheduled_for, published_at,
         generated_content ( id, title, content, linkedin_post_id, published_at )`,
        { count: 'exact' },
      )
      .eq('user_id', userId)
      .order('scheduled_for', { ascending: false });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query.range(
      offset,
      offset + limit - 1,
    );
    if (error) {
      throw new Error(`Failed to list posts: ${error.message}`);
    }

    const rows = (data ?? []).map((row: Record<string, any>) => {
      const gc = (row.generated_content ?? {}) as Record<string, any>;
      return {
        id: row.id as string,
        contentId: (row.content_id as string) ?? null,
        status: (row.status as string) ?? 'unknown',
        platform: (row.platform as string) ?? null,
        scheduledFor: (row.scheduled_for as string) ?? null,
        publishedAt:
          (row.published_at as string) ?? (gc.published_at as string) ?? null,
        platformPostId: (gc.linkedin_post_id as string) ?? null,
        content: (gc.content as string) ?? null,
        title: (gc.title as string) ?? null,
      };
    });

    const total = count ?? rows.length;
    const totalPages = Math.ceil(total / limit);
    return {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages,
      },
    };
  }

  /**
   * Cancel a scheduled post by its `scheduled_posts` id. Removes the delayed
   * BullMQ job, flips the row + content to cancelled, and emits post.cancelled.
   * Returns 404 when the post does not belong to the caller, 409 when it is no
   * longer cancellable (already publishing/published/terminal).
   */
  async cancelPost(
    userId: string,
    scheduledPostId: string,
  ): Promise<{ success: boolean; status: string }> {
    const client = this.supabase.getServiceClient();

    const { data: scheduledPost, error } = await client
      .from('scheduled_posts')
      .select('id, content_id, job_id, status, platform')
      .eq('id', scheduledPostId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load scheduled post: ${error.message}`);
    }
    if (!scheduledPost) {
      throw new NotFoundException('Scheduled post not found.');
    }
    if (scheduledPost.status !== 'scheduled') {
      throw new BadRequestException(
        `Post cannot be cancelled (current status: ${scheduledPost.status}).`,
      );
    }

    // Best-effort removal of the delayed publish job so it never fires.
    if (scheduledPost.job_id) {
      try {
        await this.postScheduling.cancelScheduledPost(
          scheduledPost.job_id,
          userId,
        );
      } catch (e) {
        this.logger.warn(
          `cancelScheduledPost job removal failed: ${(e as Error).message}`,
        );
      }
    }

    await client
      .from('scheduled_posts')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', scheduledPostId)
      .eq('user_id', userId);

    if (scheduledPost.content_id) {
      await client
        .from('generated_content')
        .update({
          publish_status: 'cancelled',
          is_scheduled: false,
          scheduled_for: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', scheduledPost.content_id)
        .eq('user_id', userId);
    }

    await this.cache.invalidateUser(userId);

    try {
      await this.webhookDispatcher.emitPostCancelled({
        userId,
        contentId: scheduledPost.content_id,
        platform: scheduledPost.platform || 'linkedin',
      });
    } catch {
      // best-effort
    }

    return { success: true, status: 'cancelled' };
  }

  private deriveTitle(content: string): string {
    const firstLine = content.trim().split('\n')[0] ?? 'API Post';
    return firstLine.slice(0, 120) || 'API Post';
  }

  private parseScheduledFor(value?: string): Date {
    if (!value) {
      throw new BadRequestException(
        '`scheduledFor` (ISO 8601) is required when type is "schedule".',
      );
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        '`scheduledFor` must be a valid ISO 8601 timestamp.',
      );
    }
    if (date <= new Date()) {
      throw new BadRequestException('`scheduledFor` must be in the future.');
    }
    const maxFuture = new Date();
    maxFuture.setFullYear(maxFuture.getFullYear() + 1);
    if (date > maxFuture) {
      throw new BadRequestException(
        '`scheduledFor` cannot be more than 1 year in the future.',
      );
    }
    return date;
  }
}
