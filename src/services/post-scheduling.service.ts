import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SupabaseService } from './supabase.service';
import { MediaGenerationService } from './media-generation.service';
import { LinkedinService } from './linkedin.service';
import { CacheService } from './cache.service';

export interface SchedulePostRequest {
  contentId: string;
  userId: string;
  scheduledFor: Date;
  platform: 'linkedin';
}

export interface PublishPostRequest {
  contentId: string;
  userId: string;
  platform: 'linkedin';
}

export interface PostContent {
  id: string;
  title: string;
  content: string;
  hashtags: string[];
  visual_type: 'text' | 'image' | 'carousel' | 'single';
  visual_url?: string;
  carousel_urls?: string[];
  user_id: string;
  publish_status?: string;
  linkedin_post_id?: string;
  is_scheduled?: boolean;
}

@Injectable()
export class PostSchedulingService {
  private readonly logger = new Logger(PostSchedulingService.name);

  constructor(
    @InjectQueue('post-publishing') private readonly publishQueue: Queue,
    private readonly supabaseService: SupabaseService,
    private readonly mediaGenerationService: MediaGenerationService,
    private readonly linkedinService: LinkedinService,
    private readonly cacheService: CacheService,
  ) {}

  async schedulePost(request: SchedulePostRequest): Promise<string> {
    try {
      this.logger.log(`Scheduling post ${request.contentId} for ${request.scheduledFor}`);

      // Check rate limit
      const canSchedule = await this.mediaGenerationService.checkRateLimit(
        request.userId,
        'post-scheduling'
      );

      if (!canSchedule) {
        throw new Error('Rate limit exceeded for post scheduling');
      }

      // Get content details
      const content = await this.getContentById(request.contentId);
      if (!content) {
        throw new Error('Content not found');
      }

      // Check if content is already published or scheduled
      if (content.publish_status === 'published' && content.linkedin_post_id) {
        throw new Error('This content has already been published to LinkedIn');
      }
      if (content.is_scheduled) {
        throw new Error('This content is already scheduled for publishing');
      }

      // Create BullMQ job
      const job = await this.publishQueue.add(
        'publish-scheduled-post',
        {
          contentId: request.contentId,
          userId: request.userId,
          platform: request.platform,
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
        }
      );

    // Save to database
    const { data, error } = await this.supabaseService.getServiceClient()
        .from('scheduled_posts')
        .insert({
          user_id: request.userId,
          content_id: request.contentId,
          job_id: job.id?.toString() || 'unknown',
          scheduled_for: request.scheduledFor.toISOString(),
          platform: request.platform,
          status: 'scheduled',
        })
        .select()
        .single();

      if (error) {
        this.logger.error('Failed to save scheduled post:', error);
        throw new Error('Failed to save scheduled post');
      }

      // Update content status
      await this.supabaseService.getServiceClient()
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

  async publishPostNow(request: PublishPostRequest): Promise<string> {
    try {
      this.logger.log(`Publishing post ${request.contentId} immediately`);

      // Check rate limit
      const canPublish = await this.mediaGenerationService.checkRateLimit(
        request.userId,
        'post-publishing'
      );

      if (!canPublish) {
        throw new Error('Rate limit exceeded for post publishing');
      }

      // Get content details
      const content = await this.getContentById(request.contentId);
      if (!content) {
        throw new Error('Content not found');
      }

      // Check if content is already published
      if (content.publish_status === 'published' && content.linkedin_post_id) {
        throw new Error('This content has already been published to LinkedIn');
      }

      // Publish based on content type with smart fallback
      let publishResult: any;
      
      // Determine actual content type based on available data
      const hasValidImage = content.visual_url && content.visual_url.startsWith('http');
      const hasCarousel = content.carousel_urls && content.carousel_urls.length > 0;
      
      if (hasCarousel) {
        publishResult = await this.publishCarouselPost(content);
      } else if (hasValidImage && (content.visual_type === 'image' || content.visual_type === 'single')) {
        publishResult = await this.publishImagePost(content);
      } else {
        // Default to text post for any other case
        this.logger.log(`Publishing as text post. Visual type: ${content.visual_type}, Has valid image: ${hasValidImage}`);
        publishResult = await this.publishTextPost(content);
      }

      // Update content status
      await this.supabaseService.getServiceClient()
        .from('generated_content')
        .update({
          publish_status: 'published',
          linkedin_post_id: publishResult.postId,
          published_at: new Date().toISOString(),
        })
        .eq('id', request.contentId);

      this.logger.log(`Post published successfully: ${publishResult.postId}`);
      return publishResult.postId;
    } catch (error) {
      this.logger.error('Failed to publish post:', error.message);
      
      // Update content status to failed
      await this.supabaseService.getServiceClient()
        .from('generated_content')
        .update({
          publish_status: 'failed',
        })
        .eq('id', request.contentId);

      throw error;
    }
  }

  private async publishTextPost(content: PostContent): Promise<{ postId: string }> {
    const text = this.formatPostText(content);
    
    const result = await this.linkedinService.publishPost({
      userId: content.user_id,
      text,
      mediaType: 'text',
    });

    return { postId: result.postId };
  }

  private async publishImagePost(content: PostContent): Promise<{ postId: string }> {
    // Check if we have a valid image URL
    if (!content.visual_url || !content.visual_url.startsWith('http')) {
      this.logger.warn(`Invalid image URL for content ${content.id}: ${content.visual_url}. Converting to text post.`);
      // Fallback to text post if image URL is invalid
      return await this.publishTextPost(content);
    }

    const text = this.formatPostText(content);
    
    const result = await this.linkedinService.publishPost({
      userId: content.user_id,
      text,
      mediaType: 'image',
      mediaUrl: content.visual_url,
    });

    return { postId: result.postId };
  }

  private async publishCarouselPost(content: PostContent): Promise<{ postId: string }> {
    if (!content.carousel_urls || content.carousel_urls.length === 0) {
      throw new Error('Carousel URLs not found for carousel post');
    }

    const text = this.formatPostText(content);
    
    const result = await this.linkedinService.publishPost({
      userId: content.user_id,
      text,
      mediaType: 'document',
      mediaUrl: content.carousel_urls[0], // PDF URL for carousel
    });

    return { postId: result.postId };
  }

  private formatPostText(content: PostContent): string {
    let text = content.content;
    
    if (content.hashtags && content.hashtags.length > 0) {
      const hashtags = Array.isArray(content.hashtags) 
        ? content.hashtags.join(' ')
        : content.hashtags;
      text += `\n\n${hashtags}`;
    }

    const formattedText = text.trim();
    this.logger.log(`Formatted post text (${formattedText.length} chars): ${formattedText.substring(0, 200)}...`);
    return formattedText;
  }

  private async getContentById(contentId: string): Promise<PostContent | null> {
    try {
      const { data, error } = await this.supabaseService.getServiceClient()
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
      await this.supabaseService.getServiceClient()
        .from('scheduled_posts')
        .update({ status: 'cancelled' })
        .eq('job_id', jobId)
        .eq('user_id', userId);

      // Update content status
      const { data: scheduledPost } = await this.supabaseService.getServiceClient()
        .from('scheduled_posts')
        .select('content_id')
        .eq('job_id', jobId)
        .eq('user_id', userId)
        .single();

      if (scheduledPost) {
        await this.supabaseService.getServiceClient()
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

      const { data, error, count } = await this.supabaseService.getServiceClient()
        .from('scheduled_posts')
        .select(`
          *,
          generated_content (
            id,
            title,
            content,
            visual_type,
            hashtags
          )
        `, { count: 'exact' })
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

      const { data, error, count } = await this.supabaseService.getServiceClient()
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