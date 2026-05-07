import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { CacheService } from './cache.service';

export type FeedbackType = 'bug' | 'feature' | 'general' | 'other';
export type FeedbackStatus = 'new' | 'reviewed' | 'resolved';

export interface UserFeedbackDto {
  id: string;
  user_id: string;
  type: FeedbackType;
  message: string;
  rating: number | null;
  status: FeedbackStatus;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserFeedbackWithUser extends UserFeedbackDto {
  user_email?: string;
  user_name?: string;
}

const ADMIN_USER_FEEDBACK_CACHE_PREFIX = 'admin:user-feedback:list:';

@Injectable()
export class UserFeedbackService {
  private readonly logger = new Logger(UserFeedbackService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
  ) {}

  async submitFeedback(
    userId: string,
    body: {
      type: FeedbackType;
      message: string;
      rating?: number;
    },
  ): Promise<{ feedbackId: string }> {
    const validTypes: FeedbackType[] = ['bug', 'feature', 'general', 'other'];
    if (!validTypes.includes(body.type)) {
      throw new BadRequestException(
        'Invalid feedback type. Must be: bug, feature, general, or other',
      );
    }

    if (!body.message?.trim()) {
      throw new BadRequestException('Feedback message is required');
    }

    if (body.message.length > 5000) {
      throw new BadRequestException(
        'Feedback message must be 5000 characters or less',
      );
    }

    if (body.rating !== undefined) {
      const rating = Math.floor(Number(body.rating));
      if (rating < 1 || rating > 5) {
        throw new BadRequestException('Rating must be between 1 and 5');
      }
    }

    const client = this.supabaseService.getServiceClient();

    const { data: inserted, error } = await client
      .from('user_feedback')
      .insert({
        user_id: userId,
        type: body.type,
        message: body.message.trim(),
        rating: body.rating ? Math.floor(body.rating) : null,
        status: 'new',
      })
      .select('id')
      .single();

    if (error) {
      this.logger.error(`submitFeedback error: ${error.message}`);
      throw new BadRequestException('Failed to submit feedback');
    }

    await this.invalidateAdminCache();

    return { feedbackId: inserted.id };
  }

  async getUserFeedbackHistory(
    userId: string,
    params: { page: number; limit: number },
  ) {
    const page = Math.max(1, params.page);
    const limit = Math.min(50, Math.max(1, params.limit));
    const offset = (page - 1) * limit;

    const client = this.supabaseService.getServiceClient();

    const { data: rows, error, count } = await client
      .from('user_feedback')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      this.logger.error(`getUserFeedbackHistory error: ${error.message}`);
      throw new BadRequestException('Failed to fetch feedback history');
    }

    return {
      items: rows || [],
      total: count ?? 0,
      page,
      limit,
    };
  }

  async adminListFeedback(params: {
    page: number;
    limit: number;
    type?: FeedbackType;
    status?: FeedbackStatus;
    cacheBuster?: boolean;
  }) {
    const page = Math.max(1, params.page);
    const limit = Math.min(100, Math.max(1, params.limit));
    const cacheKey = `${ADMIN_USER_FEEDBACK_CACHE_PREFIX}${page}:${limit}:${params.type ?? 'all'}:${params.status ?? 'all'}`;

    if (!params.cacheBuster) {
      const cached = await this.cacheService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    const result = await this.adminListFeedbackUncached({
      page,
      limit,
      type: params.type,
      status: params.status,
    });

    await this.cacheService.set(cacheKey, JSON.stringify(result), 60);
    return result;
  }

  private async adminListFeedbackUncached(params: {
    page: number;
    limit: number;
    type?: FeedbackType;
    status?: FeedbackStatus;
  }) {
    const client = this.supabaseService.getServiceClient();
    const offset = (params.page - 1) * params.limit;

    let q = client
      .from('user_feedback')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + params.limit - 1);

    if (params.type) {
      q = q.eq('type', params.type);
    }
    if (params.status) {
      q = q.eq('status', params.status);
    }

    const { data: rows, error, count } = await q;

    if (error) {
      throw new BadRequestException(error.message);
    }

    const userIds = [...new Set((rows || []).map((r) => r.user_id))];
    const userMap = await this.fetchUserDetails(userIds);

    const itemsWithUser: UserFeedbackWithUser[] = (rows || []).map((row) => ({
      ...row,
      user_email: userMap[row.user_id]?.email,
      user_name: userMap[row.user_id]?.name,
    }));

    const stats = await this.computeStats();

    return {
      items: itemsWithUser,
      total: count ?? 0,
      page: params.page,
      limit: params.limit,
      stats,
    };
  }

  private async fetchUserDetails(
    userIds: string[],
  ): Promise<Record<string, { email?: string; name?: string }>> {
    if (userIds.length === 0) return {};

    const client = this.supabaseService.getServiceClient();
    const { data: profiles } = await client
      .from('profiles')
      .select('id, email, full_name, username')
      .in('id', userIds);

    const map: Record<string, { email?: string; name?: string }> = {};
    for (const p of profiles || []) {
      map[p.id] = {
        email: p.email,
        name: p.full_name || p.username || undefined,
      };
    }
    return map;
  }

  private async computeStats() {
    const client = this.supabaseService.getServiceClient();

    const { data: all } = await client
      .from('user_feedback')
      .select('type, status, rating, created_at');

    const list = (all || []) as {
      type: FeedbackType;
      status: FeedbackStatus;
      rating: number | null;
      created_at: string;
    }[];

    const total = list.length;
    const byType: Record<FeedbackType, number> = {
      bug: 0,
      feature: 0,
      general: 0,
      other: 0,
    };
    const byStatus: Record<FeedbackStatus, number> = {
      new: 0,
      reviewed: 0,
      resolved: 0,
    };

    let ratingSum = 0;
    let ratingCount = 0;

    for (const item of list) {
      byType[item.type] = (byType[item.type] || 0) + 1;
      byStatus[item.status] = (byStatus[item.status] || 0) + 1;
      if (item.rating !== null) {
        ratingSum += item.rating;
        ratingCount++;
      }
    }

    return {
      total,
      byType,
      byStatus,
      avgRating: ratingCount > 0 ? ratingSum / ratingCount : null,
    };
  }

  async adminUpdateStatus(
    feedbackId: string,
    status: FeedbackStatus,
    adminNotes?: string,
  ): Promise<UserFeedbackDto> {
    const validStatuses: FeedbackStatus[] = ['new', 'reviewed', 'resolved'];
    if (!validStatuses.includes(status)) {
      throw new BadRequestException(
        'Invalid status. Must be: new, reviewed, or resolved',
      );
    }

    const client = this.supabaseService.getServiceClient();

    const updateData: { status: FeedbackStatus; admin_notes?: string } = {
      status,
    };
    if (adminNotes !== undefined) {
      updateData.admin_notes = adminNotes;
    }

    const { data: updated, error } = await client
      .from('user_feedback')
      .update(updateData)
      .eq('id', feedbackId)
      .select('*')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new BadRequestException('Feedback not found');
      }
      throw new BadRequestException(error.message);
    }

    await this.invalidateAdminCache();

    return updated;
  }

  private async invalidateAdminCache() {
    await this.cacheService.deleteByPrefix(ADMIN_USER_FEEDBACK_CACHE_PREFIX);
  }
}
