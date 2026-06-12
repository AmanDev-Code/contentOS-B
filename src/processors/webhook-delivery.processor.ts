import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../common/constants';
import {
  WebhookDeliveryService,
  type WebhookDeliveryJobData,
} from '../services/webhook-delivery.service';

@Processor(QUEUE_NAMES.WEBHOOK_DELIVERY)
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(private readonly deliveryService: WebhookDeliveryService) {
    super();
  }

  async process(job: Job<WebhookDeliveryJobData>): Promise<void> {
    this.logger.log(
      `Processing webhook delivery: ${job.data.webhookId} event=${job.data.eventType} attempt=${job.data.attempt}`,
    );
    await this.deliveryService.deliver(job.data);
  }
}
