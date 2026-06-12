import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

export interface NotificationData {
  contentId?: string;
  jobId?: string;
  credits?: number;
  scheduledFor?: string;
  postId?: string;
  error?: string;
  [key: string]: any;
}

export interface CreateNotificationDto {
  userId?: string; // null for broadcast
  title: string;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
  category:
    | 'publishing'
    | 'generation'
    | 'scheduling'
    | 'system'
    | 'credits'
    | 'marketing'
    | 'announcement';
  data?: NotificationData;
  isBroadcast?: boolean;
  priority?: number; // 0=normal, 1=high, 2=urgent
  expiresAt?: Date;
}

export interface Notification {
  id: string;
  user_id?: string;
  title: string;
  message: string;
  type: string;
  category: string;
  data: NotificationData;
  read: boolean;
  is_broadcast: boolean;
  priority: number;
  expires_at?: string;
  created_at: string;
  updated_at: string;
}

import type { ServerResponse } from 'http';

type SSEClient = {
  userId: string;
  res: ServerResponse;
  connectedAt: number;
  maxAgeTimer?: ReturnType<typeof setTimeout>;
};

// Cap SSE fan-out per user. React StrictMode (dev), tab reloads, and ngrok
// HTTP/2 reconnect storms can briefly stack multiple connections; allowing a
// small ceiling keeps multi-tab UX intact while preventing the unbounded
// "Sending notification to N client(s)" duplicate-event storm.
const MAX_SSE_CLIENTS_PER_USER = 3;
// Force a reconnect every hour so long-lived connections (especially behind
// reverse proxies that idle-kill silently) get cycled. Frontend reconnects
// transparently with jittered backoff.
const SSE_MAX_AGE_MS = 60 * 60 * 1000;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private sseClients: SSEClient[] = [];

  constructor(private readonly supabaseService: SupabaseService) {}

  addSSEClient(userId: string, res: ServerResponse): void {
    // Trim oldest connections for this user above the cap. Cleaning up here
    // (not just on socket-close) is important because clients behind ngrok or
    // suspended tabs sometimes leave their backend `res.on('close')` pending
    // for tens of seconds, during which a new connection arrives — exactly the
    // duplicate-fanout we want to prevent.
    const existingForUser = this.sseClients.filter((c) => c.userId === userId);
    if (existingForUser.length >= MAX_SSE_CLIENTS_PER_USER) {
      const toClose = existingForUser
        .sort((a, b) => a.connectedAt - b.connectedAt)
        .slice(0, existingForUser.length - (MAX_SSE_CLIENTS_PER_USER - 1));
      for (const stale of toClose) {
        this.closeClient(stale, 'replaced-by-newer-connection');
      }
    }

    const client: SSEClient = {
      userId,
      res,
      connectedAt: Date.now(),
    };
    client.maxAgeTimer = setTimeout(() => {
      this.closeClient(client, 'max-age-reached');
    }, SSE_MAX_AGE_MS);

    this.sseClients.push(client);
    const userCount = this.sseClients.filter((c) => c.userId === userId).length;
    this.logger.log(
      `SSE client connected: ${userId} (user_total=${userCount}, global_total=${this.sseClients.length})`,
    );
  }

  removeSSEClient(res: ServerResponse): void {
    const client = this.sseClients.find((c) => c.res === res);
    if (client?.maxAgeTimer) clearTimeout(client.maxAgeTimer);
    this.sseClients = this.sseClients.filter((c) => c.res !== res);
    this.logger.log(
      `SSE client disconnected (total: ${this.sseClients.length})`,
    );
  }

  private closeClient(client: SSEClient, reason: string): void {
    if (client.maxAgeTimer) clearTimeout(client.maxAgeTimer);
    this.sseClients = this.sseClients.filter((c) => c !== client);
    try {
      // Best-effort graceful end so the frontend's reader sees `done` and
      // reconnects via the standard backoff path rather than treating it as a
      // network error.
      client.res.end();
    } catch {
      // Socket already gone — nothing to do.
    }
    this.logger.log(
      `SSE client closed (${reason}): ${client.userId} (global_total=${this.sseClients.length})`,
    );
  }

  private pushToUser(userId: string, event: string, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const matchingClients = this.sseClients.filter(c => c.userId === userId);
    
    if (matchingClients.length === 0) {
      this.logger.warn(
        `SSE pushToUser: No clients connected for user ${userId} (event=${event}, total clients=${this.sseClients.length})`,
      );
    } else {
      this.logger.log(
        `SSE pushToUser: Sending ${event} to ${matchingClients.length} client(s) for user ${userId}`,
      );
    }
    
    for (const client of matchingClients) {
      try {
        client.res.write(payload);
      } catch (err) {
        this.logger.warn(`SSE write failed for user ${userId}: ${(err as Error).message}`);
      }
    }
  }

  private pushToAll(event: string, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.res.write(payload);
      } catch {
        // client gone, will be cleaned up on disconnect
      }
    }
  }

  /**
   * Create a new notification
   */
  async createNotification(
    dto: CreateNotificationDto,
  ): Promise<Notification | null> {
    try {
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('notifications')
        .insert({
          user_id: dto.userId || null,
          title: dto.title,
          message: dto.message,
          type: dto.type,
          category: dto.category,
          data: dto.data || {},
          is_broadcast: dto.isBroadcast || false,
          priority: dto.priority || 0,
          expires_at: dto.expiresAt?.toISOString() || null,
        })
        .select()
        .single();

      if (error) {
        this.logger.error('Failed to create notification:', error.message);
        return null;
      }

      this.logger.log(
        `Created notification: ${dto.title} for user: ${dto.userId || 'broadcast'}`,
      );

      // Push real-time via SSE
      if (dto.userId) {
        this.pushToUser(dto.userId, 'notification', data);
      } else if (dto.isBroadcast) {
        this.pushToAll('notification', data);
      }

      return data;
    } catch (error) {
      this.logger.error('Error creating notification:', error.message);
      return null;
    }
  }

  /**
   * Get notifications for a user (including broadcast notifications)
   */
  async getNotifications(
    userId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ notifications: Notification[]; total: number }> {
    try {
      const offset = (page - 1) * limit;

      // Get personal notifications
      const { data: personalNotifications, error: personalError } =
        await this.supabaseService
          .getServiceClient()
          .from('notifications')
          .select('*')
          .eq('user_id', userId)
          .or('expires_at.is.null,expires_at.gt.now()')
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

      if (personalError) {
        this.logger.error(
          'Failed to fetch personal notifications:',
          personalError.message,
        );
        return { notifications: [], total: 0 };
      }

      // Get ALL broadcast notifications (keep read ones, just mark read: true)
      const { data: broadcastNotifications, error: broadcastError } =
        await this.supabaseService
          .getServiceClient()
          .from('notifications')
          .select(
            `
          *,
          notification_reads!left(user_id)
        `,
          )
          .eq('is_broadcast', true)
          .or('expires_at.is.null,expires_at.gt.now()')
          .order('created_at', { ascending: false });

      if (broadcastError) {
        this.logger.error(
          'Failed to fetch broadcast notifications:',
          broadcastError.message,
        );
      }

      // Include ALL broadcasts; add read: true/false based on notification_reads
      const allBroadcasts = (broadcastNotifications || []).map((n: any) => {
        const reads = n.notification_reads;
        const read = Array.isArray(reads)
          ? reads.some((r: any) => r?.user_id === userId)
          : reads?.user_id === userId;
        const { notification_reads, ...rest } = n;
        return { ...rest, read: !!read };
      });

      // Combine and sort all notifications (read and unread)
      const allNotifications = [
        ...(personalNotifications || []),
        ...allBroadcasts,
      ]
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        )
        .slice(0, limit);

      // Get total count
      const { count: personalCount } = await this.supabaseService
        .getServiceClient()
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .or('expires_at.is.null,expires_at.gt.now()');

      const { count: broadcastCount } = await this.supabaseService
        .getServiceClient()
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('is_broadcast', true)
        .or('expires_at.is.null,expires_at.gt.now()');

      const total = (personalCount || 0) + (broadcastCount || 0);

      return { notifications: allNotifications, total };
    } catch (error) {
      this.logger.error('Error fetching notifications:', error.message);
      return { notifications: [], total: 0 };
    }
  }

  /**
   * Get unread notification count for a user
   */
  async getUnreadCount(userId: string): Promise<number> {
    try {
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .rpc('get_unread_notification_count', { p_user_id: userId });

      if (error) {
        this.logger.error('Failed to get unread count:', error.message);
        return 0;
      }

      return data || 0;
    } catch (error) {
      this.logger.error('Error getting unread count:', error.message);
      return 0;
    }
  }

  /**
   * Mark a notification as read
   */
  async markAsRead(notificationId: string, userId: string): Promise<boolean> {
    try {
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .rpc('mark_notification_read', {
          p_notification_id: notificationId,
          p_user_id: userId,
        });

      if (error) {
        this.logger.error(
          'Failed to mark notification as read:',
          error.message,
        );
        return false;
      }

      return data || false;
    } catch (error) {
      this.logger.error('Error marking notification as read:', error.message);
      return false;
    }
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<boolean> {
    try {
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .rpc('mark_all_notifications_read', { p_user_id: userId });

      if (error) {
        this.logger.error(
          'Failed to mark all notifications as read:',
          error.message,
        );
        return false;
      }

      return data || false;
    } catch (error) {
      this.logger.error(
        'Error marking all notifications as read:',
        error.message,
      );
      return false;
    }
  }

  /** Emit credit balance change to the user via SSE */
  emitCreditBalanceChanged(
    userId: string,
    balance: number,
    ledgerEntryId?: string,
  ): void {
    this.pushToUser(userId, 'credits.balance_changed', {
      userId,
      balance,
      ledgerEntryId,
      timestamp: new Date().toISOString(),
    });
  }

  /** Emit generation progress update via SSE */
  emitGenerationProgress(
    userId: string,
    data: {
      generationId: string;
      subtaskKey: string;
      status: 'queued' | 'running' | 'succeeded' | 'failed';
      percent?: number;
      meta?: Record<string, unknown>;
    },
  ): void {
    this.logger.log(
      `emitGenerationProgress: user=${userId} job=${data.generationId} step=${data.subtaskKey} status=${data.status}`,
    );
    this.pushToUser(userId, 'generation.progress', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  /** Emit generation completed via SSE */
  emitGenerationCompleted(
    userId: string,
    data: {
      generationId: string;
      contentId: string;
      contentType: string;
      regenerated?: boolean;
    },
  ): void {
    this.logger.log(
      `emitGenerationCompleted: user=${userId} job=${data.generationId} content=${data.contentId}`,
    );
    this.pushToUser(userId, 'generation.completed', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Emit single-image regeneration completion. Frontend listens for this on
   * `trndinn:image-regenerated` to append the new URL as another pickable
   * option in the post preview/schedule modal.
   */
  emitImageRegenerated(
    userId: string,
    data: {
      generationId: string;
      contentId: string;
      imageIndex: number;
      newImageUrl: string;
      sourceImageIndex?: number;
      appended?: boolean;
    },
  ): void {
    this.logger.log(
      `emitImageRegenerated: user=${userId} job=${data.generationId} content=${data.contentId} index=${data.imageIndex}`,
    );
    this.pushToUser(userId, 'generation.image_regenerated', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Emit full-carousel regeneration completion. The frontend uses this to
   * replace the slide list and PDF URL in the preview modal in place.
   */
  emitCarouselRegenerated(
    userId: string,
    data: {
      generationId: string;
      contentId: string;
      newImageUrls: string[];
      newPdfUrl?: string;
    },
  ): void {
    this.logger.log(
      `emitCarouselRegenerated: user=${userId} job=${data.generationId} content=${data.contentId} slides=${data.newImageUrls.length}`,
    );
    this.pushToUser(userId, 'generation.carousel_regenerated', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Full custom-topic regeneration — replaces caption, hashtags, and media on
   * the existing content row (same topic + stored generation settings).
   */
  emitPostRegenerated(
    userId: string,
    data: {
      generationId: string;
      contentId: string;
      contentType: string;
      caption: string;
      hashtags: string[];
      imageUrls?: string[];
      carouselUrls?: string[];
      visualUrl?: string;
      pdfUrl?: string;
    },
  ): void {
    this.logger.log(
      `emitPostRegenerated: user=${userId} job=${data.generationId} content=${data.contentId}`,
    );
    this.pushToUser(userId, 'generation.post_regenerated', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  // Predefined notification creators for common scenarios

  /**
   * Notify when content generation is completed
   */
  async notifyGenerationComplete(
    userId: string,
    contentId: string,
    title: string,
  ): Promise<void> {
    await this.createNotification({
      userId,
      title: '🎉 Content Generated Successfully!',
      message: `Your content "${title}" has been generated and is ready to publish.`,
      type: 'success',
      category: 'generation',
      data: { contentId },
    });
  }

  /**
   * Notify when content generation fails
   */
  async notifyGenerationFailed(
    userId: string,
    jobId: string,
    error: string,
    refundAmount: number,
  ): Promise<void> {
    const userMessage = this.userFacingGenerationErrorMessage(error);
    if (userMessage !== error) {
      this.logger.warn(
        `notifyGenerationFailed: sanitized for user=${userId} job=${jobId}; technical=${error.slice(0, 2000)}`,
      );
    }

    const body = userMessage.endsWith('.') ? userMessage : `${userMessage}.`;

    await this.createNotification({
      userId,
      title: '❌ Content Generation Failed',
      message: `${body} ${refundAmount} credits have been refunded to your account.`,
      type: 'error',
      category: 'generation',
      data: { jobId, credits: refundAmount },
    });
  }

  /** Short, non-technical copy for in-app notifications; logs retain full detail. */
  private userFacingGenerationErrorMessage(error: string): string {
    const t = error.trim();
    if (
      t.startsWith('AI output failed schema validation') ||
      t.includes('invalid_union') ||
      /invalid_(literal|type|enum)/i.test(t) ||
      /\bZod\b/i.test(t) ||
      /expected .*, received null/i.test(t) ||
      t.length > 400
    ) {
      return "We couldn't generate your content. Please try again.";
    }
    return `Content generation failed: ${t}`;
  }

  /**
   * Notify when post is published successfully
   */
  async notifyPostPublished(
    userId: string,
    contentId: string,
    title: string,
    postId?: string,
  ): Promise<void> {
    await this.createNotification({
      userId,
      title: '🚀 Post Published Successfully!',
      message: `Your post "${title}" has been published to LinkedIn.`,
      type: 'success',
      category: 'publishing',
      data: { contentId, postId },
    });
  }

  /**
   * Notify when post publishing fails
   */
  async notifyPostPublishFailed(
    userId: string,
    contentId: string,
    title: string,
    error: string,
    refundAmount: number,
  ): Promise<void> {
    await this.createNotification({
      userId,
      title: '❌ Post Publishing Failed',
      message: `Failed to publish "${title}": ${error}. ${refundAmount} credits have been refunded.`,
      type: 'error',
      category: 'publishing',
      data: { contentId, error, credits: refundAmount },
    });
  }

  /**
   * Notify when post is scheduled
   */
  async notifyPostScheduled(
    userId: string,
    contentId: string,
    title: string,
    scheduledFor: string,
    timezone?: string,
  ): Promise<void> {
    const selectedTimezone = timezone || 'UTC';
    const scheduledDate = new Date(scheduledFor).toLocaleString(undefined, {
      timeZone: selectedTimezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    await this.createNotification({
      userId,
      title: '⏰ Post Scheduled Successfully!',
      message: `Your post "${title}" has been scheduled for ${scheduledDate} (${selectedTimezone}).`,
      type: 'success',
      category: 'scheduling',
      data: { contentId, scheduledFor, timezone: selectedTimezone },
    });
  }

  /**
   * Notify when scheduled post publishing fails
   */
  async notifyScheduledPostFailed(
    userId: string,
    contentId: string,
    title: string,
    error: string,
    refundAmount: number,
  ): Promise<void> {
    await this.createNotification({
      userId,
      title: '❌ Scheduled Post Failed',
      message: `Failed to publish scheduled post "${title}": ${error}. ${refundAmount} credits have been refunded.`,
      type: 'error',
      category: 'scheduling',
      data: { contentId, error, credits: refundAmount },
    });
  }

  /**
   * Notify when credits are low
   */
  async notifyCreditsLow(
    userId: string,
    remainingCredits: number,
    totalCredits: number,
  ): Promise<void> {
    const percentage = Math.round((remainingCredits / totalCredits) * 100);

    await this.createNotification({
      userId,
      title: '⚠️ Credits Running Low',
      message: `You have ${remainingCredits} credits remaining (${percentage}% of your plan). Consider upgrading to continue creating content.`,
      type: 'warning',
      category: 'credits',
      data: { credits: remainingCredits, totalCredits, percentage },
      priority: 1, // High priority
    });
  }

  /**
   * Notify when refund is granted
   */
  async notifyRefundGranted(
    userId: string,
    amount: number,
    reason: string,
  ): Promise<void> {
    await this.createNotification({
      userId,
      title: '💰 Credits Refunded',
      message: `${amount} credits have been refunded to your account. Reason: ${reason}`,
      type: 'info',
      category: 'credits',
      data: { credits: amount, reason },
    });
  }

  /**
   * Create broadcast notification (marketing/announcements)
   */
  async createBroadcastNotification(
    title: string,
    message: string,
    type: 'info' | 'warning' | 'success' = 'info',
    category: 'marketing' | 'announcement' = 'marketing',
    priority: number = 0,
    expiresAt?: Date,
  ): Promise<Notification | null> {
    return await this.createNotification({
      title,
      message,
      type,
      category,
      isBroadcast: true,
      priority,
      expiresAt,
    });
  }

  /**
   * Delete expired notifications (cleanup job)
   */
  async cleanupExpiredNotifications(): Promise<number> {
    try {
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('notifications')
        .delete()
        .lt('expires_at', new Date().toISOString())
        .select('id');

      if (error) {
        this.logger.error(
          'Failed to cleanup expired notifications:',
          error.message,
        );
        return 0;
      }

      const deletedCount = data?.length || 0;
      this.logger.log(`Cleaned up ${deletedCount} expired notifications`);
      return deletedCount;
    } catch (error) {
      this.logger.error(
        'Error cleaning up expired notifications:',
        error.message,
      );
      return 0;
    }
  }
}
