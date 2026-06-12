import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { OutboundWebhookService, type WebhookEventType } from './outbound-webhook.service';
import { QUEUE_NAMES } from '../common/constants';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000]; // 30s, 5m, 30m

export interface WebhookDeliveryJobData {
  webhookId: string;
  vaultSecretId: string;
  url: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempt: number;
  userId: string;
}

@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    private readonly webhookService: OutboundWebhookService,
    @InjectQueue(QUEUE_NAMES.WEBHOOK_DELIVERY)
    private readonly deliveryQueue: Queue,
  ) {}

  async dispatch(
    userId: string,
    eventType: WebhookEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const webhooks = await this.webhookService.getEnabledWebhooksForEvent(
      userId,
      eventType,
    );

    for (const webhook of webhooks) {
      const jobData: WebhookDeliveryJobData = {
        webhookId: webhook.id,
        vaultSecretId: webhook.vault_secret_id,
        url: webhook.url,
        eventType,
        payload,
        attempt: 1,
        userId,
      };

      await this.deliveryQueue.add('deliver', jobData, {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 200,
      });

      this.logger.log(
        `Queued webhook delivery: ${webhook.id} event=${eventType}`,
      );
    }
  }

  async deliver(data: WebhookDeliveryJobData): Promise<void> {
    const secret = await this.webhookService.readWebhookSecret(
      data.vaultSecretId,
    );
    if (!secret) {
      this.logger.warn(
        `Skipping webhook ${data.webhookId}: secret not found in vault`,
      );
      return;
    }

    const body = JSON.stringify(data.payload);
    const signature = this.webhookService.signPayload(body, secret);
    const timestamp = new Date().toISOString();

    let responseStatus: number | undefined;
    let responseBody: string | undefined;
    let succeeded = false;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(data.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trndinn-Signature': signature,
          'X-Trndinn-Event': data.eventType,
          'X-Trndinn-Delivery-Timestamp': timestamp,
          'User-Agent': 'Trndinn-Webhooks/1.0',
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      responseStatus = response.status;
      responseBody = await response.text().catch(() => '');

      succeeded = response.status >= 200 && response.status < 300;
    } catch (err) {
      responseBody =
        err instanceof Error ? err.message : 'Network error';
      this.logger.warn(
        `Webhook delivery failed for ${data.webhookId}: ${responseBody}`,
      );
    }

    const isLastAttempt = data.attempt >= MAX_ATTEMPTS;
    const status = succeeded
      ? 'succeeded'
      : isLastAttempt
        ? 'dead_letter'
        : 'failed';

    const nextRetryAt =
      !succeeded && !isLastAttempt
        ? new Date(Date.now() + (RETRY_DELAYS_MS[data.attempt - 1] ?? 1_800_000))
        : undefined;

    await this.webhookService.recordDelivery({
      webhookId: data.webhookId,
      eventType: data.eventType,
      payload: data.payload,
      signature,
      attempt: data.attempt,
      status: status as 'pending' | 'succeeded' | 'failed' | 'dead_letter',
      responseStatusCode: responseStatus,
      responseBodyTruncated: responseBody,
      nextRetryAt,
      deliveredAt: succeeded ? new Date() : undefined,
    });

    if (!succeeded && !isLastAttempt) {
      const retryDelay = RETRY_DELAYS_MS[data.attempt - 1] ?? 1_800_000;
      await this.deliveryQueue.add(
        'deliver',
        {
          ...data,
          attempt: data.attempt + 1,
        },
        {
          delay: retryDelay,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      );
      this.logger.log(
        `Scheduled retry ${data.attempt + 1}/${MAX_ATTEMPTS} for webhook ${data.webhookId} in ${retryDelay / 1000}s`,
      );
    } else if (!succeeded) {
      this.logger.warn(
        `Webhook ${data.webhookId} delivery dead-lettered after ${MAX_ATTEMPTS} attempts`,
      );
    }
  }

  async testFire(userId: string, webhookId: string): Promise<{
    status: number | null;
    body: string;
  }> {
    const webhook = await this.webhookService.getById(userId, webhookId);
    if (!webhook) {
      throw new Error('Webhook not found');
    }

    const secret = await this.webhookService.readWebhookSecret(
      webhook.vault_secret_id,
    );
    if (!secret) {
      throw new Error('Webhook secret not found in vault');
    }

    const testPayload = {
      event: 'test.ping',
      timestamp: new Date().toISOString(),
      webhook_id: webhookId,
      data: { message: 'This is a test webhook delivery from Trndinn.' },
    };

    const body = JSON.stringify(testPayload);
    const signature = this.webhookService.signPayload(body, secret);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trndinn-Signature': signature,
          'X-Trndinn-Event': 'test.ping',
          'X-Trndinn-Delivery-Timestamp': new Date().toISOString(),
          'User-Agent': 'Trndinn-Webhooks/1.0',
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const responseBody = await response.text().catch(() => '');
      return { status: response.status, body: responseBody.slice(0, 2048) };
    } catch (err) {
      return {
        status: null,
        body: err instanceof Error ? err.message : 'Network error',
      };
    }
  }
}
