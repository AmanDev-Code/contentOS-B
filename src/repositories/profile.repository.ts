import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../services/supabase.service';
import { Profile } from '../common/types';

@Injectable()
export class ProfileRepository {
  constructor(private supabaseService: SupabaseService) {}

  async findById(userId: string): Promise<Profile | null> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) throw error;
    return data;
  }

  async updateCredits(
    userId: string,
    creditsRemaining: number,
  ): Promise<Profile> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('profiles')
      .update({ credits_remaining: creditsRemaining, updated_at: new Date() })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateLinkedinTokens(
    userId: string,
    accessToken: string,
    refreshToken: string,
    expiresAt: Date,
  ): Promise<Profile> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('profiles')
      .update({
        linkedin_access_token: accessToken,
        linkedin_refresh_token: refreshToken,
        linkedin_expires_at: expiresAt,
        updated_at: new Date(),
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async clearLinkedinTokens(userId: string): Promise<Profile> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('profiles')
      .update({
        linkedin_access_token: null,
        linkedin_refresh_token: null,
        linkedin_expires_at: null,
        updated_at: new Date(),
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async incrementDailyCreditsUsed(userId: string): Promise<void> {
    const { error } = await this.supabaseService
      .getServiceClient()
      .rpc('increment_daily_credits', { user_id: userId });

    if (error) throw error;
  }

  async isUsernameTaken(
    username: string,
    excludeUserId?: string,
  ): Promise<boolean> {
    let query = this.supabaseService
      .getServiceClient()
      .from('profiles')
      .select('id')
      .eq('username', username.toLowerCase().trim())
      .limit(1);

    if (excludeUserId) {
      query = query.neq('id', excludeUserId);
    }

    const { data } = await query;
    return (data?.length ?? 0) > 0;
  }

  async updateProfile(
    userId: string,
    updates: { username?: string; full_name?: string; avatar_url?: string },
  ): Promise<Profile> {
    const payload: Record<string, unknown> = { updated_at: new Date() };
    if (updates.username !== undefined)
      payload.username = updates.username?.trim() || null;
    if (updates.full_name !== undefined)
      payload.full_name = updates.full_name?.trim() || null;
    if (updates.avatar_url !== undefined)
      payload.avatar_url = updates.avatar_url?.trim() || null;

    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('profiles')
      .update(payload)
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}
