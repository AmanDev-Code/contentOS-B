import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../common/constants';
import { FeedbackService } from '../services/feedback.service';

interface RewardJob {
  feedbackId: string;
  userId: string;
}

@Processor(QUEUE_NAMES.FEEDBACK_REWARD)
export class FeedbackRewardProcessor extends WorkerHost {
  private readonly logger = new Logger(FeedbackRewardProcessor.name);

  constructor(private readonly feedbackService: FeedbackService) {
    super();
  }

  async process(job: Job<RewardJob>) {
    if (job.name !== 'apply-reward') {
      return;
    }
    const applied = await this.feedbackService.applyFeedbackReward(
      job.data.feedbackId,
    );
    this.logger.log(
      `Feedback reward job ${job.id}: applied=${applied} feedback=${job.data.feedbackId}`,
    );
    return { applied };
  }
}
