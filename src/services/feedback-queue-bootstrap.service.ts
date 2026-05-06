import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../common/constants';

@Injectable()
export class FeedbackQueueBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(FeedbackQueueBootstrapService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.FEEDBACK_REMINDER)
    private readonly reminderQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.reminderQueue.add(
        'daily-sweep',
        {},
        {
          repeat: { pattern: '0 8 * * *' },
          jobId: 'feedback-reminder-daily',
          removeOnComplete: true,
        },
      );
      this.logger.log('Registered repeatable feedback reminder sweep (08:00 UTC daily)');
    } catch (e) {
      this.logger.warn(
        `Could not register feedback reminder repeat: ${(e as Error).message}`,
      );
    }
  }
}
