import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../common/constants';
import { SupabaseService } from '../services/supabase.service';

/**
 * Sweeps for scheduled posts that were missed — their scheduled_for time has
 * passed but they remain in 'pending' or 'processing' status, indicating the
 * BullMQ job either never fired or was lost (Redis flush, pod restart, etc.).
 *
 * Runs every 15 minutes. For each overdue post it re-enqueues a publish job
 * with the same data shape the original scheduler would have used.
 *
 * Safety:
 *   - Only picks up posts whose scheduled_for is > 5 min ago AND status is
 *     still 'pending' or 'processing' (never re-enqueues published or failed).
 *   - Sets status to 'retrying' before enqueue so the next sweep won't
 *     double-pick. If the enqueue itself fails, status is set back to 'pending'.
 *   - A post that has already been swept 3+ times without success is marked
 *     'failed' with a descriptive error (prevents infinite retry loops).
 */
const MAX_SWEEP_RETRIES = 3;
const OVERDUE_THRESHOLD_MS = 5 * 60 * 1000;

@Injectable()
export class MissedPostSweeperCronService {
  private readonly logger = new Logger(MissedPostSweeperCronService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.SOCIAL_PUBLISH)
    private readonly publishQueue: Queue,
    private readonly supabaseService: SupabaseService,
  ) {}

  @Cron('*/15 * * * *', { name: 'missed-post-sweeper' })
  async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - OVERDUE_THRESHOLD_MS).toISOString();

    const { data: overdue, error } = await this.supabaseService
      .getServiceClient()
      .from('scheduled_posts')
      .select(
        'id, job_id, content_id, user_id, platform, actor_type, organization_urn, retry_count',
      )
      .in('status', ['pending', 'processing'])
      .lt('scheduled_for', cutoff)
      .order('scheduled_for', { ascending: true })
      .limit(50);

    if (error) {
      this.logger.error(`Sweeper query failed: ${error.message}`);
      return;
    }

    if (!overdue || overdue.length === 0) {
      this.logger.debug('Missed-post sweeper: no overdue posts found');
      return;
    }

    this.logger.log(
      `Missed-post sweeper found ${overdue.length} overdue post(s)`,
    );

    for (const post of overdue) {
      const retryCount = post.retry_count ?? 0;

      if (retryCount >= MAX_SWEEP_RETRIES) {
        this.logger.warn(
          `Post ${post.content_id} exceeded ${MAX_SWEEP_RETRIES} sweep retries — marking failed`,
        );
        await this.supabaseService
          .getServiceClient()
          .from('scheduled_posts')
          .update({
            status: 'failed',
            error_message: `Missed-job sweeper gave up after ${MAX_SWEEP_RETRIES} re-enqueue attempts.`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', post.id);
        continue;
      }

      try {
        await this.supabaseService
          .getServiceClient()
          .from('scheduled_posts')
          .update({
            status: 'retrying',
            retry_count: retryCount + 1,
            updated_at: new Date().toISOString(),
          })
          .eq('id', post.id);

        const jobId = post.job_id || `sweep-${post.content_id}-${Date.now()}`;
        await this.publishQueue.add(
          'publish-scheduled-post',
          {
            contentId: post.content_id,
            userId: post.user_id,
            platform: post.platform || 'linkedin',
            actorType: post.actor_type,
            organizationUrn: post.organization_urn,
          },
          {
            jobId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );

        this.logger.log(
          `Re-enqueued overdue post ${post.content_id} (sweep attempt ${retryCount + 1})`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to re-enqueue post ${post.content_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.supabaseService
          .getServiceClient()
          .from('scheduled_posts')
          .update({
            status: 'pending',
            updated_at: new Date().toISOString(),
          })
          .eq('id', post.id);
      }
    }
  }
}
