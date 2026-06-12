import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../common/constants';
import { SupabaseService } from './supabase.service';
import { MediaGenerationService } from './media-generation.service';
import { LinkedinService } from './linkedin.service';
import { CacheService } from './cache.service';
import { UserPublishedPostRepository } from '../repositories/user-published-post.repository';
import {
  assertLinkedInCommentaryWithinLimit,
  buildLinkedInCommentary,
} from '../common/utils/linkedin-publish-text';
import {
  LinkedInPublishBridgeService,
  type LinkedInPublishMediaType,
} from '../integrations/social/providers/linkedin/linkedin-publish-bridge.service';

export interface SchedulePostRequest {
  contentId: string;
  userId: string;
  scheduledFor: Date;
  platform: 'linkedin';
  actorType?: 'member' | 'organization';
  organizationUrn?: string;
}

export interface ReschedulePostRequest {
  /** The `scheduled_posts.id` of the row to move. */
  scheduledPostId: string;
  userId: string;
  newScheduledFor: Date;
}

export interface ReschedulePostResult {
  jobId: string;
  contentId: string;
  scheduledFor: string;
}

export interface PublishPostRequest {
  contentId: string;
  userId: string;
  platform: 'linkedin';
  actorType?: 'member' | 'organization';
  organizationUrn?: string;
}

export interface PostContent {
  id: string;
  title: string;
  content: string;
  hashtags: string[];
  visual_type: 'text' | 'image' | 'carousel' | 'single';
  visual_url?: string;
  carousel_urls?: string[];
  pdf_url?: string;
  user_id: string;
  publish_status?: string;
  linkedin_post_id?: string;
  is_scheduled?: boolean;
}

@Injectable()
export class PostSchedulingService {
  private readonly logger = new Logger(PostSchedulingService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.SOCIAL_PUBLISH) private readonly publishQueue: Queue,
    private readonly supabaseService: SupabaseService,
    private readonly mediaGenerationService: MediaGenerationService,
    private readonly linkedinService: LinkedinService,
    private readonly cacheService: CacheService,
    // Sprint 1.6: captures the published caption into the per-user style corpus
    // (task #1132) so generation can learn from what the user actually published.
    private readonly publishedPostRepo: UserPublishedPostRepository,
    // Sprint 1.4 queue bridge. Optional + feature-flagged so scheduled/immediate
    // publishing keeps using the legacy service until FEATURE_SOCIAL_PROVIDER_V2
    // is on AND the user is connected under the new model.
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly linkedInPublishBridge?: LinkedInPublishBridgeService,
  ) {}

  private isSocialV2Enabled(): boolean {
    return (
      (this.configService?.get<string>('FEATURE_SOCIAL_PROVIDER_V2') ??
        process.env.FEATURE_SOCIAL_PROVIDER_V2) === 'true'
    );
  }

  /**
   * Single publish seam shared by text/image/carousel. Routes to the new
   * provider engine when enabled + the account is migrated; otherwise (and for
   * organization actors, which the new model does not yet own) it uses the
   * legacy linkedin.service.ts path. Any "not connected in v2" outcome falls
   * back to legacy so a publish is never dropped during rollout.
   */
  private async dispatchPublish(args: {
    userId: string;
    text: string;
    mediaType: LinkedInPublishMediaType;
    mediaUrl?: string;
    actorType?: 'member' | 'organization';
    organizationUrn?: string;
  }): Promise<{ postId: string }> {
    if (
      this.isSocialV2Enabled() &&
      this.linkedInPublishBridge &&
      args.actorType !== 'organization'
    ) {
      const v2 = await this.linkedInPublishBridge.publish({
        userId: args.userId,
        text: args.text,
        mediaType: args.mediaType,
        mediaUrl: args.mediaUrl,
      });
      if (v2.status === 'published') {
        this.logger.log(
          `Published via social provider v2 for user ${args.userId}: ${v2.postId}`,
        );
        return { postId: v2.postId };
      }
      this.logger.log(
        `User ${args.userId} not migrated to social provider v2; using legacy publish.`,
      );
    }

    const result = await this.linkedinService.publishPost({
      userId: args.userId,
      text: args.text,
      mediaType: args.mediaType,
      mediaUrl: args.mediaUrl,
      actorType: args.actorType,
      organizationUrn: args.organizationUrn,
    });
    return { postId: result.postId };
  }

  async schedulePost(request: SchedulePostRequest): Promise<string> {
    try {
      this.logger.log(
        `Scheduling post ${request.contentId} for ${request.scheduledFor}`,
      );

      // Clean up any expired/failed scheduled posts for this content first
      await this.cleanupExpiredScheduledPosts(
        request.contentId,
        request.userId,
      );

      // Check rate limit
      const canSchedule = await this.mediaGenerationService.checkRateLimit(
        request.userId,
        'post-scheduling',
      );

      if (!canSchedule) {
        throw new Error('Rate limit exceeded for post scheduling');
      }

      // Get content details
      const content = await this.getContentById(request.contentId);
      if (!content) {
        throw new NotFoundException('Content not found');
      }

      this.validateLinkedInPostContent(content);

      // `linkedin_post_id` is the DURABLE "already live on LinkedIn" marker.
      // publish_status is mutable (cleanup/cancel flows reset it to ready/draft),
      // so we must NOT rely on it for duplicate prevention — guard on the post ID
      // alone. Once content has been published to LinkedIn it cannot be scheduled
      // again (prevents duplicate posts on the user's LinkedIn).
      if (content.linkedin_post_id) {
        throw new ConflictException({
          message:
            'This post has already been published to LinkedIn and cannot be scheduled again.',
          code: 'post_already_published',
        });
      }

      // Cancel any existing active scheduled posts for this content (allow rescheduling)
      const { data: existingScheduled } = await this.supabaseService
        .getServiceClient()
        .from('scheduled_posts')
        .select('id, status, scheduled_for, job_id')
        .eq('content_id', request.contentId)
        .eq('user_id', request.userId)
        .in('status', ['scheduled', 'processing']);

      if (existingScheduled && existingScheduled.length > 0) {
        this.logger.log(
          `Found ${existingScheduled.length} existing scheduled entries for content ${request.contentId}, cancelling them for reschedule`,
        );

        for (const existing of existingScheduled) {
          // Remove old job from queue
          try {
            if (existing.job_id) {
              const oldJob = await this.publishQueue.getJob(existing.job_id);
              if (oldJob) {
                await oldJob.remove();
                this.logger.log(`Removed old queue job ${existing.job_id}`);
              }
            }
          } catch (e) {
            this.logger.warn(
              `Could not remove old job ${existing.job_id}: ${e.message}`,
            );
          }

          // Mark old entry as cancelled
          await this.supabaseService
            .getServiceClient()
            .from('scheduled_posts')
            .update({ status: 'cancelled' })
            .eq('id', existing.id);
        }

        // Reset content status so the new schedule can proceed
        await this.supabaseService
          .getServiceClient()
          .from('generated_content')
          .update({
            is_scheduled: false,
            publish_status: 'ready',
          })
          .eq('id', request.contentId);

        this.logger.log(
          `Cancelled ${existingScheduled.length} old scheduled entries, ready for reschedule`,
        );
      }

      // Create BullMQ job
      const job = await this.publishQueue.add(
        'publish-scheduled-post',
        {
          contentId: request.contentId,
          userId: request.userId,
          platform: request.platform,
          actorType: request.actorType,
          organizationUrn: request.organizationUrn,
          scheduledFor: request.scheduledFor.toISOString(),
          contentPreview: content.content?.substring(0, 100) || '',
        },
        {
          delay: request.scheduledFor.getTime() - Date.now(),
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: 10,
          removeOnFail: 10,
          jobId: `post-${request.contentId}-${Date.now()}`,
        },
      );

      // Save to database
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('scheduled_posts')
        .insert({
          user_id: request.userId,
          content_id: request.contentId,
          job_id: job.id?.toString() || 'unknown',
          scheduled_for: request.scheduledFor.toISOString(),
          platform: request.platform,
          status: 'scheduled',
          // Persist the publishing actor so the DB is the source of truth
          // (reschedule + missed-post sweeper recover it from here, not from
          // the BullMQ job which may be evicted from Redis).
          actor_type: request.actorType ?? null,
          organization_urn: request.organizationUrn ?? null,
        })
        .select()
        .single();

      if (error) {
        this.logger.error('Failed to save scheduled post:', error);
        throw new Error('Failed to save scheduled post');
      }

      // Update content status
      await this.supabaseService
        .getServiceClient()
        .from('generated_content')
        .update({
          is_scheduled: true,
          scheduled_for: request.scheduledFor.toISOString(),
          publish_status: 'scheduled',
        })
        .eq('id', request.contentId);

      this.logger.log(`Post scheduled successfully with job ID: ${job.id}`);
      return job.id?.toString() || 'unknown';
    } catch (error) {
      this.logger.error('Failed to schedule post:', error.message);
      throw error;
    }
  }

  /**
   * Moves an already-scheduled post to a new time WITHOUT charging credits.
   *
   * Unlike `schedulePost` (which the POST /posts/schedule controller wraps with
   * up-front credit deduction), reschedule is a pure time-shift of an existing
   * `scheduled_posts` row: it updates the row in place (preserving its id so the
   * calendar's optimistic move stays valid), swaps the delayed BullMQ job, and
   * re-validates the LinkedIn character limit. No credits are consumed here, and
   * the controller route does not deduct any either — this is the dedicated
   * no-charge path for drag-and-drop calendar rescheduling.
   *
   * actorType/organizationUrn are recovered from the existing delayed BullMQ job
   * (they are not persisted on `scheduled_posts`), so org-scheduled posts keep
   * their actor through a reschedule without needing a schema change.
   */
  async reschedulePost(
    request: ReschedulePostRequest,
  ): Promise<ReschedulePostResult> {
    const { scheduledPostId, userId, newScheduledFor } = request;

    this.logger.log(
      `Rescheduling scheduled_post ${scheduledPostId} to ${newScheduledFor.toISOString()} (no charge)`,
    );

    // 1. Load + ownership check on the scheduled_posts row.
    const { data: scheduledPost, error: fetchError } = await this.supabaseService
      .getServiceClient()
      .from('scheduled_posts')
      .select(
        'id, content_id, job_id, status, scheduled_for, platform, actor_type, organization_urn',
      )
      .eq('id', scheduledPostId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !scheduledPost) {
      throw new NotFoundException('Scheduled post not found');
    }

    // 2. Only an active (not-yet-published, not-mid-publish) entry can move.
    // 'processing' means a worker has picked it up; 'published'/'cancelled'/
    // 'failed' are terminal. Reschedule is for 'scheduled'/'pending' only.
    if (!['scheduled', 'pending'].includes(scheduledPost.status as string)) {
      throw new BadRequestException(
        `This post can no longer be rescheduled (current status: ${scheduledPost.status}).`,
      );
    }

    // 3. Durable "already live on LinkedIn" guard — never reschedule a published
    // post. linkedin_post_id is the immutable marker; publish_status is mutable.
    const content = await this.getContentById(scheduledPost.content_id);
    if (!content) {
      throw new NotFoundException('Content not found');
    }
    if (content.linkedin_post_id || content.publish_status === 'published') {
      throw new ConflictException({
        message:
          'This post has already been published to LinkedIn and cannot be rescheduled.',
        code: 'post_already_published',
      });
    }

    // 4. Re-validate the LinkedIn 3000-char commentary limit (caption + tags).
    this.validateLinkedInPostContent(content);

    // 5. Resolve actor info. The scheduled_posts row is the SOURCE OF TRUTH
    // (persisted at schedule time). We only fall back to the old delayed BullMQ
    // job's data for rows created before the actor columns existed (NULL row
    // values) — and that fallback is unreliable since Redis may have evicted the
    // job, in which case an org post would otherwise silently degrade to member.
    let actorType: 'member' | 'organization' | undefined =
      (scheduledPost.actor_type as 'member' | 'organization' | null) ??
      undefined;
    let organizationUrn: string | undefined =
      (scheduledPost.organization_urn as string | null) ?? undefined;

    // Remove the old delayed job; recover actor from it only as a back-compat
    // fallback when the row did not carry actor info.
    if (scheduledPost.job_id) {
      try {
        const oldJob = await this.publishQueue.getJob(scheduledPost.job_id);
        if (oldJob) {
          const jobData = (oldJob.data ?? {}) as {
            actorType?: 'member' | 'organization';
            organizationUrn?: string;
          };
          if (actorType === undefined) {
            actorType = jobData.actorType;
          }
          if (organizationUrn === undefined) {
            organizationUrn = jobData.organizationUrn;
          }
          await oldJob.remove();
          this.logger.log(
            `Removed old queue job ${scheduledPost.job_id} for reschedule`,
          );
        }
      } catch (e) {
        this.logger.warn(
          `Could not remove old job ${scheduledPost.job_id}: ${(e as Error).message}`,
        );
      }
    }

    // 6. Enqueue a fresh delayed job at the new time.
    const platform = (scheduledPost.platform as 'linkedin') || 'linkedin';
    const job = await this.publishQueue.add(
      'publish-scheduled-post',
      {
        contentId: scheduledPost.content_id,
        userId,
        platform,
        actorType,
        organizationUrn,
        scheduledFor: newScheduledFor.toISOString(),
        contentPreview: content.content?.substring(0, 100) || '',
      },
      {
        delay: newScheduledFor.getTime() - Date.now(),
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: 10,
        removeOnFail: 10,
        jobId: `post-${scheduledPost.content_id}-${Date.now()}`,
      },
    );

    const newJobId = job.id?.toString() || 'unknown';

    // 7. Update the existing scheduled_posts row in place (no new row, no charge).
    const { error: updateError } = await this.supabaseService
      .getServiceClient()
      .from('scheduled_posts')
      .update({
        scheduled_for: newScheduledFor.toISOString(),
        job_id: newJobId,
        status: 'scheduled',
        // Re-persist the resolved actor so the row stays the source of truth
        // (back-fills rows that originally had NULL actor columns).
        actor_type: actorType ?? null,
        organization_urn: organizationUrn ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', scheduledPostId)
      .eq('user_id', userId);

    if (updateError) {
      this.logger.error(
        'Failed to update scheduled_posts row on reschedule:',
        updateError,
      );
      throw new Error('Failed to reschedule post');
    }

    // 8. Keep generated_content in sync (mirrors schedulePost).
    await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .update({
        is_scheduled: true,
        scheduled_for: newScheduledFor.toISOString(),
        publish_status: 'scheduled',
        updated_at: new Date().toISOString(),
      })
      .eq('id', scheduledPost.content_id)
      .eq('user_id', userId);

    this.logger.log(
      `Rescheduled scheduled_post ${scheduledPostId} -> job ${newJobId}`,
    );

    return {
      jobId: newJobId,
      contentId: scheduledPost.content_id,
      scheduledFor: newScheduledFor.toISOString(),
    };
  }

  async publishPostNow(request: PublishPostRequest): Promise<string> {
    try {
      this.logger.log(`Publishing post ${request.contentId} immediately`);

      // Check rate limit
      const canPublish = await this.mediaGenerationService.checkRateLimit(
        request.userId,
        'post-publishing',
      );

      if (!canPublish) {
        throw new Error('Rate limit exceeded for post publishing');
      }

      // Get content details
      const content = await this.getContentById(request.contentId);
      if (!content) {
        throw new Error('Content not found');
      }

      this.validateLinkedInPostContent(content);

      // Durable duplicate guard: if this content already has a LinkedIn post ID
      // it is live on LinkedIn — never publish it again, regardless of the
      // (mutable) publish_status. This is the last line of defense and also
      // catches scheduled jobs that were enqueued before the content published.
      if (content.linkedin_post_id) {
        throw new ConflictException({
          message: 'This post has already been published to LinkedIn.',
          code: 'post_already_published',
        });
      }

      // Publish based on content type with smart fallback
      let publishResult: any;

      // Determine actual content type based on available data
      const hasValidImage =
        content.visual_url && content.visual_url.startsWith('http');
      const hasCarousel =
        content.carousel_urls && content.carousel_urls.length > 0;

      if (hasCarousel) {
        publishResult = await this.publishCarouselPost(
          content,
          request.actorType,
          request.organizationUrn,
        );
      } else if (
        hasValidImage &&
        (content.visual_type === 'image' || content.visual_type === 'single')
      ) {
        publishResult = await this.publishImagePost(
          content,
          request.actorType,
          request.organizationUrn,
        );
      } else {
        // Default to text post for any other case
        this.logger.log(
          `Publishing as text post. Visual type: ${content.visual_type}, Has valid image: ${hasValidImage}`,
        );
        publishResult = await this.publishTextPost(
          content,
          request.actorType,
          request.organizationUrn,
        );
      }

      // Update content status
      await this.supabaseService
        .getServiceClient()
        .from('generated_content')
        .update({
          publish_status: 'published',
          linkedin_post_id: publishResult.postId,
          published_at: new Date().toISOString(),
        })
        .eq('id', request.contentId);

      // Sprint 1.6 (task #1132): persist the exact caption the user published
      // into their style corpus so the next generation can learn their voice.
      // Best-effort — a learning-sample failure must never affect publishing.
      try {
        await this.publishedPostRepo.record({
          userId: content.user_id,
          contentId: content.id,
          platform: request.platform,
          caption: content.content,
          visualType: content.visual_type ?? null,
          linkedinPostId: publishResult.postId ?? null,
        });
      } catch (sampleError) {
        this.logger.warn(
          `Failed to record published-post style sample: ${(sampleError as Error).message}`,
        );
      }

      this.logger.log(`Post published successfully: ${publishResult.postId}`);
      return publishResult.postId;
    } catch (error) {
      this.logger.error('Failed to publish post:', error.message);

      // Update content status to failed
      await this.supabaseService
        .getServiceClient()
        .from('generated_content')
        .update({
          publish_status: 'failed',
        })
        .eq('id', request.contentId);

      throw error;
    }
  }

  private async publishTextPost(
    content: PostContent,
    actorType?: 'member' | 'organization',
    organizationUrn?: string,
  ): Promise<{ postId: string }> {
    const text = this.formatPostText(content);

    return this.dispatchPublish({
      userId: content.user_id,
      text,
      mediaType: 'text',
      actorType,
      organizationUrn,
    });
  }

  private async publishImagePost(
    content: PostContent,
    actorType?: 'member' | 'organization',
    organizationUrn?: string,
  ): Promise<{ postId: string }> {
    // Check if we have a valid image URL
    if (!content.visual_url || !content.visual_url.startsWith('http')) {
      this.logger.warn(
        `Invalid image URL for content ${content.id}: ${content.visual_url}. Converting to text post.`,
      );
      // Fallback to text post if image URL is invalid
      return await this.publishTextPost(content, actorType, organizationUrn);
    }

    const text = this.formatPostText(content);

    return this.dispatchPublish({
      userId: content.user_id,
      text,
      mediaType: 'image',
      mediaUrl: content.visual_url,
      actorType,
      organizationUrn,
    });
  }

  private async publishCarouselPost(
    content: PostContent,
    actorType?: 'member' | 'organization',
    organizationUrn?: string,
  ): Promise<{ postId: string }> {
    const withPdf = await this.ensureCarouselPdfUrl(content);

    const text = this.formatPostText(withPdf);

    return this.dispatchPublish({
      userId: withPdf.user_id,
      text,
      mediaType: 'document',
      mediaUrl: withPdf.pdf_url as string,
      actorType,
      organizationUrn,
    });
  }

  /**
   * LinkedIn document posts require a PDF. If slides exist but `pdf_url` is missing, assemble
   * a PDF from slide URLs, upload to MinIO, and persist `pdf_url` (shared by immediate + scheduled publish).
   */
  private async ensureCarouselPdfUrl(content: PostContent): Promise<PostContent> {
    if (!content.carousel_urls || content.carousel_urls.length === 0) {
      throw new BadRequestException(
        'Carousel has no slide images. Generate or attach carousel slides before publishing to LinkedIn.',
      );
    }

    if (content.pdf_url?.startsWith('http')) {
      return content;
    }

    const slideUrls = content.carousel_urls.filter((u) =>
      typeof u === 'string' ? u.startsWith('http') : false,
    );
    if (slideUrls.length === 0) {
      throw new BadRequestException(
        'Carousel slide URLs are missing or invalid. Regenerate the carousel or fix media URLs before publishing.',
      );
    }

    this.logger.log(
      `Carousel publish: pdf_url missing for content ${content.id}; assembling PDF from ${slideUrls.length} slide(s).`,
    );

    let pdfBuffer: Buffer;
    try {
      pdfBuffer =
        await this.mediaGenerationService.createCarouselPdfFromImageUrls(
          slideUrls,
        );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `On-demand carousel PDF assembly failed for ${content.id}: ${msg}`,
      );
      throw new BadRequestException(
        'Could not build a carousel PDF from the saved slide images. Regenerate the carousel or verify slide URLs are reachable.',
      );
    }

    const pdfFileName = `carousel-linkedin-${Date.now()}.pdf`;
    let pdfUrl: string;
    try {
      pdfUrl = await this.mediaGenerationService.uploadToMinio(
        pdfBuffer,
        pdfFileName,
        'application/pdf',
        content.user_id,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Carousel PDF upload failed for ${content.id}: ${msg}`);
      throw new Error(`Failed to upload carousel PDF for LinkedIn: ${msg}`);
    }

    const { error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .update({
        pdf_url: pdfUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('id', content.id);

    if (error) {
      this.logger.error(
        `Failed to persist pdf_url for content ${content.id}:`,
        error,
      );
      throw new Error('Failed to save carousel PDF URL after upload');
    }

    return { ...content, pdf_url: pdfUrl };
  }

  /**
   * Validates caption + hashtags as LinkedIn will receive them (after
   * `buildLinkedInCommentary`). Call before charging credits or enqueueing jobs.
   */
  async validateLinkedInPostForPublish(
    userId: string,
    contentId: string,
    overrides?: { content?: string; hashtags?: string[] },
  ): Promise<void> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('content, hashtags')
      .eq('id', contentId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      throw new NotFoundException('Content not found');
    }

    this.validateLinkedInPostContent({
      content: overrides?.content ?? data.content ?? '',
      hashtags: overrides?.hashtags ?? data.hashtags ?? [],
    });
  }

  validateLinkedInPostContent(
    content: Pick<PostContent, 'content' | 'hashtags'>,
  ): void {
    try {
      assertLinkedInCommentaryWithinLimit(content.content, content.hashtags);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(message);
    }
  }

  private formatPostText(content: PostContent): string {
    const formattedText = assertLinkedInCommentaryWithinLimit(
      content.content,
      content.hashtags,
    );
    this.logger.log(
      `Formatted post text (${formattedText.length} chars): ${formattedText.substring(0, 200)}...`,
    );
    return formattedText;
  }

  private async getContentById(contentId: string): Promise<PostContent | null> {
    try {
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('generated_content')
        .select('*')
        .eq('id', contentId)
        .single();

      if (error || !data) {
        this.logger.error('Content not found:', error);
        return null;
      }

      return data as PostContent;
    } catch (error) {
      this.logger.error('Failed to get content:', error.message);
      return null;
    }
  }

  private async cleanupExpiredScheduledPosts(
    contentId: string,
    userId: string,
  ): Promise<void> {
    try {
      const now = new Date();

      // Find expired scheduled posts for this content
      const { data: expiredPosts } = await this.supabaseService
        .getServiceClient()
        .from('scheduled_posts')
        .select('id, job_id, scheduled_for')
        .eq('content_id', contentId)
        .eq('user_id', userId)
        .in('status', ['scheduled', 'processing'])
        .lt('scheduled_for', now.toISOString());

      if (expiredPosts && expiredPosts.length > 0) {
        this.logger.log(
          `Found ${expiredPosts.length} expired scheduled posts for content ${contentId}, cleaning up...`,
        );

        for (const post of expiredPosts) {
          // Try to remove job from queue
          try {
            const job = await this.publishQueue.getJob(post.job_id);
            if (job) {
              await job.remove();
            }
          } catch (error) {
            this.logger.warn(
              `Could not remove expired job ${post.job_id}:`,
              error,
            );
          }

          // Mark as failed in database
          await this.supabaseService
            .getServiceClient()
            .from('scheduled_posts')
            .update({ status: 'failed' })
            .eq('id', post.id);
        }

        // Reset content status — but NEVER downgrade content that is already
        // live on LinkedIn. Guarding on `linkedin_post_id IS NULL` prevents the
        // bug where an expired/failed stale schedule reset a published post back
        // to 'ready', which previously let it be scheduled + published again
        // (duplicate post on LinkedIn).
        await this.supabaseService
          .getServiceClient()
          .from('generated_content')
          .update({
            is_scheduled: false,
            publish_status: 'ready',
          })
          .eq('id', contentId)
          .is('linkedin_post_id', null);

        this.logger.log(
          `Cleaned up ${expiredPosts.length} expired scheduled posts for content ${contentId}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to cleanup expired scheduled posts for content ${contentId}:`,
        error,
      );
    }
  }

  async cancelScheduledPost(jobId: string, userId: string): Promise<void> {
    try {
      this.logger.log(`Cancelling scheduled post with job ID: ${jobId}`);

      // Remove job from queue
      try {
        const job = await this.publishQueue.getJob(jobId);
        if (job) {
          await job.remove();
        }
      } catch (error) {
        this.logger.warn(`Could not remove job ${jobId} from queue:`, error);
      }

      // Update database
      await this.supabaseService
        .getServiceClient()
        .from('scheduled_posts')
        .update({ status: 'cancelled' })
        .eq('job_id', jobId)
        .eq('user_id', userId);

      // Update content status
      const { data: scheduledPost } = await this.supabaseService
        .getServiceClient()
        .from('scheduled_posts')
        .select('content_id')
        .eq('job_id', jobId)
        .eq('user_id', userId)
        .single();

      if (scheduledPost) {
        await this.supabaseService
          .getServiceClient()
          .from('generated_content')
          .update({
            is_scheduled: false,
            scheduled_for: null,
            publish_status: 'draft',
          })
          .eq('id', scheduledPost.content_id);
      }

      this.logger.log(`Scheduled post cancelled successfully: ${jobId}`);
    } catch (error) {
      this.logger.error('Failed to cancel scheduled post:', error.message);
      throw error;
    }
  }

  async getScheduledPosts(userId: string, page = 1, limit = 20): Promise<any> {
    try {
      const offset = (page - 1) * limit;

      const { data, error, count } = await this.supabaseService
        .getServiceClient()
        .from('scheduled_posts')
        .select(
          `
          *,
          generated_content (
            id,
            title,
            content,
            visual_type,
            hashtags
          )
        `,
          { count: 'exact' },
        )
        .eq('user_id', userId)
        .in('status', ['scheduled', 'processing'])
        .order('scheduled_for', { ascending: true })
        .range(offset, offset + limit - 1);

      if (error) {
        this.logger.error('Failed to get scheduled posts:', error);
        throw new Error('Failed to get scheduled posts');
      }

      return {
        posts: data || [],
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      };
    } catch (error) {
      this.logger.error('Failed to get scheduled posts:', error.message);
      throw error;
    }
  }

  async getPublishedPosts(userId: string, page = 1, limit = 20): Promise<any> {
    try {
      const offset = (page - 1) * limit;

      const { data, error, count } = await this.supabaseService
        .getServiceClient()
        .from('generated_content')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .eq('publish_status', 'published')
        .order('published_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        this.logger.error('Failed to get published posts:', error);
        throw new Error('Failed to get published posts');
      }

      return {
        posts: data || [],
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      };
    } catch (error) {
      this.logger.error('Failed to get published posts:', error.message);
      throw error;
    }
  }
}
