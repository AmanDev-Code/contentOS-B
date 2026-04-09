import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { CacheService } from './cache.service';
import { getPublicPlans, getPlanConfig } from '../config/plans.config';
import { PaddleService } from './paddle.service';

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
  paddleSubscriptionId?: string;
  paddleCustomerId?: string;
  // Backward compatibility during rollout.
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  trialConsumed?: boolean;
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
    history?: Array<{
      id: string;
      date: string;
      description: string;
      amount: string;
      status: string;
      invoice?: string;
      invoiceUrl?: string;
    }>;
  };
}

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
    private readonly paddleService: PaddleService,
  ) {}

  private formatBillingAmount(
    amount: number | string,
    currency: string,
    formattedFromProvider?: string,
  ): string {
    if (formattedFromProvider && typeof formattedFromProvider === 'string') {
      const numeric = formattedFromProvider.match(/-?\d+(?:\.\d+)?/);
      if (numeric?.[0]) {
        return `${Number.parseFloat(numeric[0]).toFixed(2)} ${currency}`;
      }
    }
    const raw = Number(amount);
    if (!Number.isFinite(raw)) return `${amount} ${currency}`;
    return `${raw.toFixed(2)} ${currency}`;
  }

  async getUserSubscription(
    userId: string,
    options?: { bypassCache?: boolean },
  ): Promise<UserSubscription | null> {
    // Security: Only allow users to access their own subscription
    const cacheKey = `subscription:${userId}`;
    const cached = options?.bypassCache
      ? null
      : await this.cacheService.get(cacheKey);

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
        paddleSubscriptionId:
          data.paddle_subscription_id || data.stripe_subscription_id,
        paddleCustomerId: data.paddle_customer_id || data.stripe_customer_id,
        stripeSubscriptionId: data.stripe_subscription_id,
        stripeCustomerId: data.stripe_customer_id,
        trialConsumed: data.trial_consumed ?? false,
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
    // Billing must always read fresh subscription state right after webhook updates.
    const subscription = await this.getUserSubscription(userId, {
      bypassCache: true,
    });
    if (!subscription) {
      throw new NotFoundException('No active subscription found');
    }

    // IMPORTANT: billing must resolve plan even when it's not public (e.g. free/trial).
    const plans = await this.getSubscriptionPlans();
    let plan = plans.find((p) => p.planType === subscription.planType);
    if (!plan) {
      const cfg = getPlanConfig(subscription.planType);
      if (cfg) {
        plan = {
          id: `cfg-${cfg.planType}`,
          planType: cfg.planType,
          name: cfg.name,
          description: cfg.description,
          creditsLimit: cfg.creditsLimit,
          priceMonthly: cfg.priceMonthly,
          priceYearly: cfg.priceYearly,
          features: cfg.features,
          isActive: true,
          sortOrder: 0,
        };
      }
    }
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
      paymentMethod: undefined as string | undefined,
      history: [] as Array<{
        id: string;
        date: string;
        description: string;
        amount: string;
        status: string;
        invoice?: string;
        invoiceUrl?: string;
      }>,
    };

    // Primary source: persisted invoice/payment records from webhooks.
    const { data: storedInvoices } = await this.supabaseService
      .getServiceClient()
      .from('billing_invoices')
      .select('*')
      .eq('user_id', userId)
      .order('issued_at', { ascending: false })
      .limit(20);
    if (storedInvoices?.length) {
      billing.history = storedInvoices.map((row) => ({
        id: row.paddle_transaction_id,
        date: row.issued_at || row.created_at,
        description: `${plan.name} Plan - ${subscription.billingCycle}`,
        amount: this.formatBillingAmount(
          row.amount,
          row.currency,
          row?.metadata?.transaction_details?.details?.totals
            ?.total_formatted ||
            row?.metadata?.webhook?.details?.totals?.total_formatted,
        ),
        status: row.status,
        invoice: row.invoice_number || undefined,
        invoiceUrl: row.minio_url || row.invoice_url || undefined,
      }));
    } else if (subscription.paddleCustomerId) {
      // Fallback when webhook persistence is not available yet.
      const txns = await this.paddleService.getCustomerTransactions(
        subscription.paddleCustomerId,
      );
      billing.history = txns.map((t) => ({
        id: t.id,
        date: t.createdAt,
        description: `${plan.name} Plan - ${subscription.billingCycle}`,
        amount: this.formatBillingAmount(t.amount, t.currency),
        status: t.status,
        invoice: t.invoiceNumber,
        invoiceUrl: t.invoiceUrl,
      }));
    }

    const { data: storedMethod } = await this.supabaseService
      .getServiceClient()
      .from('billing_payment_methods')
      .select('*')
      .eq('user_id', userId)
      .eq('is_primary', true)
      .maybeSingle();
    if (storedMethod?.card_last4) {
      billing.paymentMethod = `Card ending in ${storedMethod.card_last4}`;
    } else {
      const paymentMethod = await this.paddleService.getPaymentMethodSummary(
        subscription.paddleSubscriptionId,
        subscription.paddleCustomerId,
      );
      if (paymentMethod) {
        billing.paymentMethod = paymentMethod;
      }
    }

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
        paddleSubscriptionId:
          data.paddle_subscription_id || data.stripe_subscription_id,
        paddleCustomerId: data.paddle_customer_id || data.stripe_customer_id,
        stripeSubscriptionId: data.stripe_subscription_id,
        stripeCustomerId: data.stripe_customer_id,
        trialConsumed: data.trial_consumed ?? false,
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

  async changePlanForExistingSubscription(
    userId: string,
    planType: 'standard' | 'pro' | 'ultimate',
    billingCycle: 'monthly' | 'yearly',
  ): Promise<void> {
    const current = await this.getUserSubscription(userId);
    if (!current?.paddleSubscriptionId) {
      throw new Error('No active Paddle subscription found');
    }
    const ok = await this.paddleService.changeSubscriptionPlan(
      current.paddleSubscriptionId,
      planType,
      billingCycle,
    );
    if (!ok) {
      throw new Error('Failed to update subscription on Paddle');
    }
  }

  async resolveInvoiceDownloadUrl(
    userId: string,
    transactionId: string,
  ): Promise<string | null> {
    const { data: invoice } = await this.supabaseService
      .getServiceClient()
      .from('billing_invoices')
      .select('*')
      .eq('user_id', userId)
      .eq('paddle_transaction_id', transactionId)
      .maybeSingle();

    if (!invoice) return null;
    if (invoice.minio_url) return invoice.minio_url;
    if (invoice.invoice_url) return invoice.invoice_url;

    const fetchedUrl =
      await this.paddleService.getTransactionInvoiceUrl(transactionId);
    if (!fetchedUrl) return null;

    await this.supabaseService
      .getServiceClient()
      .from('billing_invoices')
      .update({ invoice_url: fetchedUrl, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('paddle_transaction_id', transactionId);

    return fetchedUrl;
  }
}
