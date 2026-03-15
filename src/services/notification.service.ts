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

import type { Response } from 'express';

type SSEClient = { userId: string; res: Response };

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private sseClients: SSEClient[] = [];

  constructor(private readonly supabaseService: SupabaseService) {}

  addSSEClient(userId: string, res: Response): void {
    this.sseClients.push({ userId, res });
    this.logger.log(`SSE client connected: ${userId} (total: ${this.sseClients.length})`);
  }

  removeSSEClient(res: Response): void {
    this.sseClients = this.sseClients.filter(c => c.res !== res);
    this.logger.log(`SSE client disconnected (total: ${this.sseClients.length})`);
  }

  private pushToUser(userId: string, event: string, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      if (client.userId === userId) {
        try {
          client.res.write(payload);
        } catch {
          // client gone, will be cleaned up on disconnect
        }
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

      // Get broadcast notifications (not read by this user)
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

      // Filter broadcast notifications that haven't been read by this user
      const unreadBroadcast =
        broadcastNotifications?.filter(
          (notification) =>
            !notification.notification_reads?.some(
              (read: any) => read.user_id === userId,
            ),
        ) || [];

      // Combine and sort all notifications
      const allNotifications = [
        ...(personalNotifications || []),
        ...unreadBroadcast,
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
    await this.createNotification({
      userId,
      title: '❌ Content Generation Failed',
      message: `Content generation failed: ${error}. ${refundAmount} credits have been refunded to your account.`,
      type: 'error',
      category: 'generation',
      data: { jobId, error, credits: refundAmount },
    });
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
  ): Promise<void> {
    const scheduledDate = new Date(scheduledFor).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
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
      message: `Your post "${title}" has been scheduled for ${scheduledDate} IST.`,
      type: 'success',
      category: 'scheduling',
      data: { contentId, scheduledFor },
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
