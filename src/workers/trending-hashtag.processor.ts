import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { HASHTAG_JOB_NAMES, QUEUE_NAMES } from '../common/constants';
import { TrendingHashtagEngineService } from '../services/trending-hashtag-engine.service';
import { TrendingTagsService } from '../services/trending-tags.service';
import { TrendingHashtagOrchestratorService } from '../services/trending-hashtag-orchestrator.service';

@Processor(QUEUE_NAMES.TRENDING_HASHTAGS, {
  concurrency: Number(process.env.SCRAPER_CONCURRENCY || '3'),
})
export class TrendingHashtagProcessor extends WorkerHost {
  private readonly logger = new Logger(TrendingHashtagProcessor.name);

  constructor(
    private readonly tagsService: TrendingTagsService,
    private readonly hashtagEngineService: TrendingHashtagEngineService,
    private readonly orchestratorService: TrendingHashtagOrchestratorService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === HASHTAG_JOB_NAMES.SYNC_ACTIVE_TAGS) {
      const activeTags = await this.tagsService.getActiveTags();
      const force = Boolean(job.data?.manual);
      this.logger.log(
        `Sync run started for ${activeTags.length} active tags (force=${force})`,
      );
      for (const tag of activeTags) {
        await this.orchestratorService.enqueueSingleTag(tag.id, force);
      }
      return;
    }

    if (job.name === HASHTAG_JOB_NAMES.PROCESS_TAG) {
      const tagId = String(job.data?.tagId || '');
      const force = Boolean(job.data?.force);
      this.logger.log(`PROCESS_TAG started for tagId=${tagId} force=${force}`);
      const tags = await this.tagsService.listTags();
      const target = tags.find((item) => item.id === tagId && item.is_active);
      if (!target) {
        this.logger.warn(`Tag ${tagId} not found or inactive; skipping`);
        return;
      }
      await this.hashtagEngineService.processTag(target, force);
      this.logger.log(`PROCESS_TAG finished for tag=${target.tag}`);
      return;
    }

    if (job.name === HASHTAG_JOB_NAMES.DECAY_SCORES) {
      await this.hashtagEngineService.decayScores();
      await this.hashtagEngineService.refreshGlobalCache();
      return;
    }

    if (job.name === HASHTAG_JOB_NAMES.CLEANUP_STALE) {
      await this.hashtagEngineService.cleanupStale();
      return;
    }
  }
}
