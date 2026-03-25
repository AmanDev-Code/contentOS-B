import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { PostSchedulingService } from '../services/post-scheduling.service';
import { QuotaService } from '../services/quota.service';
import { NotificationService } from '../services/notification.service';
import { CacheService } from '../services/cache.service';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
  };
}

@Controller('posts')
@UseGuards(AuthGuard, PaywallGuard)
export class PostsController {
  private readonly logger = new Logger(PostsController.name);

  constructor(
    private readonly postSchedulingService: PostSchedulingService,
    private readonly quotaService: QuotaService,
    private readonly notificationService: NotificationService,
    private readonly cacheService: CacheService,
  ) {}

  @Post('publish')
  async publishPost(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      contentId: string;
      platform?: string;
      content?: string;
      mediaUrls?: string[];
      hashtags?: string[];
    },
  ) {
    try {
      const userId = req.user.id;
      const {
        contentId,
        platform = 'linkedin',
        content,
        mediaUrls,
        hashtags,
      } = body;

      // Determine credit cost based on content type
      let creditCost = 2.5; // Default for text post

      // Get content to determine type
      const contentData = await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('generated_content')
        .select('visual_type, visual_url, carousel_urls, media_urls')
        .eq('id', contentId)
        .eq('user_id', userId)
        .single();

      // Determine content type and cost
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

      if (contentData.data) {
        if (hasCarousel) {
          creditCost = 12; // Carousel post now
        } else if (hasValidImage) {
          creditCost = 6; // Image post now
        }
        // Text post remains 2.5
      }

      // Check quota
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

      // IMMEDIATE CREDIT DEDUCTION - Charge upfront to prevent exploitation
      const contentType = hasCarousel
        ? 'carousel'
        : hasValidImage
          ? 'image'
          : 'text';
      await this.quotaService.consumeCredits(
        userId,
        creditCost,
        `Post publishing initiated (${creditCost} credits)`,
        'post_now',
        contentType,
        contentId,
      );

      // Update content if custom data provided
      if (content || mediaUrls || hashtags) {
        const updateData: any = {};
        if (content) updateData.content = content;
        if (hashtags) updateData.hashtags = hashtags;
        if (mediaUrls && mediaUrls.length > 0) {
          updateData.visual_url = mediaUrls[0]; // Use first image as primary
          updateData.media_urls = mediaUrls;
        }

        await this.postSchedulingService['supabaseService']
          .getServiceClient()
          .from('generated_content')
          .update(updateData)
          .eq('id', contentId)
          .eq('user_id', userId);
      }

      // Update status to 'publishing'
      await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('generated_content')
        .update({
          publish_status: 'publishing',
          updated_at: new Date().toISOString(),
        })
        .eq('id', contentId)
        .eq('user_id', userId);

      try {
        // Publish post immediately
        const postId = await this.postSchedulingService.publishPostNow({
          contentId,
          userId,
          platform: platform as 'linkedin',
        });

        // Update status to 'published' on success
        await this.postSchedulingService['supabaseService']
          .getServiceClient()
          .from('generated_content')
          .update({
            publish_status: 'published',
            linkedin_post_id: postId || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', contentId)
          .eq('user_id', userId);

        // Update transaction description to reflect success
        await this.quotaService.logTransaction(
          userId,
          contentId,
          'debit',
          0, // No additional charge
          `Post published successfully (${creditCost} credits total)`,
          'post_now',
          contentType,
        );

        // Get content title for notification
        const contentData = await this.postSchedulingService['supabaseService']
          .getServiceClient()
          .from('generated_content')
          .select('title')
          .eq('id', contentId)
          .single();

        const contentTitle = contentData.data?.title || 'Your post';

        // Invalidate cache
        await this.cacheService.invalidateUser(userId);

        // SEND SUCCESS NOTIFICATION
        await this.notificationService.notifyPostPublished(
          userId,
          contentId,
          contentTitle,
          postId,
        );

        return {
          success: true,
          postId,
          message: 'Post published successfully',
        };
      } catch (publishError) {
        // Update status to 'failed' on error
        await this.postSchedulingService['supabaseService']
          .getServiceClient()
          .from('generated_content')
          .update({
            publish_status: 'failed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', contentId)
          .eq('user_id', userId);

        // REFUND CREDITS if publishing fails
        await this.quotaService.consumeCredits(
          userId,
          -creditCost, // Negative amount = refund
          `Refund for failed post publishing (${creditCost} credits)`,
          'refund',
          contentType,
          contentId,
        );

        // Get content title for notification
        const contentData = await this.postSchedulingService['supabaseService']
          .getServiceClient()
          .from('generated_content')
          .select('title')
          .eq('id', contentId)
          .single();

        const contentTitle = contentData.data?.title || 'Your post';

        // SEND FAILURE NOTIFICATION
        await this.notificationService.notifyPostPublishFailed(
          userId,
          contentId,
          contentTitle,
          publishError.message || 'Unknown error',
          creditCost,
        );

        throw publishError;
      }
    } catch (error) {
      this.logger.error('Failed to publish post:', error.message);
      throw new HttpException(
        error.message || 'Failed to publish post',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('schedule')
  async schedulePost(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      contentId: string;
      scheduledFor: string;
      platform?: string;
      content?: string;
      mediaUrls?: string[];
      hashtags?: string[];
    },
  ) {
    try {
      const userId = req.user.id;
      const {
        contentId,
        scheduledFor,
        platform = 'linkedin',
        content,
        mediaUrls,
        hashtags,
      } = body;

      // Validate scheduled time
      const scheduledDate = new Date(scheduledFor);
      const now = new Date();

      if (scheduledDate <= now) {
        throw new HttpException(
          'Scheduled time must be in the future',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Check if scheduled time is not too far in the future (e.g., 1 year)
      const maxFutureDate = new Date();
      maxFutureDate.setFullYear(maxFutureDate.getFullYear() + 1);

      if (scheduledDate > maxFutureDate) {
        throw new HttpException(
          'Scheduled time cannot be more than 1 year in the future',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Determine credit cost based on content type (scheduling costs more)
      let creditCost = 4; // Default for text post scheduling

      // Get content to determine type
      const contentData = await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('generated_content')
        .select('visual_type, visual_url, carousel_urls, media_urls')
        .eq('id', contentId)
        .eq('user_id', userId)
        .single();

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

      if (contentData.data) {
        if (hasCarousel) {
          creditCost = 15; // Carousel scheduling
        } else if (hasValidImage) {
          creditCost = 7.5; // Image scheduling
        }
        // Text post remains 4
      }

      // Check quota (scheduling costs more than immediate posting)
      const hasQuota = await this.quotaService.checkQuotaAvailable(
        userId,
        creditCost,
      );
      if (!hasQuota) {
        throw new HttpException(
          `Insufficient credits. Scheduling requires ${creditCost} credits. Please upgrade your plan.`,
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      // IMMEDIATE CREDIT DEDUCTION - Charge upfront for scheduling
      const scheduleContentType = hasCarousel
        ? 'carousel'
        : hasValidImage
          ? 'image'
          : 'text';
      await this.quotaService.consumeCredits(
        userId,
        creditCost,
        `Post scheduling initiated for ${scheduledDate.toISOString()} (${creditCost} credits)`,
        'schedule',
        scheduleContentType,
        contentId,
      );

      // Update content if custom data provided
      if (content || mediaUrls || hashtags) {
        const updateData: any = {};
        if (content) updateData.content = content;
        if (hashtags) updateData.hashtags = hashtags;
        if (mediaUrls && mediaUrls.length > 0) {
          updateData.visual_url = mediaUrls[0]; // Use first image as primary
          updateData.media_urls = mediaUrls;
        }

        await this.postSchedulingService['supabaseService']
          .getServiceClient()
          .from('generated_content')
          .update(updateData)
          .eq('id', contentId)
          .eq('user_id', userId);
      }

      try {
        // Schedule post (service handles cancelling old entries)
        const jobId = await this.postSchedulingService.schedulePost({
          contentId,
          userId,
          scheduledFor: scheduledDate,
          platform: platform as 'linkedin',
        });

        // Update transaction description to reflect successful scheduling
        await this.quotaService.logTransaction(
          userId,
          contentId,
          'debit',
          0, // No additional charge
          `Post scheduled successfully for ${scheduledDate.toISOString()} (${creditCost} credits total)`,
          'schedule',
          scheduleContentType,
        );

        // Get content title for notification
        const contentData = await this.postSchedulingService['supabaseService']
          .getServiceClient()
          .from('generated_content')
          .select('title')
          .eq('id', contentId)
          .single();

        const contentTitle = contentData.data?.title || 'Your post';

        // Invalidate scheduled posts cache
        await this.cacheService.invalidateUser(userId);

        // SEND SCHEDULING SUCCESS NOTIFICATION
        await this.notificationService.notifyPostScheduled(
          userId,
          contentId,
          contentTitle,
          scheduledDate.toISOString(),
        );

        return {
          success: true,
          jobId,
          scheduledFor: scheduledDate.toISOString(),
          message: 'Post scheduled successfully',
        };
      } catch (scheduleError) {
        // Update status back to 'ready' on scheduling failure
        await this.postSchedulingService['supabaseService']
          .getServiceClient()
          .from('generated_content')
          .update({
            publish_status: 'ready',
            scheduled_for: null,
            is_scheduled: false,
            updated_at: new Date().toISOString(),
          })
          .eq('id', contentId)
          .eq('user_id', userId);

        // REFUND CREDITS if scheduling fails
        await this.quotaService.consumeCredits(
          userId,
          -creditCost, // Negative amount = refund
          `Refund for failed post scheduling (${creditCost} credits)`,
          'refund',
          scheduleContentType,
          contentId,
        );

        throw scheduleError;
      }
    } catch (error) {
      this.logger.error('Failed to schedule post:', error.message);
      throw new HttpException(
        error.message || 'Failed to schedule post',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('draft')
  async saveDraft(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      contentId: string;
      content?: string;
      hashtags?: string[];
      mediaUrls?: string[];
    },
  ) {
    try {
      const userId = req.user.id;
      const { contentId, content, hashtags, mediaUrls } = body;

      // Update content as draft
      const updateData: any = {
        publish_status: 'draft',
        updated_at: new Date().toISOString(),
      };

      if (content) updateData.content = content;
      if (hashtags) updateData.hashtags = hashtags;
      if (mediaUrls && mediaUrls.length > 0) {
        updateData.visual_url = mediaUrls[0];
        updateData.media_urls = mediaUrls;
      }

      await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('generated_content')
        .update(updateData)
        .eq('id', contentId)
        .eq('user_id', userId);

      return {
        success: true,
        message: 'Draft saved successfully',
      };
    } catch (error) {
      this.logger.error('Failed to save draft:', error.message);
      throw new HttpException(
        error.message || 'Failed to save draft',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }


  @Get('calendar')
  async getCalendarPosts(
    @Request() req: AuthenticatedRequest,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    try {
      const userId = req.user.id;

      // Default to current month if no dates provided
      const startDate = start
        ? new Date(start)
        : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const endDate = end
        ? new Date(end)
        : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);

      // Get scheduled posts in date range
      const { data: scheduledPosts, error: scheduledError } =
        await this.postSchedulingService['supabaseService']
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
          )
          .eq('user_id', userId)
          .gte('scheduled_for', startDate.toISOString())
          .lte('scheduled_for', endDate.toISOString())
          .in('status', ['scheduled', 'processing']);

      if (scheduledError) {
        throw new HttpException(
          'Failed to get scheduled posts',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Get published posts in date range
      const { data: publishedPosts, error: publishedError } =
        await this.postSchedulingService['supabaseService']
          .getServiceClient()
          .from('generated_content')
          .select('*')
          .eq('user_id', userId)
          .eq('publish_status', 'published')
          .gte('published_at', startDate.toISOString())
          .lte('published_at', endDate.toISOString());

      if (publishedError) {
        throw new HttpException(
          'Failed to get published posts',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Format for calendar
      const calendarEvents = [
        ...(scheduledPosts || []).map((post) => ({
          id: post.id,
          title: post.generated_content?.title || 'Scheduled Post',
          start: post.scheduled_for,
          type: 'scheduled',
          status: post.status,
          content: post.generated_content,
        })),
        ...(publishedPosts || []).map((post) => ({
          id: post.id,
          title: post.title || 'Published Post',
          start: post.published_at,
          type: 'published',
          status: 'published',
          content: post,
        })),
      ];

      return {
        success: true,
        events: calendarEvents,
        dateRange: {
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        },
      };
    } catch (error) {
      this.logger.error('Failed to get calendar posts:', error.message);
      throw new HttpException(
        error.message || 'Failed to get calendar posts',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('analytics')
  async getPostAnalytics(
    @Request() req: AuthenticatedRequest,
    @Query('period') period = '30d',
  ) {
    try {
      const userId = req.user.id;

      // Calculate date range based on period
      const endDate = new Date();
      const startDate = new Date();

      switch (period) {
        case '7d':
          startDate.setDate(startDate.getDate() - 7);
          break;
        case '30d':
          startDate.setDate(startDate.getDate() - 30);
          break;
        case '90d':
          startDate.setDate(startDate.getDate() - 90);
          break;
        default:
          startDate.setDate(startDate.getDate() - 30);
      }

      // Get published posts analytics
      const { data: publishedPosts, error } = await this.postSchedulingService[
        'supabaseService'
      ]
        .getServiceClient()
        .from('generated_content')
        .select('*')
        .eq('user_id', userId)
        .eq('publish_status', 'published')
        .gte('published_at', startDate.toISOString())
        .lte('published_at', endDate.toISOString());

      if (error) {
        throw new HttpException(
          'Failed to get post analytics',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Calculate analytics
      const totalPosts = publishedPosts?.length || 0;
      const postsByType = (publishedPosts || []).reduce(
        (acc, post) => {
          acc[post.visual_type] = (acc[post.visual_type] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      const postsByDay = (publishedPosts || []).reduce(
        (acc, post) => {
          const day = new Date(post.published_at).toISOString().split('T')[0];
          acc[day] = (acc[day] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      return {
        success: true,
        analytics: {
          totalPosts,
          postsByType,
          postsByDay,
          period,
          dateRange: {
            start: startDate.toISOString(),
            end: endDate.toISOString(),
          },
        },
      };
    } catch (error) {
      this.logger.error('Failed to get post analytics:', error.message);
      throw new HttpException(
        error.message || 'Failed to get post analytics',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('scheduled')
  @ApiOperation({ summary: 'Get scheduled posts with pagination' })
  async getScheduledPosts(
    @Request() req: AuthenticatedRequest,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const userId = req.user.id;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20));
    const offset = (pageNum - 1) * limitNum;

    try {
      // Check cache
      const cacheKey = `user:${userId}:scheduled:${pageNum}:${limitNum}:${status || 'all'}:${search || ''}`;
      const cached = await this.cacheService.get(cacheKey);
      if (cached) return cached;

      let query = this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('scheduled_posts')
        .select(`
          *,
          generated_content (
            id,
            title,
            content,
            hashtags,
            visual_url,
            ai_score
          )
        `)
        .eq('user_id', userId)
        .order('scheduled_for', { ascending: true });

      // Apply status filter
      if (status && status !== 'all') {
        query = query.eq('status', status);
      }

      // Get total count
      const countQuery = this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('scheduled_posts')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);
        
      if (search) {
        countQuery.or(`generated_content.title.ilike.%${search}%,generated_content.content.ilike.%${search}%`);
      }
      
      if (status) {
        countQuery.eq('status', status);
      }
      
      const { count } = await countQuery;

      // Get paginated data
      const { data, error } = await query.range(offset, offset + limitNum - 1);

      if (error) {
        throw new Error(`Failed to fetch scheduled posts: ${error.message}`);
      }

      const totalPages = Math.ceil((count || 0) / limitNum);

      const result = {
        data: data || [],
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: count || 0,
          totalPages,
          hasMore: pageNum < totalPages,
          hasPrev: pageNum > 1,
        },
      };

      // Cache for 60s
      await this.cacheService.set(cacheKey, result, 60);

      return result;
    } catch (error) {
      this.logger.error('Failed to fetch scheduled posts:', error.message);
      throw new HttpException(
        'Failed to fetch scheduled posts',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('scheduled/:id/cancel')
  @ApiOperation({ summary: 'Cancel a scheduled post' })
  async cancelScheduledPost(
    @Request() req: AuthenticatedRequest,
    @Param('id') postId: string,
  ) {
    const userId = req.user.id;

    try {
      // Verify ownership
      const { data: scheduledPost, error: fetchError } = await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('scheduled_posts')
        .select('*')
        .eq('id', postId)
        .eq('user_id', userId)
        .single();

      if (fetchError || !scheduledPost) {
        throw new HttpException('Scheduled post not found', HttpStatus.NOT_FOUND);
      }

      if (scheduledPost.status !== 'scheduled') {
        throw new HttpException('Post cannot be cancelled', HttpStatus.BAD_REQUEST);
      }

      // Update status to cancelled
      const { error: updateError } = await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('scheduled_posts')
        .update({ 
          status: 'cancelled',
          updated_at: new Date().toISOString(),
        })
        .eq('id', postId);

      if (updateError) {
        throw new Error(`Failed to cancel post: ${updateError.message}`);
      }

      await this.cacheService.invalidateUser(userId);

      return {
        success: true,
        message: 'Post cancelled successfully',
      };
    } catch (error) {
      this.logger.error('Failed to cancel scheduled post:', error.message);
      throw new HttpException(
        error.message || 'Failed to cancel scheduled post',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('scheduled/:id')
  @ApiOperation({ summary: 'Delete a scheduled post' })
  async deleteScheduledPost(
    @Request() req: AuthenticatedRequest,
    @Param('id') postId: string,
  ) {
    const userId = req.user.id;

    try {
      // Verify ownership and status
      const { data: scheduledPost, error: fetchError } = await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('scheduled_posts')
        .select('*')
        .eq('id', postId)
        .eq('user_id', userId)
        .single();

      if (fetchError || !scheduledPost) {
        throw new HttpException('Scheduled post not found', HttpStatus.NOT_FOUND);
      }

      if (scheduledPost.status === 'scheduled' || scheduledPost.status === 'processing') {
        throw new HttpException('Cannot delete active scheduled post. Cancel it first.', HttpStatus.BAD_REQUEST);
      }

      // Delete the scheduled post
      const { error: deleteError } = await this.postSchedulingService['supabaseService']
        .getServiceClient()
        .from('scheduled_posts')
        .delete()
        .eq('id', postId);

      if (deleteError) {
        throw new Error(`Failed to delete post: ${deleteError.message}`);
      }

      await this.cacheService.invalidateUser(userId);

      return {
        success: true,
        message: 'Post deleted successfully',
      };
    } catch (error) {
      this.logger.error('Failed to delete scheduled post:', error.message);
      throw new HttpException(
        error.message || 'Failed to delete scheduled post',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
