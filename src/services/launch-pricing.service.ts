import {
  BadGatewayException,
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { PolarService } from './polar.service';
import {
  SubscriptionService,
  type SubscriptionPlan,
} from './subscription.service';

export interface LaunchPricingCurrencyTier {
  listMonthly: number;
  listYearly: number;
  offerMonthly: number;
  offerYearly: number;
}

export interface PublicLaunchPricingPlan {
  planType: string;
  INR: LaunchPricingCurrencyTier;
  USD: LaunchPricingCurrencyTier;
}

export interface PublicLaunchPricingConfig {
  id: string;
  label: string;
  description: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  plans: PublicLaunchPricingPlan[];
  /** INR per 1 USD (same as `usd_conversion_rate` in DB). */
  conversionRateINR: number;
  bannerText: string | null;
  badgeText: string | null;
}

export interface LaunchPricingConfig {
  id: string;
  label: string;
  is_active: boolean;
  base_currency: string;
  standard_monthly_inr: number;
  pro_monthly_inr: number;
  ultimate_monthly_inr: number;
  standard_monthly_usd: number;
  pro_monthly_usd: number;
  ultimate_monthly_usd: number;
  standard_yearly_inr: number;
  pro_yearly_inr: number;
  ultimate_yearly_inr: number;
  standard_yearly_usd: number;
  pro_yearly_usd: number;
  ultimate_yearly_usd: number;
  usd_conversion_rate: number;
  yearly_discount_percent: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface CreateLaunchPricingInput {
  label: string;
  standardMonthlyInr: number;
  proMonthlyInr: number;
  ultimateMonthlyInr: number;
  usdConversionRate?: number;
  yearlyDiscountPercent?: number;
}

export interface UpdateLaunchPricingInput {
  label?: string;
  standardMonthlyInr?: number;
  proMonthlyInr?: number;
  ultimateMonthlyInr?: number;
  usdConversionRate?: number;
  yearlyDiscountPercent?: number;
  standardMonthlyUsd?: number;
  proMonthlyUsd?: number;
  ultimateMonthlyUsd?: number;
  standardYearlyInr?: number;
  proYearlyInr?: number;
  ultimateYearlyInr?: number;
  standardYearlyUsd?: number;
  proYearlyUsd?: number;
  ultimateYearlyUsd?: number;
}

export interface PricingDisplayData {
  plans: {
    standard: {
      monthly: { inr: number; usd: number };
      yearly: { inr: number; usd: number };
      monthlyLabel: string;
      yearlyLabel: string;
    };
    pro: {
      monthly: { inr: number; usd: number };
      yearly: { inr: number; usd: number };
      monthlyLabel: string;
      yearlyLabel: string;
    };
    ultimate: {
      monthly: { inr: number; usd: number };
      yearly: { inr: number; usd: number };
      monthlyLabel: string;
      yearlyLabel: string;
    };
  };
  config: {
    id: string;
    label: string;
    baseCurrency: string;
    usdConversionRate: number;
    yearlyDiscountPercent: number;
  };
}

@Injectable()
export class LaunchPricingService {
  private readonly logger = new Logger(LaunchPricingService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly polarService: PolarService,
    @Inject(forwardRef(() => SubscriptionService))
    private readonly subscriptionService: SubscriptionService,
  ) {}

  private db() {
    return this.supabaseService.getServiceClient();
  }

  /**
   * Calculate prices for all plans based on INR inputs
   */
  calculatePrices(
    standardMonthlyInr: number,
    proMonthlyInr: number,
    ultimateMonthlyInr: number,
    usdConversionRate: number,
    yearlyDiscountPercent: number,
  ): Omit<
    LaunchPricingConfig,
    | 'id'
    | 'label'
    | 'is_active'
    | 'base_currency'
    | 'created_at'
    | 'updated_at'
    | 'created_by'
  > {
    // Calculate USD monthly prices
    const standardMonthlyUsd = parseFloat(
      (standardMonthlyInr / usdConversionRate).toFixed(2),
    );
    const proMonthlyUsd = parseFloat(
      (proMonthlyInr / usdConversionRate).toFixed(2),
    );
    const ultimateMonthlyUsd = parseFloat(
      (ultimateMonthlyInr / usdConversionRate).toFixed(2),
    );

    // Calculate yearly INR prices with discount
    const standardYearlyInr = Math.round(
      standardMonthlyInr * 12 * (1 - yearlyDiscountPercent / 100),
    );
    const proYearlyInr = Math.round(
      proMonthlyInr * 12 * (1 - yearlyDiscountPercent / 100),
    );
    const ultimateYearlyInr = Math.round(
      ultimateMonthlyInr * 12 * (1 - yearlyDiscountPercent / 100),
    );

    // Calculate yearly USD prices
    const standardYearlyUsd = parseFloat(
      (standardYearlyInr / usdConversionRate).toFixed(2),
    );
    const proYearlyUsd = parseFloat(
      (proYearlyInr / usdConversionRate).toFixed(2),
    );
    const ultimateYearlyUsd = parseFloat(
      (ultimateYearlyInr / usdConversionRate).toFixed(2),
    );

    return {
      standard_monthly_inr: standardMonthlyInr,
      pro_monthly_inr: proMonthlyInr,
      ultimate_monthly_inr: ultimateMonthlyInr,
      standard_monthly_usd: standardMonthlyUsd,
      pro_monthly_usd: proMonthlyUsd,
      ultimate_monthly_usd: ultimateMonthlyUsd,
      standard_yearly_inr: standardYearlyInr,
      pro_yearly_inr: proYearlyInr,
      ultimate_yearly_inr: ultimateYearlyInr,
      standard_yearly_usd: standardYearlyUsd,
      pro_yearly_usd: proYearlyUsd,
      ultimate_yearly_usd: ultimateYearlyUsd,
      usd_conversion_rate: usdConversionRate,
      yearly_discount_percent: yearlyDiscountPercent,
    };
  }

  /**
   * Get all launch pricing configs ordered by creation date
   */
  async list(): Promise<LaunchPricingConfig[]> {
    const { data, error } = await this.db()
      .from('launch_pricing_configs')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw new BadGatewayException(error.message);
    }

    return (data || []) as LaunchPricingConfig[];
  }

  /**
   * Get a single launch pricing config by ID
   */
  async getById(id: string): Promise<LaunchPricingConfig> {
    const { data, error } = await this.db()
      .from('launch_pricing_configs')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new BadGatewayException(error.message);
    }

    if (!data) {
      throw new NotFoundException('Launch pricing config not found');
    }

    return data as LaunchPricingConfig;
  }

  /**
   * Get the currently active launch pricing config
   */
  async getActive(): Promise<LaunchPricingConfig | null> {
    const { data, error } = await this.db()
      .from('launch_pricing_configs')
      .select('*')
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      throw new BadGatewayException(error.message);
    }

    return (data as LaunchPricingConfig) || null;
  }

  /**
   * Create a new launch pricing config
   */
  async create(
    input: CreateLaunchPricingInput,
    createdBy?: string,
  ): Promise<LaunchPricingConfig> {
    const usdConversionRate = input.usdConversionRate ?? 83.5;
    const yearlyDiscountPercent = input.yearlyDiscountPercent ?? 17.0;

    // Validate inputs
    if (
      input.standardMonthlyInr <= 0 ||
      input.proMonthlyInr <= 0 ||
      input.ultimateMonthlyInr <= 0
    ) {
      throw new BadRequestException('All INR prices must be positive');
    }

    if (usdConversionRate <= 0) {
      throw new BadRequestException('USD conversion rate must be positive');
    }

    if (yearlyDiscountPercent < 0 || yearlyDiscountPercent > 100) {
      throw new BadRequestException(
        'Yearly discount must be between 0 and 100',
      );
    }

    const payload = {
      label: input.label.trim(),
      is_active: false, // New configs are inactive by default
      base_currency: 'INR',
      standard_monthly_inr: input.standardMonthlyInr,
      pro_monthly_inr: input.proMonthlyInr,
      ultimate_monthly_inr: input.ultimateMonthlyInr,
      usd_conversion_rate: usdConversionRate,
      yearly_discount_percent: yearlyDiscountPercent,
      created_by: createdBy ?? null,
    };

    const { data, error } = await this.db()
      .from('launch_pricing_configs')
      .insert(payload)
      .select('*')
      .single();

    if (error) {
      throw new BadGatewayException(error.message);
    }

    const created = data as LaunchPricingConfig;
    if (created.is_active) {
      await this.syncPolarForConfig(created);
    }
    return created;
  }

  /**
   * Update a launch pricing config
   */
  async update(
    id: string,
    input: UpdateLaunchPricingInput,
  ): Promise<LaunchPricingConfig> {
    const existing = await this.getById(id);

    // Build patch object
    const patch: Record<string, unknown> = {};

    if (input.label !== undefined) patch.label = input.label.trim();
    if (input.standardMonthlyInr !== undefined)
      patch.standard_monthly_inr = input.standardMonthlyInr;
    if (input.proMonthlyInr !== undefined)
      patch.pro_monthly_inr = input.proMonthlyInr;
    if (input.ultimateMonthlyInr !== undefined)
      patch.ultimate_monthly_inr = input.ultimateMonthlyInr;
    if (input.usdConversionRate !== undefined)
      patch.usd_conversion_rate = input.usdConversionRate;
    if (input.yearlyDiscountPercent !== undefined)
      patch.yearly_discount_percent = input.yearlyDiscountPercent;

    // Validate numeric inputs
    const standardInr =
      input.standardMonthlyInr ?? existing.standard_monthly_inr;
    const proInr = input.proMonthlyInr ?? existing.pro_monthly_inr;
    const ultimateInr =
      input.ultimateMonthlyInr ?? existing.ultimate_monthly_inr;
    const conversionRate =
      input.usdConversionRate ?? existing.usd_conversion_rate;
    const discount =
      input.yearlyDiscountPercent ?? existing.yearly_discount_percent;

    if (standardInr <= 0 || proInr <= 0 || ultimateInr <= 0) {
      throw new BadRequestException('All INR prices must be positive');
    }

    if (conversionRate <= 0) {
      throw new BadRequestException('USD conversion rate must be positive');
    }

    if (discount < 0 || discount > 100) {
      throw new BadRequestException(
        'Yearly discount must be between 0 and 100',
      );
    }

    const { data, error } = await this.db()
      .from('launch_pricing_configs')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      throw new BadGatewayException(error.message);
    }

    const updated = data as LaunchPricingConfig;
    if (updated.is_active) {
      await this.syncPolarForConfig(updated);
    }
    return updated;
  }

  /**
   * Delete a launch pricing config
   */
  async delete(id: string): Promise<void> {
    const { error } = await this.db()
      .from('launch_pricing_configs')
      .delete()
      .eq('id', id);

    if (error) {
      throw new BadGatewayException(error.message);
    }
  }

  /**
   * Toggle the active status of a config
   * Only one config can be active at a time
   */
  async toggleActive(
    id: string,
    isActive: boolean,
  ): Promise<LaunchPricingConfig> {
    const config = await this.getById(id);

    if (isActive && !config.is_active) {
      // Deactivate any other active configs first
      const { error: deactivateError } = await this.db()
        .from('launch_pricing_configs')
        .update({ is_active: false })
        .eq('is_active', true);

      if (deactivateError) {
        throw new BadGatewayException(deactivateError.message);
      }
    }

    const { data, error } = await this.db()
      .from('launch_pricing_configs')
      .update({ is_active: isActive })
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      throw new BadGatewayException(error.message);
    }

    const toggled = data as LaunchPricingConfig;
    if (isActive) {
      await this.syncPolarForConfig(toggled);
    } else {
      await this.revertPolarToCatalog();
    }
    return toggled;
  }

  /**
   * Manually push active launch USD amounts to Polar products (admin action).
   */
  async syncPolarForConfig(config: LaunchPricingConfig): Promise<{
    synced: number;
    skipped: string[];
    success: boolean;
    error?: string;
  }> {
    try {
      const result = await this.polarService.syncLaunchPricingToPolar(config);
      const polarErrors = result.skipped.filter(
        (s) => !s.includes('not configured') && !s.includes('missing'),
      );
      const success = result.synced > 0 && polarErrors.length === 0;
      if (!success) {
        this.logger.warn(
          `Launch pricing Polar sync incomplete: synced=${result.synced} skipped=${result.skipped.join('; ')}`,
        );
      }
      return {
        ...result,
        success,
        error:
          success || result.synced > 0
            ? undefined
            : polarErrors.join('; ') ||
              result.skipped.join('; ') ||
              'No Polar products were updated',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Launch pricing Polar sync failed', error);
      return {
        synced: 0,
        skipped: [],
        success: false,
        error: message,
      };
    }
  }

  /**
   * Restore Polar product prices from subscription_plans.display_pricing import.
   */
  async revertPolarToCatalog(): Promise<void> {
    if (!this.polarService.isPolarApiConfigured()) {
      return;
    }

    let defaultCurrency = 'USD';
    try {
      const payload = await this.subscriptionService.getPublicPlansPayload();
      defaultCurrency = payload.pricingDisplay?.defaultCurrency || 'USD';
    } catch (e) {
      this.logger.warn(
        'Could not load pricing display settings for Polar revert',
        e,
      );
    }

    const plans = await this.subscriptionService.getSubscriptionPlans();
    for (const planType of ['standard', 'pro', 'ultimate'] as const) {
      const plan = plans.find((p) => p.planType === planType);
      if (!plan?.displayPricing) continue;
      try {
        await this.polarService.syncPaidPlanPricesFromDisplayPricing(
          planType,
          plan.displayPricing as Record<string, any>,
          defaultCurrency,
          { force: true },
        );
      } catch (e) {
        this.logger.warn(`Polar catalog revert failed for ${planType}`, e);
      }
    }
    this.logger.log(
      'Polar catalog reverted from subscription plan display_pricing',
    );
  }

  /**
   * Build public launch-pricing payload for pricing/billing pages.
   * List prices come from subscription plan display tiers; offer prices from the active config.
   */
  async getPublicActiveConfig(
    subscriptionPlans: SubscriptionPlan[],
  ): Promise<PublicLaunchPricingConfig | null> {
    const config = await this.getActive();
    if (!config) return null;

    const planTypes = ['standard', 'pro', 'ultimate'] as const;
    const offerByType: Record<
      (typeof planTypes)[number],
      {
        inrMonthly: number;
        inrYearly: number;
        usdMonthly: number;
        usdYearly: number;
      }
    > = {
      standard: {
        inrMonthly: config.standard_monthly_inr,
        inrYearly: config.standard_yearly_inr,
        usdMonthly: Number(config.standard_monthly_usd),
        usdYearly: Number(config.standard_yearly_usd),
      },
      pro: {
        inrMonthly: config.pro_monthly_inr,
        inrYearly: config.pro_yearly_inr,
        usdMonthly: Number(config.pro_monthly_usd),
        usdYearly: Number(config.pro_yearly_usd),
      },
      ultimate: {
        inrMonthly: config.ultimate_monthly_inr,
        inrYearly: config.ultimate_yearly_inr,
        usdMonthly: Number(config.ultimate_monthly_usd),
        usdYearly: Number(config.ultimate_yearly_usd),
      },
    };

    const plans: PublicLaunchPricingPlan[] = planTypes.map((planType) => {
      const subPlan = subscriptionPlans.find((p) => p.planType === planType);
      const offer = offerByType[planType];
      const inrList = this.resolveListPrices(
        subPlan,
        'INR',
        config.usd_conversion_rate,
      );
      const usdList = this.resolveListPrices(
        subPlan,
        'USD',
        config.usd_conversion_rate,
      );

      return {
        planType,
        INR: {
          listMonthly: inrList.listMonthly,
          listYearly: inrList.listYearly,
          offerMonthly: offer.inrMonthly,
          offerYearly: offer.inrYearly,
        },
        USD: {
          listMonthly: usdList.listMonthly,
          listYearly: usdList.listYearly,
          offerMonthly: offer.usdMonthly,
          offerYearly: offer.usdYearly,
        },
      };
    });

    return {
      id: config.id,
      label: config.label,
      description: `${config.label} — limited-time pricing on Standard, Pro, and Ultimate.`,
      startDate: config.created_at,
      endDate: '',
      isActive: true,
      plans,
      conversionRateINR: Number(config.usd_conversion_rate),
      bannerText: `Save with ${config.label} on all paid plans.`,
      badgeText: config.label,
    };
  }

  private resolveListPrices(
    plan: SubscriptionPlan | undefined,
    currency: 'INR' | 'USD',
    usdToInrRate: number,
  ): { listMonthly: number; listYearly: number } {
    const tier = plan?.displayPricing?.[currency] ?? plan?.displayPricing?.USD;
    if (tier) {
      return {
        listMonthly: tier.listMonthly,
        listYearly: tier.listYearly,
      };
    }

    const monthly = plan?.priceMonthly ?? 0;
    const yearly = plan?.priceYearly ?? 0;
    if (currency === 'USD') {
      return { listMonthly: monthly, listYearly: yearly };
    }

    const rate = usdToInrRate > 0 ? usdToInrRate : 83.5;
    return {
      listMonthly: Math.round(monthly * rate),
      listYearly: Math.round(yearly * rate),
    };
  }

  /**
   * Get formatted display data for the active config
   * This is used by the frontend to show pricing
   */
  async getDisplayData(): Promise<PricingDisplayData | null> {
    const config = await this.getActive();
    if (!config) return null;

    return {
      plans: {
        standard: {
          monthly: {
            inr: config.standard_monthly_inr,
            usd: config.standard_monthly_usd,
          },
          yearly: {
            inr: config.standard_yearly_inr,
            usd: config.standard_yearly_usd,
          },
          monthlyLabel: this.formatPrice(config.standard_monthly_inr, 'INR'),
          yearlyLabel: this.formatPrice(config.standard_yearly_inr, 'INR'),
        },
        pro: {
          monthly: { inr: config.pro_monthly_inr, usd: config.pro_monthly_usd },
          yearly: { inr: config.pro_yearly_inr, usd: config.pro_yearly_usd },
          monthlyLabel: this.formatPrice(config.pro_monthly_inr, 'INR'),
          yearlyLabel: this.formatPrice(config.pro_yearly_inr, 'INR'),
        },
        ultimate: {
          monthly: {
            inr: config.ultimate_monthly_inr,
            usd: config.ultimate_monthly_usd,
          },
          yearly: {
            inr: config.ultimate_yearly_inr,
            usd: config.ultimate_yearly_usd,
          },
          monthlyLabel: this.formatPrice(config.ultimate_monthly_inr, 'INR'),
          yearlyLabel: this.formatPrice(config.ultimate_yearly_inr, 'INR'),
        },
      },
      config: {
        id: config.id,
        label: config.label,
        baseCurrency: config.base_currency,
        usdConversionRate: config.usd_conversion_rate,
        yearlyDiscountPercent: config.yearly_discount_percent,
      },
    };
  }

  /**
   * Format a price with the appropriate currency symbol
   */
  private formatPrice(amount: number, currency: string): string {
    if (currency === 'INR') {
      return `₹${amount}`;
    }
    return `$${amount}`;
  }
}
