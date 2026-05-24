import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { CacheService } from './cache.service';
import { AppSettingsService, APP_SETTING_KEYS } from './app-settings.service';
import {
  getPublicPlans,
  getPlanConfig,
  PLAN_CONFIGURATIONS,
} from '../config/plans.config';
import { PolarService } from './polar.service';
import { LaunchPricingService } from './launch-pricing.service';

/** Display-only tiers per ISO 4217 code (marketing + app UI). Checkout uses Polar. */
export interface PlanDisplayTier {
  symbol: string;
  listMonthly: number;
  listYearly: number;
  offerMonthly: number | null;
  offerYearly: number | null;
}

export type PlanDisplayPricingMap = Record<string, PlanDisplayTier>;

export interface PricingDisplaySettings {
  defaultCurrency: string;
  supportedCurrencies: string[];
}

export type BillingProviderKind = 'polar';

export interface PublicPlansPayload {
  plans: SubscriptionPlan[];
  pricingDisplay: PricingDisplaySettings;
  /** Active processor for checkout and webhooks (from `BILLING_PROVIDER`). */
  billingProvider: BillingProviderKind;
}

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
  /** Polar subscription id (legacy Stripe columns may still hold older processor ids). */
  polarSubscriptionId?: string;
  polarCustomerId?: string;
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
  /** When null/empty, UI falls back to priceMonthly/priceYearly with USD formatting. */
  displayPricing?: PlanDisplayPricingMap | null;
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
  billingProvider: BillingProviderKind;
}

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
    private readonly polarService: PolarService,
    private readonly appSettingsService: AppSettingsService,
    @Inject(forwardRef(() => LaunchPricingService))
    private readonly launchPricingService: LaunchPricingService,
  ) {}

  getActiveBillingProviderKind(): BillingProviderKind {
    return 'polar';
  }

  private sanitizeDisplayPricing(raw: unknown): PlanDisplayPricingMap | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object') return null;
    const out: PlanDisplayPricingMap = {};
    for (const [code, val] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^[A-Za-z]{3}$/.test(code)) continue;
      const upper = code.toUpperCase();
      if (!val || typeof val !== 'object') continue;
      const v = val as Record<string, unknown>;
      const symbol =
        typeof v.symbol === 'string' && v.symbol.length ? v.symbol : upper;
      const listMonthly = Number(v.listMonthly);
      const listYearly = Number(v.listYearly);
      if (!Number.isFinite(listMonthly) || !Number.isFinite(listYearly)) continue;
      const om = v.offerMonthly;
      const oy = v.offerYearly;
      const offerMonthly =
        om === null || om === undefined || om === ''
          ? null
          : Number.isFinite(Number(om))
            ? Number(om)
            : null;
      const offerYearly =
        oy === null || oy === undefined || oy === ''
          ? null
          : Number.isFinite(Number(oy))
            ? Number(oy)
            : null;
      out[upper] = {
        symbol,
        listMonthly,
        listYearly,
        offerMonthly,
        offerYearly,
      };
    }
    return Object.keys(out).length ? out : null;
  }

  private mapRowToPlan(plan: Record<string, unknown>): SubscriptionPlan {
    const featuresRaw = plan.features;
    let features: string[] = [];
    if (Array.isArray(featuresRaw)) {
      features = featuresRaw.filter((x) => typeof x === 'string') as string[];
    }
    const displayRaw = Object.prototype.hasOwnProperty.call(
      plan,
      'display_pricing',
    )
      ? plan.display_pricing
      : (plan as { displayPricing?: unknown }).displayPricing;

    return {
      id: String(plan.id ?? ''),
      planType: String(plan.plan_type ?? plan.planType ?? ''),
      name: String(plan.name ?? ''),
      description: typeof plan.description === 'string' ? plan.description : '',
      creditsLimit: Number(plan.credits_limit ?? plan.creditsLimit ?? 0),
      priceMonthly: Number.parseFloat(
        String(plan.price_monthly ?? plan.priceMonthly ?? '0'),
      ),
      priceYearly: Number.parseFloat(
        String(plan.price_yearly ?? plan.priceYearly ?? '0'),
      ),
      features,
      isActive: Boolean(plan.is_active ?? plan.isActive ?? true),
      sortOrder: Number(plan.sort_order ?? plan.sortOrder ?? 0),
      displayPricing: this.sanitizeDisplayPricing(displayRaw),
    };
  }

  async getPricingDisplayMeta(): Promise<PricingDisplaySettings> {
    const raw = await this.appSettingsService.get<{
      defaultCurrency?: string;
      supportedCurrencies?: string[];
    }>(APP_SETTING_KEYS.PRICING_DISPLAY);

    let defaultCurrency =
      typeof raw?.defaultCurrency === 'string' &&
      /^[A-Z]{3}$/i.test(raw.defaultCurrency)
        ? raw.defaultCurrency.toUpperCase()
        : 'USD';

    let supportedCurrencies =
      Array.isArray(raw?.supportedCurrencies) && raw.supportedCurrencies.length
        ? raw.supportedCurrencies
            .filter((c): c is string => typeof c === 'string' && /^[A-Z]{3}$/i.test(c))
            .map((c) => c.toUpperCase())
        : ['USD', 'INR'];

    supportedCurrencies = Array.from(new Set(supportedCurrencies));
    if (!supportedCurrencies.includes(defaultCurrency)) {
      supportedCurrencies = [defaultCurrency, ...supportedCurrencies];
    }
    return { defaultCurrency, supportedCurrencies };
  }

  async upsertPricingDisplayMeta(
    body: PricingDisplaySettings,
    updatedBy?: string,
  ): Promise<boolean> {
    const ok = await this.appSettingsService.set(
      APP_SETTING_KEYS.PRICING_DISPLAY,
      {
        defaultCurrency: body.defaultCurrency,
        supportedCurrencies: body.supportedCurrencies,
      },
      updatedBy,
    );
    await this.cacheService.delete('subscription_plans');
    return ok;
  }

  async invalidateSubscriptionPlansCache(): Promise<void> {
    await this.cacheService.delete('subscription_plans');
  }

  async adminListAllPlans(): Promise<SubscriptionPlan[]> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('subscription_plans')
      .select('*')
      .order('sort_order');

    if (error || !data?.length) {
      return PLAN_CONFIGURATIONS.map((plan, index) => ({
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
        displayPricing: null,
      }));
    }

    return data.map((row) =>
      this.mapRowToPlan(row as Record<string, unknown>),
    );
  }

  async adminUpdateSubscriptionPlan(
    planType: string,
    patch: Partial<{
      name: string;
      description: string;
      creditsLimit: number;
      priceMonthly: number;
      priceYearly: number;
      features: string[];
      sortOrder: number;
      isActive: boolean;
      displayPricing: PlanDisplayPricingMap | null;
    }>,
  ): Promise<{ billingCatalogSynced: boolean }> {
    const allowed = ['free', 'standard', 'pro', 'ultimate'];
    if (!allowed.includes(planType)) {
      throw new NotFoundException('Invalid plan type');
    }

    const row: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.creditsLimit !== undefined)
      row.credits_limit = patch.creditsLimit;
    if (patch.priceMonthly !== undefined)
      row.price_monthly = patch.priceMonthly;
    if (patch.priceYearly !== undefined)
      row.price_yearly = patch.priceYearly;
    if (patch.features !== undefined) row.features = patch.features;
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
    if (patch.isActive !== undefined) row.is_active = patch.isActive;
    if (patch.displayPricing !== undefined) {
      row.display_pricing =
        patch.displayPricing === null ? null : patch.displayPricing;
    }

    const { error } = await this.supabaseService
      .getServiceClient()
      .from('subscription_plans')
      .update(row)
      .eq('plan_type', planType);

    if (error) {
      throw new Error(`Failed to update plan: ${error.message}`);
    }

    await this.invalidateSubscriptionPlansCache();

    /**
     * Polar catalog sync runs **after** the DB commit (Supabase update completes above).
     * If Polar rejects the update we throw `BadGatewayException`: operators should retry the same save;
     * the database already reflects the new display pricing until a retry succeeds.
     */
    let billingCatalogSynced = false;
    if (planType !== 'free') {
      const { data: fresh, error: readErr } = await this.supabaseService
        .getServiceClient()
        .from('subscription_plans')
        .select('display_pricing')
        .eq('plan_type', planType)
        .maybeSingle();
      if (readErr) {
        throw new Error(readErr.message);
      }
      const pricing = this.sanitizeDisplayPricing(fresh?.display_pricing);
      const meta = await this.getPricingDisplayMeta();
      if (this.polarService.syncPaidPlanPricesFromDisplayPricing) {
        billingCatalogSynced =
          await this.polarService.syncPaidPlanPricesFromDisplayPricing(
            planType as 'standard' | 'pro' | 'ultimate',
            pricing,
            meta.defaultCurrency,
          );
      }
    }

    return { billingCatalogSynced };
  }

  /** Live billing provider catalog snapshot (read-only). */
  async getBillingCatalogLiveSnapshot() {
    return this.polarService.fetchCatalogLiveSnapshot();
  }

  /**
   * Import display pricing from the Polar catalog into Supabase `display_pricing`
   * and update legacy `price_monthly` / `price_yearly` columns.
   */
  async importDisplayPricingFromBillingCatalog(): Promise<{
    ok: true;
    updatedPlanTypes: Array<'standard' | 'pro' | 'ultimate'>;
    warnings: string[];
  }> {
    const snap = await this.polarService.fetchCatalogLiveSnapshot();
    if (!snap.apiKeyConfigured) {
      throw new BadRequestException(
        'Configure POLAR_ACCESS_TOKEN on the server to read the catalog.',
      );
    }

    type PT = 'standard' | 'pro' | 'ultimate';
    const buckets: Record<
      PT,
      { monthly?: (typeof snap.items)[0]; yearly?: (typeof snap.items)[0] }
    > = {
      standard: {},
      pro: {},
      ultimate: {},
    };

    for (const row of snap.items) {
      const b = buckets[row.planType as PT];
      if (!b) continue;
      if (row.billingCycle === 'monthly') b.monthly = row;
      else b.yearly = row;
    }

    const fail: string[] = [];
    const warnings: string[] = [];
    for (const pt of ['standard', 'pro', 'ultimate'] as PT[]) {
      const b = buckets[pt];
      const m = b.monthly;
      const y = b.yearly;
      if (!m || m.error || m.amountMajor == null) {
        fail.push(`${pt}: missing or failed monthly catalog price read`);
      }
      if (!y || y.error || y.amountMajor == null) {
        fail.push(`${pt}: missing or failed yearly catalog price read`);
      }
      if (
        m?.currencyCode &&
        y?.currencyCode &&
        m.currencyCode !== y.currencyCode
      ) {
        warnings.push(
          `${pt}: monthly currency ${m.currencyCode} differs from yearly ${y.currencyCode} — tier key uses monthly’s ISO code.`,
        );
      }
    }

    if (fail.length) {
      throw new BadRequestException({
        message: 'Cannot import: verify POLAR_PRICE_* ids and Polar API responses.',
        errors: fail,
      });
    }

    const updatedPlanTypes: PT[] = [];

    for (const pt of ['standard', 'pro', 'ultimate'] as PT[]) {
      const b = buckets[pt];
      const monthly = b.monthly!;
      const yearly = b.yearly!;
      const tierCode = (
        monthly.currencyCode ||
        yearly.currencyCode ||
        ''
      ).toUpperCase();
      if (!tierCode) {
        throw new BadRequestException(`${pt}: could not resolve catalog currency`);
      }

      const { data: existing, error: readErr } = await this.supabaseService
        .getServiceClient()
        .from('subscription_plans')
        .select('display_pricing')
        .eq('plan_type', pt)
        .maybeSingle();

      if (readErr) {
        throw new Error(readErr.message);
      }

      const prev = this.sanitizeDisplayPricing(existing?.display_pricing) ?? {};
      const merged: PlanDisplayPricingMap = { ...prev };

      merged[tierCode] = {
        symbol:
          (prev[tierCode]?.symbol?.trim()?.length ?? 0) > 0
            ? prev[tierCode]!.symbol
            : tierCode === 'USD'
              ? '$'
              : tierCode,
        listMonthly: monthly.amountMajor!,
        listYearly: yearly.amountMajor!,
        offerMonthly: null,
        offerYearly: null,
      };

      const { error: upErr } = await this.supabaseService
        .getServiceClient()
        .from('subscription_plans')
        .update({
          display_pricing: merged as unknown as Record<string, unknown>,
          price_monthly: monthly.amountMajor!,
          price_yearly: yearly.amountMajor!,
          updated_at: new Date().toISOString(),
        })
        .eq('plan_type', pt);

      if (upErr) {
        throw new Error(`Failed to update ${pt}: ${upErr.message}`);
      }
      updatedPlanTypes.push(pt);
    }

    await this.invalidateSubscriptionPlansCache();

    return { ok: true, updatedPlanTypes, warnings };
  }

  async getPublicPlansPayload(): Promise<PublicPlansPayload> {
    const [plans, pricingDisplay] = await Promise.all([
      this.getSubscriptionPlans(),
      this.getPricingDisplayMeta(),
    ]);
    return {
      plans,
      pricingDisplay,
      billingProvider: this.getActiveBillingProviderKind(),
    };
  }

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
        polarSubscriptionId:
          data.polar_subscription_id || data.stripe_subscription_id,
        polarCustomerId: data.polar_customer_id || data.stripe_customer_id,
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
        .or('plan_type.eq.free,is_active.eq.true')
        .order('sort_order');

      let plans: SubscriptionPlan[];

      if (error || !data || data.length === 0) {
        console.log('Using fallback plan configuration');
        const freeCfg = PLAN_CONFIGURATIONS.find((p) => p.planType === 'free');
        const configPlans = freeCfg ? [freeCfg, ...getPublicPlans()] : getPublicPlans();
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
          displayPricing: null,
        }));
      } else {
        plans = data.map((plan) =>
          this.mapRowToPlan(plan as Record<string, unknown>),
        );
      }

      // Cache for 1 hour
      await this.cacheService.set(cacheKey, JSON.stringify(plans), 3600);

      return plans;
    } catch (error) {
      console.error('Error getting subscription plans:', error);

      const freeCfg = PLAN_CONFIGURATIONS.find((p) => p.planType === 'free');
      const configPlans = freeCfg ? [freeCfg, ...getPublicPlans()] : getPublicPlans();
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
        displayPricing: null,
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
          displayPricing: null,
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
        subscription.subscriptionEndDate ||
        subscription.resetDate ||
        new Date().toISOString(),
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
        id: row.polar_order_id || row.id,
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
    } else if (subscription.polarCustomerId) {
      // Fallback when webhook persistence is not available yet.
      const txns = await this.polarService.getCustomerTransactions(
        subscription.polarCustomerId,
        userId,
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
      const paymentMethod = await this.polarService.getPaymentMethodSummary(
        subscription.polarSubscriptionId,
        subscription.polarCustomerId,
        userId,
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
      billingProvider: this.getActiveBillingProviderKind(),
    };
  }

  async updateSubscription(
    userId: string,
    planType: string,
    billingCycle: 'monthly' | 'yearly',
  ): Promise<UserSubscription> {
    // Get the plan details
    const plans = await this.getSubscriptionPlans();
    let plan = plans.find((p) => p.planType === planType);
    if (!plan) {
      const cfg = getPlanConfig(planType);
      if (!cfg) {
        throw new NotFoundException('Invalid plan type');
      }
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
        displayPricing: null,
      };
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
        polarSubscriptionId:
          data.polar_subscription_id || data.stripe_subscription_id,
        polarCustomerId: data.polar_customer_id || data.stripe_customer_id,
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
      const current = await this.getUserSubscription(userId, {
        bypassCache: true,
      });
      const polarSubscriptionId = current?.polarSubscriptionId;
      if (polarSubscriptionId) {
        // Check if the subscription exists in the current Polar environment
        const subscriptionExists = await this.polarService.checkSubscriptionExists(polarSubscriptionId);
        if (!subscriptionExists) {
          // Subscription was created in a different environment (e.g., sandbox vs production)
          throw new BadRequestException({
            message: 'Your subscription was created in a different billing environment and cannot be cancelled here.',
            code: 'SUBSCRIPTION_ENVIRONMENT_MISMATCH',
            action: 'cancel_and_resubscribe',
            detail: 'Please cancel your current plan and subscribe fresh to continue.',
          });
        }
        await this.polarService.cancelSubscription(polarSubscriptionId);
      }

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
  ): Promise<UserSubscription> {
    const polarSubscriptionId = await this.resolvePolarSubscriptionId(userId);
    if (!polarSubscriptionId) {
      throw new BadRequestException(
        'No active Polar subscription found. Use checkout to subscribe.',
      );
    }

    // Check if the subscription exists in the current Polar environment
    const subscriptionExists = await this.polarService.checkSubscriptionExists(polarSubscriptionId);
    if (!subscriptionExists) {
      // Subscription was created in a different environment (e.g., sandbox vs production)
      throw new BadRequestException({
        message: 'Your subscription was created in a different billing environment and cannot be modified here.',
        code: 'SUBSCRIPTION_ENVIRONMENT_MISMATCH',
        action: 'cancel_and_resubscribe',
        detail: 'Please cancel your current plan and subscribe fresh to continue.',
      });
    }

    // Step 1: Update the subscription on Polar
    await this.polarService.changeSubscriptionPlan(
      polarSubscriptionId,
      planType,
      billingCycle,
    );

    // Step 2: Immediately update our database with the new plan
    // Get plan config for the target plan
    const plan = getPlanConfig(planType);
    if (!plan) {
      throw new BadRequestException(`Invalid plan type: ${planType}`);
    }

    const now = new Date();
    const periodEnd = new Date(now);
    if (billingCycle === 'yearly') {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    const basePayload: Record<string, unknown> = {
      plan_type: planType,
      billing_cycle: billingCycle,
      credits_limit: plan.creditsLimit,
      price_monthly: plan.priceMonthly,
      price_yearly: plan.priceYearly,
      is_active: true,
      updated_at: now.toISOString(),
      subscription_start_date: now.toISOString(),
      subscription_end_date: periodEnd.toISOString(),
    };

    // Try with race-condition guard columns first; fall back without them if they don't exist yet
    let updated: Record<string, unknown> | null = null;
    const fullPayload = {
      ...basePayload,
      last_updated_by: 'api',
      changed_at: now.toISOString(),
    };

    const { data: d1, error: e1 } = await this.supabaseService
      .getServiceClient()
      .from('user_subscriptions')
      .update(fullPayload)
      .eq('user_id', userId)
      .select()
      .single();

    if (!e1) {
      updated = d1;
    } else if (
      e1.message?.includes('last_updated_by') ||
      e1.message?.includes('changed_at') ||
      e1.code === '42703' // undefined_column
    ) {
      // Columns don't exist yet — retry without them
      console.warn(
        'changePlanForExistingSubscription: last_updated_by/changed_at columns missing, retrying without race-condition guard',
      );
      const { data: d2, error: e2 } = await this.supabaseService
        .getServiceClient()
        .from('user_subscriptions')
        .update(basePayload)
        .eq('user_id', userId)
        .select()
        .single();

      if (e2) {
        console.error('Error updating subscription in changePlanForExistingSubscription:', e2);
        throw new Error(`Failed to update subscription in database: ${e2.message}`);
      }
      updated = d2;
    } else {
      console.error('Error updating subscription in changePlanForExistingSubscription:', e1);
      throw new Error(`Failed to update subscription in database: ${e1.message}`);
    }

    // Clear cache so fresh data is returned
    await this.cacheService.delete(`subscription:${userId}`);
    await this.cacheService.delete(`quota:${userId}`);

    // Step 3: Skip Polar sync after a successful plan change
    // The database was already updated directly with the correct values above.
    // Re-querying Polar here creates a race condition where Polar might return
    // stale/cached data and overwrite our just-updated DB record.
    // Polar's webhooks will eventually sync any discrepancies when they arrive.

    // Return the updated subscription
    const row = updated as Record<string, any>;
    return {
      id: row.id,
      userId: row.user_id,
      planType: row.plan_type,
      billingCycle: row.billing_cycle,
      creditsLimit: row.credits_limit,
      priceMonthly: parseFloat(row.price_monthly || '0'),
      priceYearly: parseFloat(row.price_yearly || '0'),
      isActive: row.is_active,
      subscriptionStartDate: row.subscription_start_date,
      subscriptionEndDate: row.subscription_end_date,
      resetDate: row.reset_date,
      polarSubscriptionId: row.polar_subscription_id || row.stripe_subscription_id,
      polarCustomerId: row.polar_customer_id || row.stripe_customer_id,
      stripeSubscriptionId: row.stripe_subscription_id,
      stripeCustomerId: row.stripe_customer_id,
      trialConsumed: row.trial_consumed ?? false,
    };
  }

  /**
   * Pull the active Polar subscription into user_subscriptions (portal return / webhook delay).
   *
   * IMPORTANT: This method should NOT be called immediately after a plan change via
   * changePlanForExistingSubscription because Polar may return stale data.
   *
   * This method is intended for:
   * - User returning from Polar's customer portal (where they changed plan in Polar's UI)
   * - Manual sync when user thinks their plan is out of sync
   * - Periodic reconciliation (not immediate after API-driven changes)
   */
  async syncBillingFromPolar(userId: string): Promise<boolean> {
    const polarSubscriptionId = await this.resolvePolarSubscriptionId(userId);
    if (!polarSubscriptionId) {
      return false;
    }
    return this.polarService.syncSubscriptionPlanFromPolar(
      polarSubscriptionId,
      userId,
    );
  }

  private async resolvePolarSubscriptionId(userId: string): Promise<string | null> {
    const current = await this.getUserSubscription(userId, {
      bypassCache: true,
    });
    const stored =
      current?.polarSubscriptionId?.trim() ||
      current?.stripeSubscriptionId?.trim() ||
      '';
    if (stored) {
      return stored;
    }

    const fromPolar =
      await this.polarService.getActiveSubscriptionIdForUser(userId);
    if (!fromPolar) {
      return null;
    }

    await this.supabaseService
      .getServiceClient()
      .from('user_subscriptions')
      .update({
        polar_subscription_id: fromPolar,
        stripe_subscription_id: fromPolar,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    await this.cacheService.delete(`subscription:${userId}`);
    return fromPolar;
  }

  async getCustomerPortalUrl(
    userId: string,
    returnUrl: string,
  ): Promise<string> {
    const current = await this.getUserSubscription(userId, {
      bypassCache: true,
    });
    return this.polarService.createCustomerPortalSession(userId, returnUrl);
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
      .eq('polar_order_id', transactionId)
      .maybeSingle();

    if (!invoice) return null;
    if (invoice.minio_url) return invoice.minio_url;
    if (invoice.invoice_url) return invoice.invoice_url;

    const fetchedUrl = await this.polarService.getTransactionInvoiceUrl(transactionId);
    if (!fetchedUrl) return null;

    await this.supabaseService
      .getServiceClient()
      .from('billing_invoices')
      .update({ invoice_url: fetchedUrl, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('polar_order_id', transactionId);

    return fetchedUrl;
  }
}
