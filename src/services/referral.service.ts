import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { QuotaService } from './quota.service';
import { NotificationService } from './notification.service';

export interface ReferralCode {
  id: string;
  user_id: string;
  code: string;
  is_active: boolean;
  usage_count: number;
  created_at: string;
}

export interface Referral {
  id: string;
  referrer_id: string;
  referred_user_id: string;
  referral_code_id: string;
  status: 'pending' | 'completed' | 'credited' | 'expired';
  credits_awarded: number;
  actions_completed: number;
  created_at: string;
  completed_at: string | null;
  credited_at: string | null;
}

export interface ReferralWithUser extends Referral {
  referred_user?: {
    username: string | null;
    full_name: string | null;
    email: string | null;
  };
}

export interface ReferralStats {
  code: string;
  usage_count: number;
  is_active: boolean;
  total_referred: number;
  pending_count: number;
  completed_count: number;
  total_credits_earned: number;
}

export interface ReferralSettings {
  id: string;
  credits_per_referral: number;
  min_actions_to_complete: number;
  is_program_active: boolean;
  terms_and_conditions: string | null;
  updated_at: string;
}

export interface ReferralBanner {
  id: string;
  title: string;
  image_url: string;
  link_url: string | null;
  is_active: boolean;
  display_order: number;
  created_at: string;
}

export interface AdminReferralAnalytics {
  total_referrals: number;
  referrals_this_month: number;
  pending_referrals: number;
  completed_referrals: number;
  total_credits_awarded: number;
  total_referral_codes: number;
  conversion_rate: number;
}

export interface TopReferrer {
  user_id: string;
  username: string | null;
  full_name: string | null;
  total_referred: number;
  completed_referrals: number;
  total_credits_earned: number;
}

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly quotaService: QuotaService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Get or create a referral code for a user
   */
  async getOrCreateReferralCode(
    userId: string,
    username?: string,
  ): Promise<ReferralCode> {
    const client = this.supabaseService.getServiceClient();

    // First, try to get existing code
    const { data: existingCode } = await client
      .from('referral_codes')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (existingCode) {
      return existingCode as ReferralCode;
    }

    // If no existing code, try to create one via RPC
    const { data, error } = await client.rpc('get_or_create_referral_code', {
      p_user_id: userId,
      p_username: username || null,
    });

    if (error) {
      // If duplicate key error, fetch the existing code
      if (error.message.includes('duplicate key')) {
        const { data: retryCode } = await client
          .from('referral_codes')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (retryCode) {
          return retryCode as ReferralCode;
        }
      }
      this.logger.error(`Failed to get/create referral code: ${error.message}`);
      throw new BadRequestException('Failed to generate referral code');
    }

    if (!data || data.length === 0) {
      throw new BadRequestException('Failed to generate referral code');
    }

    return data[0] as ReferralCode;
  }

  /**
   * Validate a referral code
   */
  async validateReferralCode(code: string): Promise<{
    valid: boolean;
    referrer?: {
      id: string;
      username: string | null;
      full_name: string | null;
    };
    message?: string;
  }> {
    const client = this.supabaseService.getServiceClient();

    // Check if program is active
    const settings = await this.getSettings();
    if (!settings.is_program_active) {
      return {
        valid: false,
        message: 'Referral program is currently inactive',
      };
    }

    // Find the code
    const { data: codeData, error } = await client
      .from('referral_codes')
      .select('id, user_id, code, is_active')
      .eq('code', code.toUpperCase())
      .single();

    if (error || !codeData) {
      return { valid: false, message: 'Invalid referral code' };
    }

    if (!codeData.is_active) {
      return {
        valid: false,
        message: 'This referral code is no longer active',
      };
    }

    // Get referrer info
    const { data: profile } = await client
      .from('profiles')
      .select('id, username, full_name')
      .eq('id', codeData.user_id)
      .single();

    return {
      valid: true,
      referrer: profile
        ? {
            id: profile.id,
            username: profile.username,
            full_name: profile.full_name,
          }
        : undefined,
    };
  }

  /**
   * Record a referral when a new user signs up with a code
   */
  async recordReferral(
    referredUserId: string,
    referralCode: string,
  ): Promise<boolean> {
    const client = this.supabaseService.getServiceClient();

    // Validate the code first
    const validation = await this.validateReferralCode(referralCode);
    if (!validation.valid || !validation.referrer) {
      this.logger.warn(`Invalid referral code used: ${referralCode}`);
      return false;
    }

    // Prevent self-referral
    if (validation.referrer.id === referredUserId) {
      this.logger.warn(`User ${referredUserId} attempted self-referral`);
      return false;
    }

    // Check if user was already referred
    const { data: existingReferral } = await client
      .from('referrals')
      .select('id')
      .eq('referred_user_id', referredUserId)
      .single();

    if (existingReferral) {
      this.logger.warn(`User ${referredUserId} already has a referral record`);
      return false;
    }

    // Get the referral code record
    const { data: codeRecord } = await client
      .from('referral_codes')
      .select('id, user_id')
      .eq('code', referralCode.toUpperCase())
      .single();

    if (!codeRecord) {
      return false;
    }

    // Create the referral record
    const { error } = await client.from('referrals').insert({
      referrer_id: codeRecord.user_id,
      referred_user_id: referredUserId,
      referral_code_id: codeRecord.id,
      status: 'pending',
    });

    if (error) {
      this.logger.error(`Failed to record referral: ${error.message}`);
      return false;
    }

    this.logger.log(
      `Referral recorded: ${referredUserId} referred by ${codeRecord.user_id}`,
    );
    return true;
  }

  /**
   * Process referral completion when user completes qualifying action
   */
  async processReferralCompletion(referredUserId: string): Promise<{
    success: boolean;
    referrerId?: string;
    creditsAwarded?: number;
    message: string;
  }> {
    const client = this.supabaseService.getServiceClient();

    const { data, error } = await client.rpc('process_referral_completion', {
      p_referred_user_id: referredUserId,
    });

    if (error) {
      this.logger.error(
        `Failed to process referral completion: ${error.message}`,
      );
      return { success: false, message: 'Failed to process referral' };
    }

    if (!data || data.length === 0) {
      return { success: false, message: 'No referral found' };
    }

    const result = data[0];

    if (result.success && result.credits_awarded > 0 && result.referrer_id) {
      // Award credits to referrer. Sprint 1.9b: referral rewards are a grant,
      // so route through grantCredits -> the never-expiring REWARD bucket
      // (operation_type='referral_bonus'). This replaces the old negative
      // consumeCredits call, which recorded a refund into the plan bucket.
      try {
        await this.quotaService.grantCredits(
          result.referrer_id,
          result.credits_awarded,
          `Referral bonus: User completed qualifying action`,
          'referral_bonus',
          { source: 'referral', referred_user_id: referredUserId },
        );

        // Send notification to referrer
        await this.notificationService.createNotification({
          userId: result.referrer_id,
          type: 'success',
          category: 'credits',
          title: 'Referral Bonus Earned!',
          message: `Congratulations! Your referral completed their first generation. You've earned ${result.credits_awarded} credits!`,
          data: { credits_awarded: result.credits_awarded },
        });

        this.logger.log(
          `Referral completed: ${result.referrer_id} earned ${result.credits_awarded} credits`,
        );
      } catch (err) {
        this.logger.error(`Failed to award referral credits: ${err}`);
      }
    }

    return {
      success: result.success,
      referrerId: result.referrer_id,
      creditsAwarded: result.credits_awarded,
      message: result.message,
    };
  }

  /**
   * Get user's referral stats
   */
  async getUserReferralStats(userId: string): Promise<ReferralStats | null> {
    const client = this.supabaseService.getServiceClient();

    const { data, error } = await client
      .from('user_referral_stats')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No referral code yet - create one
        const code = await this.getOrCreateReferralCode(userId);
        return {
          code: code.code,
          usage_count: 0,
          is_active: true,
          total_referred: 0,
          pending_count: 0,
          completed_count: 0,
          total_credits_earned: 0,
        };
      }
      this.logger.error(`Failed to get referral stats: ${error.message}`);
      return null;
    }

    return data as ReferralStats;
  }

  /**
   * Get list of users referred by a user
   */
  async getUserReferrals(
    userId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ referrals: ReferralWithUser[]; total: number }> {
    const client = this.supabaseService.getServiceClient();
    const limit = options?.limit || 20;
    const offset = options?.offset || 0;

    // Get total count
    const { count } = await client
      .from('referrals')
      .select('*', { count: 'exact', head: true })
      .eq('referrer_id', userId);

    // Get referrals (without join since FK is to auth.users, not profiles)
    const { data, error } = await client
      .from('referrals')
      .select('*')
      .eq('referrer_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      this.logger.error(`Failed to get user referrals: ${error.message}`);
      return { referrals: [], total: 0 };
    }

    // Fetch profiles for referred users separately
    const referredUserIds = (data || []).map((r) => r.referred_user_id);
    const profilesMap = new Map<
      string,
      { username: string | null; full_name: string | null }
    >();

    if (referredUserIds.length > 0) {
      const { data: profiles } = await client
        .from('profiles')
        .select('id, username, full_name')
        .in('id', referredUserIds);

      if (profiles) {
        for (const p of profiles) {
          profilesMap.set(p.id, {
            username: p.username,
            full_name: p.full_name,
          });
        }
      }
    }

    // Map referrals with profile data
    const referrals = (data || []).map((r) => {
      const profile = profilesMap.get(r.referred_user_id);
      return {
        ...r,
        referred_user: profile
          ? {
              username: profile.username,
              full_name: profile.full_name
                ? this.maskName(profile.full_name)
                : null,
              email: null,
            }
          : undefined,
      };
    });

    return { referrals: referrals as ReferralWithUser[], total: count || 0 };
  }

  /**
   * Get referral settings
   */
  async getSettings(): Promise<ReferralSettings> {
    const client = this.supabaseService.getServiceClient();

    const { data, error } = await client
      .from('referral_settings')
      .select('*')
      .limit(1)
      .single();

    if (error) {
      this.logger.error(`Failed to get referral settings: ${error.message}`);
      // Return defaults
      return {
        id: '',
        credits_per_referral: 50,
        min_actions_to_complete: 1,
        is_program_active: true,
        terms_and_conditions: null,
        updated_at: new Date().toISOString(),
      };
    }

    return data as ReferralSettings;
  }

  /**
   * Update referral settings (admin only)
   */
  async updateSettings(
    updates: Partial<Omit<ReferralSettings, 'id' | 'updated_at'>>,
  ): Promise<ReferralSettings> {
    const client = this.supabaseService.getServiceClient();

    // Get current settings to get the ID
    const current = await this.getSettings();

    const { data, error } = await client
      .from('referral_settings')
      .update(updates)
      .eq('id', current.id)
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to update referral settings: ${error.message}`);
      throw new BadRequestException('Failed to update settings');
    }

    return data as ReferralSettings;
  }

  /**
   * Get active referral banners
   */
  async getActiveBanners(): Promise<ReferralBanner[]> {
    const client = this.supabaseService.getServiceClient();

    const { data, error } = await client
      .from('referral_banners')
      .select('*')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) {
      this.logger.error(`Failed to get referral banners: ${error.message}`);
      return [];
    }

    return data as ReferralBanner[];
  }

  /**
   * Get all banners (admin)
   */
  async getAllBanners(): Promise<ReferralBanner[]> {
    const client = this.supabaseService.getServiceClient();

    const { data, error } = await client
      .from('referral_banners')
      .select('*')
      .order('display_order', { ascending: true });

    if (error) {
      this.logger.error(`Failed to get all banners: ${error.message}`);
      return [];
    }

    return data as ReferralBanner[];
  }

  /**
   * Create a banner (admin)
   */
  async createBanner(
    banner: Omit<ReferralBanner, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ReferralBanner> {
    const client = this.supabaseService.getServiceClient();

    const { data, error } = await client
      .from('referral_banners')
      .insert(banner)
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to create banner: ${error.message}`);
      throw new BadRequestException('Failed to create banner');
    }

    return data as ReferralBanner;
  }

  /**
   * Update a banner (admin)
   */
  async updateBanner(
    id: string,
    updates: Partial<Omit<ReferralBanner, 'id' | 'created_at' | 'updated_at'>>,
  ): Promise<ReferralBanner> {
    const client = this.supabaseService.getServiceClient();

    const { data, error } = await client
      .from('referral_banners')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to update banner: ${error.message}`);
      throw new BadRequestException('Failed to update banner');
    }

    return data as ReferralBanner;
  }

  /**
   * Delete a banner (admin)
   */
  async deleteBanner(id: string): Promise<void> {
    const client = this.supabaseService.getServiceClient();

    const { error } = await client
      .from('referral_banners')
      .delete()
      .eq('id', id);

    if (error) {
      this.logger.error(`Failed to delete banner: ${error.message}`);
      throw new BadRequestException('Failed to delete banner');
    }
  }

  /**
   * Reorder banners (admin)
   */
  async reorderBanners(
    orders: { id: string; display_order: number }[],
  ): Promise<void> {
    const client = this.supabaseService.getServiceClient();

    for (const order of orders) {
      const { error } = await client
        .from('referral_banners')
        .update({ display_order: order.display_order })
        .eq('id', order.id);

      if (error) {
        this.logger.error(
          `Failed to reorder banner ${order.id}: ${error.message}`,
        );
      }
    }
  }

  /**
   * Get admin analytics
   */
  async getAdminAnalytics(): Promise<AdminReferralAnalytics> {
    const client = this.supabaseService.getServiceClient();

    const { data, error } = await client
      .from('admin_referral_analytics')
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Failed to get admin analytics: ${error.message}`);
      return {
        total_referrals: 0,
        referrals_this_month: 0,
        pending_referrals: 0,
        completed_referrals: 0,
        total_credits_awarded: 0,
        total_referral_codes: 0,
        conversion_rate: 0,
      };
    }

    return data as AdminReferralAnalytics;
  }

  /**
   * Get top referrers leaderboard
   */
  async getTopReferrers(limit: number = 10): Promise<TopReferrer[]> {
    const client = this.supabaseService.getServiceClient();

    // Get all referrals with credits info
    const { data: allReferrals, error } = await client
      .from('referrals')
      .select('referrer_id, status, credits_awarded');

    if (error) {
      this.logger.error(`Failed to get top referrers: ${error.message}`);
      return [];
    }

    if (!allReferrals || allReferrals.length === 0) {
      return [];
    }

    // Aggregate by referrer
    const referrerMap = new Map<
      string,
      {
        user_id: string;
        username: string | null;
        full_name: string | null;
        total_referred: number;
        completed_referrals: number;
        total_credits_earned: number;
      }
    >();

    for (const ref of allReferrals) {
      const existing = referrerMap.get(ref.referrer_id);
      if (existing) {
        existing.total_referred++;
        if (ref.status === 'completed' || ref.status === 'credited') {
          existing.completed_referrals++;
        }
        existing.total_credits_earned += ref.credits_awarded || 0;
      } else {
        referrerMap.set(ref.referrer_id, {
          user_id: ref.referrer_id,
          username: null,
          full_name: null,
          total_referred: 1,
          completed_referrals:
            ref.status === 'completed' || ref.status === 'credited' ? 1 : 0,
          total_credits_earned: ref.credits_awarded || 0,
        });
      }
    }

    // Fetch profiles for all referrers
    const referrerIds = Array.from(referrerMap.keys());
    if (referrerIds.length > 0) {
      const { data: profiles } = await client
        .from('profiles')
        .select('id, username, full_name')
        .in('id', referrerIds);

      if (profiles) {
        for (const p of profiles) {
          const referrer = referrerMap.get(p.id);
          if (referrer) {
            referrer.username = p.username;
            referrer.full_name = p.full_name;
          }
        }
      }
    }

    // Sort by total referred and return top N
    return Array.from(referrerMap.values())
      .sort((a, b) => b.total_referred - a.total_referred)
      .slice(0, limit);
  }

  /**
   * Get referral info for a specific user (admin view)
   */
  async getUserReferralInfo(userId: string): Promise<{
    referredBy: {
      id: string;
      username: string | null;
      full_name: string | null;
    } | null;
    referralsMade: ReferralWithUser[];
    totalCreditsEarned: number;
  }> {
    const client = this.supabaseService.getServiceClient();

    // Check if user was referred
    const { data: referralRecord } = await client
      .from('referrals')
      .select('*')
      .eq('referred_user_id', userId)
      .single();

    let referredBy: {
      id: string;
      username: string | null;
      full_name: string | null;
    } | null = null;
    if (referralRecord) {
      // Fetch referrer profile separately
      const { data: referrerProfile } = await client
        .from('profiles')
        .select('id, username, full_name')
        .eq('id', referralRecord.referrer_id)
        .single();

      if (referrerProfile) {
        referredBy = {
          id: referrerProfile.id,
          username: referrerProfile.username,
          full_name: referrerProfile.full_name,
        };
      }
    }

    // Get referrals made by this user
    const { referrals } = await this.getUserReferrals(userId, { limit: 100 });

    // Calculate total credits earned
    const totalCreditsEarned = referrals.reduce(
      (sum, r) => sum + (r.credits_awarded || 0),
      0,
    );

    return {
      referredBy,
      referralsMade: referrals,
      totalCreditsEarned,
    };
  }

  /**
   * Mask a name for privacy (show first letter + asterisks)
   */
  private maskName(name: string): string {
    if (!name || name.length < 2) return '***';
    const parts = name.split(' ');
    return parts
      .map((part) => {
        if (part.length < 2) return '*';
        return part[0] + '*'.repeat(Math.min(part.length - 1, 5));
      })
      .join(' ');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN CODE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get all referral codes with pagination and filtering (admin)
   */
  async getAllCodes(options?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: 'active' | 'inactive' | 'all';
  }): Promise<{
    codes: Array<
      ReferralCode & {
        user?: {
          username: string | null;
          email: string | null;
          full_name: string | null;
        };
      }
    >;
    total: number;
    page: number;
    limit: number;
  }> {
    const client = this.supabaseService.getServiceClient();
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const offset = (page - 1) * limit;
    const search = options?.search?.trim().toLowerCase();
    const status = options?.status || 'all';

    let query = client.from('referral_codes').select('*', { count: 'exact' });

    if (status === 'active') {
      query = query.eq('is_active', true);
    } else if (status === 'inactive') {
      query = query.eq('is_active', false);
    }

    if (search) {
      query = query.ilike('code', `%${search}%`);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      this.logger.error(`Failed to get all codes: ${error.message}`);
      return { codes: [], total: 0, page, limit };
    }

    const userIds = (data || []).map((c) => c.user_id);
    const usersMap = new Map<
      string,
      {
        username: string | null;
        email: string | null;
        full_name: string | null;
      }
    >();

    if (userIds.length > 0) {
      const { data: profiles } = await client
        .from('profiles')
        .select('id, username, full_name')
        .in('id', userIds);

      if (profiles) {
        for (const p of profiles) {
          usersMap.set(p.id, {
            username: p.username,
            email: null,
            full_name: p.full_name,
          });
        }
      }

      const { data: authUsers } = await client.auth.admin.listUsers();
      if (authUsers?.users) {
        for (const u of authUsers.users) {
          const existing = usersMap.get(u.id);
          if (existing) {
            existing.email = u.email || null;
          } else {
            usersMap.set(u.id, {
              username: null,
              email: u.email || null,
              full_name: null,
            });
          }
        }
      }
    }

    const codes = (data || []).map((c) => ({
      ...c,
      user: usersMap.get(c.user_id) || undefined,
    }));

    return { codes, total: count || 0, page, limit };
  }

  /**
   * Update a referral code (admin)
   */
  async updateCode(
    id: string,
    updates: { is_active?: boolean },
  ): Promise<ReferralCode> {
    const client = this.supabaseService.getServiceClient();

    const { data, error } = await client
      .from('referral_codes')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to update code: ${error.message}`);
      throw new BadRequestException('Failed to update referral code');
    }

    return data as ReferralCode;
  }

  /**
   * Delete a referral code (admin)
   */
  async deleteCode(id: string): Promise<void> {
    const client = this.supabaseService.getServiceClient();

    const { data: code } = await client
      .from('referral_codes')
      .select('id')
      .eq('id', id)
      .single();

    if (!code) {
      throw new NotFoundException('Referral code not found');
    }

    await client
      .from('referrals')
      .update({ referral_code_id: null })
      .eq('referral_code_id', id);

    const { error } = await client.from('referral_codes').delete().eq('id', id);

    if (error) {
      this.logger.error(`Failed to delete code: ${error.message}`);
      throw new BadRequestException('Failed to delete referral code');
    }
  }

  /**
   * Create a referral code for a specific user (admin)
   */
  async createCodeForUser(userId: string): Promise<ReferralCode> {
    const client = this.supabaseService.getServiceClient();

    const { data: existingCode } = await client
      .from('referral_codes')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (existingCode) {
      throw new BadRequestException('User already has a referral code');
    }

    const { data: profile } = await client
      .from('profiles')
      .select('username')
      .eq('id', userId)
      .single();

    return this.getOrCreateReferralCode(userId, profile?.username || undefined);
  }
}
