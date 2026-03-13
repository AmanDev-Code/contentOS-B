import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PostSchedulingService } from '../services/post-scheduling.service';
import { SupabaseService } from '../services/supabase.service';

interface PublishJobData {
  contentId: string;
  userId: string;
  platform: string;
}

@Processor('post-publishing')
export class PostPublishingProcessor extends WorkerHost {
  private readonly logger = new Logger(PostPublishingProcessor.name);

  constructor(
    private readonly postSchedulingService: PostSchedulingService,
    private readonly supabaseService: SupabaseService,
  ) {
    super();
  }

  async process(job: Job<PublishJobData>) {
    if (job.name !== 'publish-scheduled-post') return;
    
    return this.handleScheduledPost(job);
  }

  async handleScheduledPost(job: Job<PublishJobData>) {
    this.logger.log(`Processing scheduled post job: ${job.id || 'unknown'}`);

    try {
      const { contentId, userId, platform } = job.data;

      // Update job status to processing
      await this.updateScheduledPostStatus(job.id?.toString() || 'unknown', 'processing');

      // Publish the post
      const postId = await this.postSchedulingService.publishPostNow({
        contentId,
        userId,
        platform: platform as 'linkedin',
      });

      // Update job status to published
      await this.updateScheduledPostStatus(job.id?.toString() || 'unknown', 'published', postId);

      this.logger.log(`Scheduled post published successfully: ${postId}`);
      return { success: true, postId };
    } catch (error) {
      this.logger.error(`Failed to publish scheduled post: ${error.message}`);
      
      // Update job status to failed
      await this.updateScheduledPostStatus(job.id?.toString() || 'unknown', 'failed', undefined, error.message);
      
      throw error;
    }
  }

  private async updateScheduledPostStatus(
    jobId: string,
    status: string,
    linkedinPostId?: string,
    errorMessage?: string,
  ) {
    try {
      const updateData: any = {
        status,
        updated_at: new Date().toISOString(),
      };

      if (status === 'published') {
        updateData.published_at = new Date().toISOString();
      }

      if (errorMessage) {
        updateData.error_message = errorMessage;
        updateData.retry_count = await this.incrementRetryCount(jobId);
      }

      await this.supabaseService.getServiceClient()
        .from('scheduled_posts')
        .update(updateData)
        .eq('job_id', jobId);

      this.logger.log(`Updated scheduled post status: ${jobId} -> ${status}`);
    } catch (error) {
      this.logger.error(`Failed to update scheduled post status: ${error.message}`);
    }
  }

  private async incrementRetryCount(jobId: string): Promise<number> {
    try {
      const { data } = await this.supabaseService.getServiceClient()
        .from('scheduled_posts')
        .select('retry_count')
        .eq('job_id', jobId)
        .single();

      return (data?.retry_count || 0) + 1;
    } catch (error) {
      this.logger.error(`Failed to get retry count: ${error.message}`);
      return 1;
    }
  }
}