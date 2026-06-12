import { Injectable, Logger } from '@nestjs/common';
import { WebhookDeliveryService } from './webhook-delivery.service';
import type { WebhookEventType } from './outbound-webhook.service';

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(private readonly deliveryService: WebhookDeliveryService) {}

  async emitPostPublished(params: {
    userId: string;
    contentId: string;
    platform: string;
    postId?: string;
    postUrl?: string;
    publishedAt?: string;
  }): Promise<void> {
    await this.emit(params.userId, 'post.published', {
      content_id: params.contentId,
      platform: params.platform,
      post_id: params.postId,
      post_url: params.postUrl,
      published_at: params.publishedAt ?? new Date().toISOString(),
    });
  }

  async emitPostFailed(params: {
    userId: string;
    contentId: string;
    platform: string;
    error: string;
  }): Promise<void> {
    await this.emit(params.userId, 'post.failed', {
      content_id: params.contentId,
      platform: params.platform,
      error: params.error,
      failed_at: new Date().toISOString(),
    });
  }

  async emitPostScheduled(params: {
    userId: string;
    contentId: string;
    platform: string;
    scheduledFor: string;
  }): Promise<void> {
    await this.emit(params.userId, 'post.scheduled', {
      content_id: params.contentId,
      platform: params.platform,
      scheduled_for: params.scheduledFor,
    });
  }

  async emitPostCancelled(params: {
    userId: string;
    contentId: string;
    platform: string;
  }): Promise<void> {
    await this.emit(params.userId, 'post.cancelled', {
      content_id: params.contentId,
      platform: params.platform,
      cancelled_at: new Date().toISOString(),
    });
  }

  private async emit(
    userId: string,
    eventType: WebhookEventType,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deliveryService.dispatch(userId, eventType, {
        event: eventType,
        timestamp: new Date().toISOString(),
        data,
      });
    } catch (err) {
      this.logger.warn(
        `Webhook dispatch failed for ${eventType}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
