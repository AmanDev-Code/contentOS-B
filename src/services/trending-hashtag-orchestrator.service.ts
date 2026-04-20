import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { HASHTAG_JOB_NAMES, QUEUE_NAMES } from '../common/constants';
import { TrendingTagsService } from './trending-tags.service';

@Injectable()
export class TrendingHashtagOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(TrendingHashtagOrchestratorService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.TRENDING_HASHTAGS)
    private readonly queue: Queue,
    private readonly tagsService: TrendingTagsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      HASHTAG_JOB_NAMES.SYNC_ACTIVE_TAGS,
      {},
      {
        jobId: 'hashtags-sync-6h',
        repeat: { pattern: '0 */6 * * *' },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );

    await this.queue.add(
      HASHTAG_JOB_NAMES.DECAY_SCORES,
      {},
      {
        jobId: 'hashtags-decay-daily',
        repeat: { pattern: '0 1 * * *' },
        removeOnComplete: 20,
        removeOnFail: 50,
      },
    );

    await this.queue.add(
      HASHTAG_JOB_NAMES.CLEANUP_STALE,
      {},
      {
        jobId: 'hashtags-cleanup-daily',
        repeat: { pattern: '30 1 * * *' },
        removeOnComplete: 20,
        removeOnFail: 50,
      },
    );

    this.logger.log('BullMQ repeatable hashtag jobs registered.');
  }

  async enqueueSyncNow(): Promise<void> {
    await this.queue.add(
      HASHTAG_JOB_NAMES.SYNC_ACTIVE_TAGS,
      { manual: true },
      {
        removeOnComplete: 20,
        removeOnFail: 50,
      },
    );
  }

  async enqueueSingleTag(tagId: string, force = true): Promise<void> {
    const tags = await this.tagsService.listTags();
    const target = tags.find((item) => item.id === tagId);
    if (!target) {
      throw new Error('Tag not found');
    }

    await this.queue.add(
      HASHTAG_JOB_NAMES.PROCESS_TAG,
      {
        tagId: target.id,
        force,
      },
      {
        jobId: `hashtags-tag-${target.id}-${Date.now()}`,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1500,
        },
        removeOnComplete: 30,
        removeOnFail: 50,
      },
    );
  }
}
