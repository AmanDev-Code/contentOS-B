import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../common/constants';
import { SupabaseService } from '../services/supabase.service';

const MAX_SWEEP_RETRIES = 3;
const OVERDUE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes grace period

@Injectable()
export class MissedBlogSweeperCronService {
  private readonly logger = new Logger(MissedBlogSweeperCronService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.BLOG_PUBLISH)
    private readonly blogPublishQueue: Queue,
    private readonly supabaseService: SupabaseService,
  ) {}

  @Cron('*/15 * * * *', { name: 'missed-blog-sweeper' })
  async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - OVERDUE_THRESHOLD_MS).toISOString();
    const client = this.supabaseService.getServiceClient();

    // Find blog posts that should have been published but weren't
    const { data: overdue, error } = await client
      .from('blog_posts')
      .select('id, scheduled_publish_at, settings')
      .eq('status', 'scheduled')
      .lt('scheduled_publish_at', cutoff)
      .order('scheduled_publish_at', { ascending: true })
      .limit(50);

    if (error) {
      this.logger.error(`Blog sweeper query failed: ${error.message}`);
      return;
    }

    if (!overdue || overdue.length === 0) {
      this.logger.debug('Missed-blog sweeper: no overdue posts found');
      return;
    }

    this.logger.log(
      `Missed-blog sweeper found ${overdue.length} overdue post(s)`,
    );

    for (const post of overdue) {
      const settings = (post.settings as Record<string, unknown>) ?? {};
      const retryCount =
        typeof settings.sweep_retry_count === 'number'
          ? settings.sweep_retry_count
          : 0;

      // Already exhausted — skip (requires manual intervention)
      if (settings.sweep_exhausted === true) {
        continue;
      }

      if (retryCount >= MAX_SWEEP_RETRIES) {
        this.logger.warn(
          `Blog post ${post.id} exceeded ${MAX_SWEEP_RETRIES} sweep retries — marking sweep_exhausted`,
        );
        const updatedSettings = { ...settings, sweep_exhausted: true };
        await client
          .from('blog_posts')
          .update({
            settings: updatedSettings,
            updated_at: new Date().toISOString(),
          })
          .eq('id', post.id);
        continue;
      }

      try {
        // Increment retry count before enqueue (prevents double-pick on next sweep)
        const updatedSettings = {
          ...settings,
          sweep_retry_count: retryCount + 1,
          last_sweep_at: new Date().toISOString(),
        };
        await client
          .from('blog_posts')
          .update({
            settings: updatedSettings,
            updated_at: new Date().toISOString(),
          })
          .eq('id', post.id);

        await this.blogPublishQueue.add(
          'publish-blog-post',
          { blogPostId: post.id },
          {
            jobId: `blog-sweep-${post.id}-${Date.now()}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );

        this.logger.log(
          `Re-enqueued overdue blog post ${post.id} (sweep attempt ${retryCount + 1})`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to re-enqueue blog post ${post.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
