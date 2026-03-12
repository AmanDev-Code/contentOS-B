import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../services/supabase.service';
import { Subscription, SubscriptionStatus, PlanType } from '../common/types';

@Injectable()
export class SubscriptionRepository {
  constructor(private supabaseService: SupabaseService) {}

  async findByUserId(userId: string): Promise<Subscription | null> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) return null;
    return data;
  }

  async create(
    userId: string,
    plan: PlanType,
    currentPeriodEnd?: Date,
  ): Promise<Subscription> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('subscriptions')
      .insert({
        user_id: userId,
        plan,
        status: SubscriptionStatus.ACTIVE,
        current_period_end: currentPeriodEnd,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updatePlan(
    userId: string,
    plan: PlanType,
    currentPeriodEnd?: Date,
  ): Promise<Subscription> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('subscriptions')
      .update({
        plan,
        current_period_end: currentPeriodEnd,
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateStatus(
    userId: string,
    status: SubscriptionStatus,
  ): Promise<Subscription> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('subscriptions')
      .update({ status })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}
