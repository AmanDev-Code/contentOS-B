import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostSchedulingService } from './post-scheduling.service';
import { QuotaService } from './quota.service';
import { NotificationService } from './notification.service';
import { CacheService } from './cache.service';
import { IdempotencyService } from './idempotency.service';
import { ContentStatus } from '../common/types';
import { FeedbackService } from './feedback.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { postNowCost } from '../modules/credits/credit-costs';

export interface ImmediatePublishParams {
  userId: string;
  contentId: string;
  platform?: string;
  actorType?: 'member' | 'organization';
  organizationUrn?: string;
  content?: string;
  mediaUrls?: string[];
  hashtags?: string[];
  idempotencyKey?: string;
  pdfUrl?: string;
}

@Injectable()
export class ImmediatePostPublishService {
  private readonly logger = new Logger(ImmediatePostPublishService.name);

  constructor(
    private readonly postSchedulingService: PostSchedulingService,
    private readonly quotaService: QuotaService,
    private readonly notificationService: NotificationService,
    private readonly cacheService: CacheService,
    private readonly idempotencyService: IdempotencyService,
    private readonly configService: ConfigService,
    private readonly feedbackService: FeedbackService,
    private readonly webhookDispatcher: WebhookDispatcherService,
  ) {}

  async publishImmediate(params: ImmediatePublishParams): Promise<{
    success: boolean;
    postId: string;
    message: string;
    feedbackPromptSuggested?: boolean;
  }> {
    const {
      userId,
      contentId,
      platform = 'linkedin',
      content,
      actorType,
      organizationUrn,
      mediaUrls,
      hashtags,
      idempotencyKey,
      pdfUrl,
    } = params;

    if (
      actorType === 'organization' &&
      !this.configService.get<boolean>('features.linkedinOrgPublishing', true)
    ) {
      throw new HttpException(
        'Organization publishing is disabled',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (idempotencyKey) {
      const existing = await this.idempotencyService.getResult(
        'posts-publish',
        idempotencyKey,
        userId,
      );
      if (existing?.status === 'completed' && existing.result) {
        return existing.result as {
          success: boolean;
          postId: string;
          message: string;
        };
      }
      const locked = await this.idempotencyService.lock(
        'posts-publish',
        idempotencyKey,
        userId,
      );
      if (!locked) {
        throw new HttpException(
          'Duplicate request in progress',
          HttpStatus.CONFLICT,
        );
      }
    }

    const contentData = await this.postSchedulingService['supabaseService']
      .getServiceClient()
      .from('generated_content')
      .select(
        'visual_type, visual_url, carousel_urls, media_urls, linkedin_post_id',
      )
      .eq('id', contentId)
      .eq('user_id', userId)
      .single();

    // Durable duplicate guard (before charging credits / changing status): if the
    // content already has a LinkedIn post ID it is live on LinkedIn — block here
    // so we never charge+refund credits, downgrade publish_status to
    // failed, or emit a false "Publishing Failed" notification.
    if (contentData.data?.linkedin_post_id) {
      throw new ConflictException({
        message: 'This post has already been published to LinkedIn.',
        code: 'post_already_published',
      });
    }

    await this.postSchedulingService.validateLinkedInPostForPublish(
      userId,
      contentId,
      { content, hashtags },
    );

    const hasValidImage = Boolean(
      contentData.data?.visual_url?.startsWith('http') ||
      (contentData.data?.media_urls &&
        contentData.data.media_urls.length > 0) ||
      (mediaUrls && mediaUrls.length > 0),
    );
    const hasCarousel = Boolean(
      contentData.data?.carousel_urls &&
      contentData.data.carousel_urls.length > 0,
    );

    // Single source of truth: credit-costs.ts. Post Now image/carousel costs
    // are FLAT (do not scale by count); PDF adds a flat add-on.
    const publishContentType = hasCarousel
      ? 'carousel'
      : hasValidImage
        ? 'image'
        : 'text';
    const creditCost = postNowCost(publishContentType, {
      pdf: Boolean(pdfUrl),
    });

    const hasQuota = await this.quotaService.checkQuotaAvailable(
      userId,
      creditCost,
    );
    if (!hasQuota) {
      throw new HttpException(
        `Insufficient credits. This action requires ${creditCost} credits. Please upgrade your plan.`,
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const contentType = publishContentType;
    const operationId = idempotencyKey || `publish:${contentId}:${Date.now()}`;
    await this.quotaService.debitOnce({
      userId,
      operationId,
      amount: creditCost,
      description: `Post publishing initiated (${creditCost} credits)`,
      operationType: 'post_now',
      contentType,
      contentId,
    });

    if (content || mediaUrls || hashtags || pdfUrl) {
      const updateData: Record<string, unknown> = {};
      if (content) updateData.content = content;
      if (hashtags) updateData.hashtags = hashtags;
      if (mediaUrls && mediaUrls.length > 0) {
        updateData.visual_url = mediaUrls[0];
        updateData.media_urls = mediaUrls;
      }
      if (pdfUrl) {
        updateData.pdf_url = pdfUrl;
      }

      await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('generated_content')
        .update(updateData)
        .eq('id', contentId)
        .eq('user_id', userId);
    }

    await this.postSchedulingService['supabaseService']
      .getServiceClient()
      .from('generated_content')
      .update({
        publish_status: 'publishing',
        status: ContentStatus.PUBLISHING,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contentId)
      .eq('user_id', userId);

    try {
      const postId = await this.postSchedulingService.publishPostNow({
        contentId,
        userId,
        platform: platform as 'linkedin',
        actorType,
        organizationUrn,
      });

      await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('generated_content')
        .update({
          publish_status: 'published',
          status: ContentStatus.PUBLISHED,
          linkedin_post_id: postId || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', contentId)
        .eq('user_id', userId);

      await this.quotaService.logTransaction(
        userId,
        contentId,
        'debit',
        0,
        `Post published successfully (${creditCost} credits total)`,
        'post_now',
        contentType,
      );

      const titleRow = await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('generated_content')
        .select('title')
        .eq('id', contentId)
        .single();

      const contentTitle = titleRow.data?.title || 'Your post';

      await this.cacheService.invalidateUser(userId);

      await this.notificationService.notifyPostPublished(
        userId,
        contentId,
        contentTitle,
        postId,
      );

      try {
        await this.webhookDispatcher.emitPostPublished({
          userId,
          contentId,
          platform,
          postId,
        });
      } catch {
        // best-effort — webhook failure must never block publish
      }

      const fb = await this.feedbackService.recordFirstAction(userId);

      const result = {
        success: true,
        postId,
        message: 'Post published successfully',
        feedbackPromptSuggested: fb.promptSuggested,
      };
      if (idempotencyKey) {
        await this.idempotencyService.setResult(
          'posts-publish',
          idempotencyKey,
          userId,
          result,
        );
      }
      return result;
    } catch (publishError) {
      await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('generated_content')
        .update({
          publish_status: 'failed',
          status: ContentStatus.FAILED,
          updated_at: new Date().toISOString(),
        })
        .eq('id', contentId)
        .eq('user_id', userId);

      await this.quotaService.refundOnce({
        userId,
        operationId,
        amount: creditCost,
        description: `Refund for failed post publishing (${creditCost} credits)`,
        operationType: 'refund',
        contentType,
        contentId,
      });

      const titleRow = await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('generated_content')
        .select('title')
        .eq('id', contentId)
        .single();

      const contentTitle = titleRow.data?.title || 'Your post';

      await this.notificationService.notifyPostPublishFailed(
        userId,
        contentId,
        contentTitle,
        (publishError as Error).message || 'Unknown error',
        creditCost,
      );

      try {
        await this.webhookDispatcher.emitPostFailed({
          userId,
          contentId,
          platform,
          error: (publishError as Error).message || 'Unknown error',
        });
      } catch {
        // best-effort
      }

      throw publishError;
    }
  }
}
