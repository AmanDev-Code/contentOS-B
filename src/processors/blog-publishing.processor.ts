import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SupabaseService } from '../services/supabase.service';
import { QUEUE_NAMES } from '../common/constants';

export interface BlogPublishJobData {
  blogPostId: string;
}

@Processor(QUEUE_NAMES.BLOG_PUBLISH)
export class BlogPublishingProcessor extends WorkerHost {
  private readonly logger = new Logger(BlogPublishingProcessor.name);

  constructor(private readonly supabaseService: SupabaseService) {
    super();
  }

  async process(job: Job<BlogPublishJobData>): Promise<{ success: boolean; idempotent?: boolean }> {
    const { blogPostId } = job.data;
    this.logger.log(
      `Processing blog publish job for post ${blogPostId} (jobId=${job.id})`,
    );

    const client = this.supabaseService.getServiceClient();

    // 1. Fetch current state (idempotency check)
    const { data: post, error: fetchErr } = await client
      .from('blog_posts')
      .select('id, status, published_at')
      .eq('id', blogPostId)
      .maybeSingle();

    if (fetchErr) {
      this.logger.error(
        `Failed to fetch blog post ${blogPostId}: ${fetchErr.message}`,
      );
      throw fetchErr; // retryable
    }

    if (!post) {
      this.logger.warn(
        `Blog post ${blogPostId} not found — may have been deleted. Skipping.`,
      );
      return { success: true, idempotent: true };
    }

    // 2. Idempotency: already published
    if (post.status === 'published') {
      this.logger.log(
        `Blog post ${blogPostId} already published; skipping (idempotent).`,
      );
      return { success: true, idempotent: true };
    }

    // 3. Guard: only transition from 'scheduled'
    if (post.status !== 'scheduled') {
      this.logger.warn(
        `Blog post ${blogPostId} status is '${post.status}', not 'scheduled'; skipping.`,
      );
      return { success: true, idempotent: true };
    }

    // 4. Transition: scheduled → published (optimistic lock on status)
    const now = new Date().toISOString();
    const { error: updateErr, count } = await client
      .from('blog_posts')
      .update({ status: 'published', published_at: now, updated_at: now })
      .eq('id', blogPostId)
      .eq('status', 'scheduled'); // optimistic lock

    if (updateErr) {
      this.logger.error(
        `Failed to publish blog post ${blogPostId}: ${updateErr.message}`,
      );
      throw updateErr; // retryable — BullMQ will retry
    }

    if (count === 0) {
      // Another process already transitioned it (race condition — harmless)
      this.logger.log(
        `Blog post ${blogPostId} was already transitioned by another process.`,
      );
      return { success: true, idempotent: true };
    }

    this.logger.log(`✅ Blog post ${blogPostId} published successfully at ${now}`);
    return { success: true };
  }
}
