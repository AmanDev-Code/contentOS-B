import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { CacheService } from './cache.service';
import { getPublicPlans, getPlanConfig } from '../config/plans.config';

export interface UserSubscription {
  id: string;
  userId: string;
  planType: 'free' | 'standard' | 'pro' | 'ultimate';
  billingCycle: 'monthly' | 'yearly';
  creditsLimit: number;
  priceMonthly: number;
  priceYearly: number;
  isActive: boolean;
  subscriptionStartDate: string;
  subscriptionEndDate: string | null;
  resetDate: string;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
}

export interface SubscriptionPlan {
  id: string;
  planType: string;
  name: string;
  description: string;
  creditsLimit: number;
  priceMonthly: number;
  priceYearly: number;
  features: string[];
  isActive: boolean;
  sortOrder: number;
}

export interface BillingInfo {
  subscription: UserSubscription;
  plan: SubscriptionPlan;
  usage: {
    currentPeriodUsage: number;
    remainingCredits: number;
    percentageUsed: number;
    resetDate: string;
  };
  billing: {
    nextBillingDate: string;
    amount: number;
    currency: string;
    paymentMethod?: string;
  };
}

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
  ) {}

  async getUserSubscription(userId: string): Promise<UserSubscription | null> {
    // Security: Only allow users to access their own subscription
    const cacheKey = `subscription:${userId}`;
    const cached = await this.cacheService.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    try {
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('user_subscriptions')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // No subscription found, return null
          return null;
        }
        throw new Error(`Failed to get subscription: ${error.message}`);
      }

      const subscription: UserSubscription = {
        id: data.id,
        userId: data.user_id,
        planType: data.plan_type,
        billingCycle: data.billing_cycle,
        creditsLimit: data.credits_limit,
        priceMonthly: parseFloat(data.price_monthly || '0'),
        priceYearly: parseFloat(data.price_yearly || '0'),
        isActive: data.is_active,
        subscriptionStartDate: data.subscription_start_date,
        subscriptionEndDate: data.subscription_end_date,
        resetDate: data.reset_date,
        stripeSubscriptionId: data.stripe_subscription_id,
        stripeCustomerId: data.stripe_customer_id,
      };

      // Cache for 5 minutes
      await this.cacheService.set(cacheKey, JSON.stringify(subscription), 300);

      return subscription;
    } catch (error) {
      console.error('Error getting user subscription:', error);
      throw error;
    }
  }

  async getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    const cacheKey = 'subscription_plans';
    const cached = await this.cacheService.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    try {
      // Try to get from database first
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('subscription_plans')
        .select('*')
        .eq('is_active', true)
        .neq('plan_type', 'free') // Exclude free plan from public API
        .order('sort_order');

      let plans: SubscriptionPlan[];

      if (error || !data || data.length === 0) {
        console.log('Using fallback plan configuration');
        // Fallback to configuration file
        const configPlans = getPublicPlans();
        plans = configPlans.map((plan, index) => ({
          id: `config-${plan.planType}`,
          planType: plan.planType,
          name: plan.name,
          description: plan.description,
          creditsLimit: plan.creditsLimit,
          priceMonthly: plan.priceMonthly,
          priceYearly: plan.priceYearly,
          features: plan.features,
          isActive: true,
          sortOrder: index + 1,
        }));
      } else {
        plans = data.map((plan) => ({
          id: plan.id,
          planType: plan.plan_type,
          name: plan.name,
          description: plan.description,
          creditsLimit: plan.credits_limit,
          priceMonthly: parseFloat(plan.price_monthly),
          priceYearly: parseFloat(plan.price_yearly),
          features: plan.features || [],
          isActive: plan.is_active,
          sortOrder: plan.sort_order,
        }));
      }

      // Cache for 1 hour
      await this.cacheService.set(cacheKey, JSON.stringify(plans), 3600);

      return plans;
    } catch (error) {
      console.error('Error getting subscription plans:', error);

      // Final fallback to configuration
      const configPlans = getPublicPlans();
      return configPlans.map((plan, index) => ({
        id: `fallback-${plan.planType}`,
        planType: plan.planType,
        name: plan.name,
        description: plan.description,
        creditsLimit: plan.creditsLimit,
        priceMonthly: plan.priceMonthly,
        priceYearly: plan.priceYearly,
        features: plan.features,
        isActive: true,
        sortOrder: index + 1,
      }));
    }
  }

  async getBillingInfo(userId: string): Promise<BillingInfo> {
    const subscription = await this.getUserSubscription(userId);
    if (!subscription) {
      throw new NotFoundException('No active subscription found');
    }

    const plans = await this.getSubscriptionPlans();
    const plan = plans.find((p) => p.planType === subscription.planType);
    if (!plan) {
      throw new NotFoundException('Subscription plan not found');
    }

    // Get current usage from quota view
    const { data: quotaData, error: quotaError } = await this.supabaseService
      .getServiceClient()
      .from('user_quota_view')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (quotaError) {
      throw new Error(`Failed to get usage data: ${quotaError.message}`);
    }

    const usage = {
      currentPeriodUsage: quotaData.used_credits || 0,
      remainingCredits:
        quotaData.remaining_credits || subscription.creditsLimit,
      percentageUsed: parseFloat(quotaData.percentage_used || '0'),
      resetDate: quotaData.reset_date,
    };

    const billing = {
      nextBillingDate:
        subscription.subscriptionEndDate || subscription.resetDate,
      amount:
        subscription.billingCycle === 'yearly'
          ? subscription.priceYearly
          : subscription.priceMonthly,
      currency: 'USD',
      paymentMethod: subscription.stripeCustomerId
        ? 'Card ending in ****'
        : undefined,
    };

    return {
      subscription,
      plan,
      usage,
      billing,
    };
  }

  async updateSubscription(
    userId: string,
    planType: string,
    billingCycle: 'monthly' | 'yearly',
  ): Promise<UserSubscription> {
    // Get the plan details
    const plans = await this.getSubscriptionPlans();
    const plan = plans.find((p) => p.planType === planType);
    if (!plan) {
      throw new NotFoundException('Invalid plan type');
    }

    try {
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('user_subscriptions')
        .upsert(
          {
            user_id: userId,
            plan_type: planType,
            billing_cycle: billingCycle,
            credits_limit: plan.creditsLimit,
            price_monthly: plan.priceMonthly,
            price_yearly: plan.priceYearly,
            is_active: true,
            subscription_start_date: new Date().toISOString(),
            subscription_end_date:
              billingCycle === 'yearly'
                ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
                : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: 'user_id',
          },
        )
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to update subscription: ${error.message}`);
      }

      // Invalidate cache
      await this.cacheService.delete(`subscription:${userId}`);
      await this.cacheService.delete(`quota:${userId}`);

      const subscription = {
        id: data.id,
        userId: data.user_id,
        planType: data.plan_type,
        billingCycle: data.billing_cycle,
        creditsLimit: data.credits_limit,
        priceMonthly: parseFloat(data.price_monthly || '0'),
        priceYearly: parseFloat(data.price_yearly || '0'),
        isActive: data.is_active,
        subscriptionStartDate: data.subscription_start_date,
        subscriptionEndDate: data.subscription_end_date,
        resetDate: data.reset_date,
        stripeSubscriptionId: data.stripe_subscription_id,
        stripeCustomerId: data.stripe_customer_id,
      };

      return subscription;
    } catch (error) {
      console.error('Error updating subscription:', error);
      throw error;
    }
  }

  async cancelSubscription(userId: string): Promise<void> {
    try {
      const { error } = await this.supabaseService
        .getServiceClient()
        .from('user_subscriptions')
        .update({
          is_active: false,
          subscription_end_date: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);

      if (error) {
        throw new Error(`Failed to cancel subscription: ${error.message}`);
      }

      // Invalidate cache
      await this.cacheService.delete(`subscription:${userId}`);
      await this.cacheService.delete(`quota:${userId}`);
    } catch (error) {
      console.error('Error canceling subscription:', error);
      throw error;
    }
  }
}
