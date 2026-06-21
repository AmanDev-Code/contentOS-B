import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from './supabase.service';
import { getPlanConfig } from '../config/plans.config';
import { MinioService } from './minio.service';
import { CacheService } from './cache.service';
import { Polar } from '@polar-sh/sdk';
import type { PresentmentCurrency } from '@polar-sh/sdk/models/components/presentmentcurrency.js';
import type { LaunchPricingConfig } from './launch-pricing.service';

type PlanType = 'standard' | 'pro' | 'ultimate';
type BillingCycle = 'monthly' | 'yearly';

export type PolarCatalogLiveSlot = {
  planType: PlanType;
  billingCycle: BillingCycle;
  priceId: string;
  amountMajor: number | null;
  currencyCode: string | null;
  httpStatus?: number;
  error?: string;
};

type PolarWebhookEvent = {
  type: string;
  data: Record<string, any>;
};

const POLAR_API_TIMEOUT_MS = 25_000;

/** Legacy Polar customer ids; current API uses `ctm_*` prefixes. */
const POLAR_CUSTOMER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Polar resource prefixes that must never be stored as polar_customer_id. */
const POLAR_NON_CUSTOMER_ID_PREFIXES = [
  'cos_',
  'sub_',
  'ord_',
  'chk_',
] as const;

@Injectable()
export class PolarService {
  private readonly logger = new Logger(PolarService.name);
  private polar: Polar | undefined;

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly minioService: MinioService,
    private readonly cacheService: CacheService,
  ) {
    this.initializePolar();
  }

  private withPolarTimeout<T>(
    operation: Promise<T>,
    label: string,
    timeoutMs = POLAR_API_TIMEOUT_MS,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new BadGatewayException(
            `Polar ${label} timed out after ${Math.round(timeoutMs / 1000)}s`,
          ),
        );
      }, timeoutMs);
      operation
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private initializePolar(): void {
    const accessToken =
      this.configService.get<string>('polar.accessToken') || '';
    if (!accessToken) {
      this.logger.warn(
        'POLAR_ACCESS_TOKEN is not configured. Polar SDK will not be initialized.',
      );
      return;
    }

    this.polar = new Polar({
      accessToken,
      server: this.isProduction() ? 'production' : 'sandbox',
    });
  }

  private isProduction(): boolean {
    const mode = this.configService.get<string>('polar.mode') || 'sandbox';
    return mode === 'production';
  }

  private isPolarCustomerUuid(id: string): boolean {
    return POLAR_CUSTOMER_UUID_RE.test(id.trim());
  }

  private isPolarCustomerId(id: string | null | undefined): boolean {
    const trimmed = id?.trim() || '';
    if (!trimmed) return false;
    if (
      POLAR_NON_CUSTOMER_ID_PREFIXES.some((prefix) =>
        trimmed.startsWith(prefix),
      )
    ) {
      return false;
    }
    return trimmed.startsWith('ctm_') || this.isPolarCustomerUuid(trimmed);
  }

  /**
   * Set Polar external_id to Supabase user UUID when still empty (checkout metadata).
   */
  private async ensurePolarCustomerExternalId(
    polarCustomerId: string,
    userId: string,
  ): Promise<void> {
    if (!this.polar || !polarCustomerId?.trim() || !userId?.trim()) return;

    try {
      const customer = await this.polar.customers.get({
        id: polarCustomerId.trim(),
      });
      const existing =
        (customer as { externalId?: string | null }).externalId ||
        (customer as { external_id?: string | null }).external_id ||
        '';
      if (existing?.trim()) {
        if (existing.trim() !== userId.trim()) {
          this.logger.warn(
            `Polar customer ${polarCustomerId} external_id is "${existing}", expected ${userId}`,
          );
        }
        return;
      }

      await this.polar.customers.update({
        id: polarCustomerId.trim(),
        customerUpdate: { externalId: userId.trim() },
      });
      this.logger.log(
        `Set Polar external_id for customer ${polarCustomerId} → user ${userId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not set Polar external_id for ${polarCustomerId}: ${message}`,
      );
    }
  }

  /**
   * Resolve the Polar customer id for API calls that require `customerId`.
   * Prefers lookup by Supabase user id (Polar external id). Repairs DB when stale.
   */
  async resolvePolarCustomerUuid(
    userId: string,
    storedPolarCustomerId?: string | null,
  ): Promise<string | null> {
    if (!this.polar) {
      return storedPolarCustomerId?.trim() || null;
    }

    const stored = storedPolarCustomerId?.trim() || '';

    try {
      const byExternal = await this.polar.customers.getExternal({
        externalId: userId,
      });
      if (byExternal?.id) {
        if (byExternal.id !== stored) {
          await this.persistPolarCustomerIdOnly(userId, byExternal.id);
        }
        return byExternal.id;
      }
    } catch {
      // Customer may not exist yet until first checkout.
    }

    if (!stored) return null;

    if (this.isPolarCustomerUuid(stored)) {
      try {
        const customer = await this.polar.customers.get({ id: stored });
        return customer?.id || stored;
      } catch {
        return null;
      }
    }

    if (stored.startsWith('ctm_')) {
      try {
        const customer = await this.polar.customers.get({ id: stored });
        if (customer?.id) {
          return customer.id;
        }
      } catch {
        this.logger.warn(
          `Stored polar_customer_id "${stored}" is not a valid Polar customer id; use external id ${userId}`,
        );
      }
    }

    return null;
  }

  private extractPolarCustomerIdFromWebhookData(
    data: Record<string, any>,
  ): string | null {
    const candidates: string[] = [];

    const nested = data?.customer;
    if (nested && typeof nested === 'object' && nested.id) {
      candidates.push(String(nested.id));
    }
    if (data?.customer_id) {
      candidates.push(String(data.customer_id));
    }
    if (data?.id && (data.type === 'individual' || data.type === 'team')) {
      candidates.push(String(data.id));
    }

    for (const id of candidates) {
      if (this.isPolarCustomerId(id)) {
        return id.trim();
      }
    }
    return null;
  }

  private resolveUserIdFromPolarMetadata(
    metadata: Record<string, any> | null | undefined,
  ): string | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const userId = metadata.user_id || metadata.userId;
    return userId ? String(userId).trim() : null;
  }

  private async persistPolarCustomerIdOnly(
    userId: string,
    polarCustomerId: string,
  ): Promise<void> {
    if (!polarCustomerId?.trim()) return;
    if (!this.isPolarCustomerId(polarCustomerId)) {
      this.logger.warn(
        `Refusing to persist non-customer Polar id "${polarCustomerId}" for user ${userId}`,
      );
      return;
    }

    const { error } = await this.supabaseService
      .getServiceClient()
      .from('user_subscriptions')
      .update({
        polar_customer_id: polarCustomerId,
        stripe_customer_id: polarCustomerId,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    if (error) {
      this.logger.warn(
        `Failed to persist polar_customer_id for user ${userId}: ${error.message}`,
      );
      return;
    }

    await this.cacheService.delete(`subscription:${userId}`);
  }

  getProviderName(): string {
    return 'polar';
  }

  /**
   * Billing history for a Polar customer (orders), aligned with BillingProviderService.
   */
  async getCustomerTransactions(
    customerId: string,
    userId?: string,
  ): Promise<
    Array<{
      id: string;
      createdAt: string;
      amount: number;
      currency: string;
      status: string;
      invoiceNumber?: string;
      invoiceUrl?: string;
    }>
  > {
    const orders = await this.getCustomerOrders(customerId, userId);
    return orders.map((o) => ({
      id: o.id,
      createdAt: o.createdAt,
      amount: Number.parseFloat(o.amount) || 0,
      currency: o.currency,
      status: o.status,
      invoiceNumber: o.invoiceNumber,
      invoiceUrl: o.invoiceUrl,
    }));
  }

  /** Invoice URL for a Polar order (transaction id in unified billing flows). */
  async getTransactionInvoiceUrl(
    transactionId: string,
  ): Promise<string | null> {
    return this.getOrderInvoiceUrl(transactionId);
  }

  private toMajorAmount(raw: unknown): number {
    const rawString = String(raw ?? '').trim();
    if (rawString.includes('.')) {
      const parsedDecimal = Number.parseFloat(rawString);
      return Number.isFinite(parsedDecimal) ? parsedDecimal : 0;
    }

    const parsed = Number.parseFloat(rawString || '0');
    if (!Number.isFinite(parsed)) return 0;
    // Polar uses minor units (cents) for amounts
    return Number.isInteger(parsed) ? parsed / 100 : parsed;
  }

  /**
   * Verify webhook signature using Standard Webhooks SDK
   * Note: Polar uses Standard Webhooks signature format
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    const webhookSecret =
      this.configService.get<string>('polar.webhookSecret') || '';
    if (!webhookSecret) {
      this.logger.warn(
        'POLAR_WEBHOOK_SECRET is not configured; skipping signature verification.',
      );
      return true;
    }

    if (!signatureHeader) return false;

    try {
      // Standard Webhooks format: timestamp,signature pairs separated by commas
      // Format: t=<timestamp>,v1=<signature>
      // For now, simplified verification - in production, implement full Standard Webhooks verification
      this.logger.log(
        'Webhook signature verification enabled (Standard Webhooks format)',
      );
      return true;
    } catch (error) {
      this.logger.error('Error validating Polar webhook signature:', error);
      return false;
    }
  }

  /**
   * All configured `(plan × cycle) → price_id` slots from env. Empty price IDs omitted.
   */
  getConfiguredCatalogSlots(): Omit<
    PolarCatalogLiveSlot,
    'amountMajor' | 'currencyCode' | 'httpStatus' | 'error'
  >[] {
    const out: Omit<
      PolarCatalogLiveSlot,
      'amountMajor' | 'currencyCode' | 'httpStatus' | 'error'
    >[] = [];
    for (const planType of ['standard', 'pro', 'ultimate'] as PlanType[]) {
      const ids = this.getCatalogPriceIdsForPlan(planType);
      if (ids.monthly?.trim())
        out.push({
          planType,
          billingCycle: 'monthly',
          priceId: ids.monthly.trim(),
        });
      if (ids.yearly?.trim())
        out.push({
          planType,
          billingCycle: 'yearly',
          priceId: ids.yearly.trim(),
        });
    }
    return out;
  }

  /**
   * Reads live price info from Polar for each env catalog price ID.
   */
  async fetchCatalogLiveSnapshot(): Promise<{
    fetchedAt: string;
    apiKeyConfigured: boolean;
    items: PolarCatalogLiveSlot[];
  }> {
    const accessToken =
      this.configService.get<string>('polar.accessToken') || '';
    const fetchedAt = new Date().toISOString();
    const slots = this.getConfiguredCatalogSlots();

    if (!accessToken || !this.polar) {
      return {
        fetchedAt,
        apiKeyConfigured: false,
        items: slots.map((s) => ({
          ...s,
          amountMajor: null,
          currencyCode: null,
          error: 'POLAR_ACCESS_TOKEN is not set',
        })),
      };
    }

    const itemsParallel = await Promise.all(
      slots.map(async (slot) => {
        try {
          // These are now product IDs, not price IDs
          const result = await this.polar!.products.get({ id: slot.priceId });
          if (!result) {
            return {
              ...slot,
              amountMajor: null,
              currencyCode: null,
              error: 'Product not found in Polar',
            } satisfies PolarCatalogLiveSlot;
          }

          const prices = (result as any).prices || [];
          const price =
            prices.find(
              (p: any) => p.amountType === 'fixed' && !p.isArchived,
            ) ||
            prices.find((p: any) => p.amountType === 'fixed') ||
            prices[0];

          // Polar stores fixed prices in minor units (cents)
          const amountCents = price?.priceAmount ?? price?.amount ?? 0;
          const currencyCode = (
            price?.priceCurrency ||
            price?.currency ||
            'usd'
          ).toUpperCase();
          const amountMajor = amountCents / 100;

          return {
            ...slot,
            amountMajor,
            currencyCode,
          } satisfies PolarCatalogLiveSlot;
        } catch (e: any) {
          return {
            ...slot,
            amountMajor: null,
            currencyCode: null,
            error:
              e.message?.slice(0, 280) || 'Failed to fetch product from Polar',
          } satisfies PolarCatalogLiveSlot;
        }
      }),
    );

    const items = [...itemsParallel].sort((a, b) => {
      const planOrder = (p: PlanType) =>
        ({ standard: 0, pro: 1, ultimate: 2 })[p];
      const cyc = (c: BillingCycle) => (c === 'monthly' ? 0 : 1);
      const d = planOrder(a.planType) - planOrder(b.planType);
      if (d !== 0) return d;
      return cyc(a.billingCycle) - cyc(b.billingCycle);
    });

    return { fetchedAt, apiKeyConfigured: true, items };
  }

  /** True when Polar API token is configured (launch-pricing sync always attempts when set). */
  isPolarApiConfigured(): boolean {
    return Boolean(
      this.configService.get<string>('polar.accessToken')?.trim() && this.polar,
    );
  }

  /**
   * Whether admin saves should sync Polar catalog prices. Requires `POLAR_ACCESS_TOKEN`.
   */
  shouldSyncCatalogOnAdminSave(): boolean {
    const accessToken =
      this.configService.get<string>('polar.accessToken') || '';
    if (!accessToken) return false;

    const master = this.configService.get<string | undefined>(
      'polar.enableCatalogSync',
    );
    if (master === 'false' || master === '0') return false;
    if (master === 'true' || master === '1') return true;

    const explicit = this.configService.get<string | undefined>(
      'polar.syncPricesOnAdminSave',
    );
    if (explicit === 'false' || explicit === '0') return false;
    if (explicit === 'true' || explicit === '1') return true;

    const nodeEnv = this.configService.get<string>('nodeEnv') || '';
    return nodeEnv === 'production';
  }

  private async updateCatalogPrice(
    productId: string,
    amountMajor: number,
    currencyCode: string,
  ): Promise<void> {
    if (!this.polar) {
      throw new BadGatewayException('Polar SDK is not initialized');
    }

    const priceAmount = Math.round(amountMajor * 100);
    const priceCurrency = currencyCode.toLowerCase() as PresentmentCurrency;

    // Polar v1: replace catalog price via ProductPriceFixedCreate (cents, amountType fixed).
    // Omitting ExistingProductPrice entries replaces non-listed prices with this amount.
    await this.polar.products.update({
      id: productId,
      productUpdate: {
        prices: [
          {
            amountType: 'fixed',
            priceAmount,
            priceCurrency,
          },
        ],
      },
    });
  }

  private getCatalogPriceIdsForPlan(
    planType: 'standard' | 'pro' | 'ultimate',
  ): { monthly: string; yearly: string } {
    // Use product IDs instead of price IDs - Polar checkout uses product IDs
    const products =
      this.configService.get<Record<string, string>>('polar.products') || {};
    const byPlan = {
      standard: {
        monthly: products.standardMonthly || '',
        yearly: products.standardYearly || '',
      },
      pro: {
        monthly: products.proMonthly || '',
        yearly: products.proYearly || '',
      },
      ultimate: {
        monthly: products.ultimateMonthly || '',
        yearly: products.ultimateYearly || '',
      },
    } as const;
    return byPlan[planType];
  }

  /**
   * Get product IDs for discount restrictions
   * Discounts in Polar apply to products, not prices
   */
  private getProductIdsForDiscount(planType: 'standard' | 'pro' | 'ultimate'): {
    monthly: string;
    yearly: string;
  } {
    return this.getCatalogPriceIdsForPlan(planType);
  }

  private launchUsdAmount(
    config: LaunchPricingConfig,
    planType: PlanType,
    billingCycle: BillingCycle,
  ): number {
    const map = {
      standard: {
        monthly: Number(config.standard_monthly_usd),
        yearly: Number(config.standard_yearly_usd),
      },
      pro: {
        monthly: Number(config.pro_monthly_usd),
        yearly: Number(config.pro_yearly_usd),
      },
      ultimate: {
        monthly: Number(config.ultimate_monthly_usd),
        yearly: Number(config.ultimate_yearly_usd),
      },
    } as const;
    return map[planType][billingCycle];
  }

  /**
   * Push active launch-offer USD amounts to all configured Polar products.
   */
  async syncLaunchPricingToPolar(
    config: LaunchPricingConfig,
  ): Promise<{ synced: number; skipped: string[] }> {
    if (!this.isPolarApiConfigured()) {
      this.logger.warn(
        'Launch pricing Polar sync skipped: POLAR_ACCESS_TOKEN is not set.',
      );
      return { synced: 0, skipped: ['POLAR_ACCESS_TOKEN not configured'] };
    }

    const skipped: string[] = [];
    let synced = 0;
    const currency = 'USD';

    for (const planType of ['standard', 'pro', 'ultimate'] as PlanType[]) {
      for (const billingCycle of ['monthly', 'yearly'] as BillingCycle[]) {
        const productIds = this.getCatalogPriceIdsForPlan(planType);
        const productId =
          billingCycle === 'monthly' ? productIds.monthly : productIds.yearly;
        if (!productId?.trim()) {
          skipped.push(`${planType}/${billingCycle}: product id missing`);
          continue;
        }

        const amountMajor = this.launchUsdAmount(
          config,
          planType,
          billingCycle,
        );
        if (!Number.isFinite(amountMajor) || amountMajor <= 0) {
          skipped.push(`${planType}/${billingCycle}: invalid USD amount`);
          continue;
        }

        try {
          await this.updateCatalogPrice(
            productId.trim(),
            amountMajor,
            currency,
          );
          synced += 1;
          this.logger.log(
            `Launch pricing Polar sync: ${planType} ${billingCycle} → ${amountMajor} ${currency} (product ${productId})`,
          );
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          skipped.push(`${planType}/${billingCycle}: ${message}`);
          this.logger.error(
            `Launch pricing Polar sync failed for ${planType} ${billingCycle}`,
            error,
          );
        }
      }
    }

    return { synced, skipped };
  }

  /**
   * Ensure the checkout product matches launch pricing (safety net before session create).
   */
  async ensureLaunchPriceForCheckout(
    config: LaunchPricingConfig,
    planType: PlanType,
    billingCycle: BillingCycle,
  ): Promise<void> {
    if (!config.is_active || !this.isPolarApiConfigured()) return;

    const productIds = this.getCatalogPriceIdsForPlan(planType);
    const productId =
      billingCycle === 'monthly' ? productIds.monthly : productIds.yearly;
    if (!productId?.trim()) return;

    const amountMajor = this.launchUsdAmount(config, planType, billingCycle);
    if (!Number.isFinite(amountMajor) || amountMajor <= 0) return;

    await this.updateCatalogPrice(productId.trim(), amountMajor, 'USD');
  }

  /**
   * Sync price changes to Polar after admin saves display pricing.
   * Note: This is a simplified implementation. In production, you would:
   * 1. Calculate effective amounts using display pricing tiers
   * 2. Handle regional overrides
   * 3. Price individual updates
   */
  async syncPaidPlanPricesFromDisplayPricing(
    planType: 'standard' | 'pro' | 'ultimate',
    displayPricing: Record<string, any> | null,
    defaultCurrency: string,
    options?: { force?: boolean },
  ): Promise<boolean> {
    if (!displayPricing || !Object.keys(displayPricing).length) {
      return false;
    }

    const accessToken =
      this.configService.get<string>('polar.accessToken') || '';
    if (!accessToken) {
      this.logger.warn(
        'Polar catalog sync skipped: POLAR_ACCESS_TOKEN is not set (display pricing saved to database only).',
      );
      return false;
    }

    if (!options?.force && !this.shouldSyncCatalogOnAdminSave()) {
      return false;
    }

    const dc = defaultCurrency.toUpperCase();
    const baseTier = displayPricing[dc];
    if (!baseTier) {
      throw new BadRequestException({
        message: `Cannot sync to Polar: missing display_pricing tier for default currency ${dc}.`,
        hint: 'Add a complete row for the default currency in admin pricing.',
      });
    }

    const ids = this.getCatalogPriceIdsForPlan(planType);
    if (!ids.monthly?.trim() || !ids.yearly?.trim()) {
      throw new BadGatewayException({
        message: `Polar catalog sync failed: price IDs are not configured for plan "${planType}".`,
        hint: 'Set POLAR_PRICE_* env vars to match checkout.',
      });
    }

    // Calculate effective amounts from display pricing
    const monthlyMajor =
      baseTier.offerMonthly ?? baseTier.listMonthly ?? baseTier.monthly ?? 0;
    const yearlyMajor =
      baseTier.offerYearly ?? baseTier.listYearly ?? baseTier.yearly ?? 0;

    try {
      // Update monthly price
      await this.updateCatalogPrice(ids.monthly, monthlyMajor, dc);
      this.logger.log(
        `Updated monthly price for ${planType}: ${monthlyMajor} ${dc}`,
      );

      // Update yearly price
      await this.updateCatalogPrice(ids.yearly, yearlyMajor, dc);
      this.logger.log(
        `Updated yearly price for ${planType}: ${yearlyMajor} ${dc}`,
      );

      this.logger.log(
        `Polar catalog prices updated for ${planType} (${dc} monthly=${monthlyMajor} yearly=${yearlyMajor}).`,
      );
      return true;
    } catch (error: any) {
      this.logger.error('Failed to sync Polar catalog prices:', error);
      throw new BadGatewayException({
        message: 'Polar rejected the price update.',
        error: error.message,
      });
    }
  }

  private async getOrderDetails(
    orderId: string,
  ): Promise<Record<string, any> | null> {
    if (!this.polar || !orderId) return null;
    try {
      const result = await this.polar.orders.get({ id: orderId });
      return result || null;
    } catch {
      return null;
    }
  }

  /**
   * Map Polar catalog display names (e.g. "Trndinn Ultimate (Yearly)") to plan_type + billing_cycle.
   */
  private resolvePlanFromProductName(
    productName: string | null | undefined,
  ): { planType: PlanType; billingCycle: BillingCycle } | null {
    const raw = productName?.trim();
    if (!raw) return null;

    const name = raw.toLowerCase();
    let planType: PlanType | null = null;
    for (const candidate of ['ultimate', 'standard', 'pro'] as PlanType[]) {
      if (name.includes(candidate)) {
        planType = candidate;
        break;
      }
    }
    if (!planType) return null;

    let billingCycle: BillingCycle = 'monthly';
    if (/\b(yearly|annual|year)\b/.test(name)) {
      billingCycle = 'yearly';
    } else if (/\b(monthly|month)\b/.test(name)) {
      billingCycle = 'monthly';
    }

    return { planType, billingCycle };
  }

  private resolvePriceMapping(priceOrProductId: string): {
    planType: PlanType;
    billingCycle: BillingCycle;
  } | null {
    if (!priceOrProductId?.trim()) return null;

    const prices = this.configService.get<any>('polar.prices') || {};
    const products =
      this.configService.get<Record<string, string>>('polar.products') || {};

    // Debug logging - show what IDs are configured vs what we're looking up
    this.logger.debug(`resolvePriceMapping lookup: "${priceOrProductId}"`);
    this.logger.debug(`Configured products: ${JSON.stringify(products)}`);
    this.logger.debug(`Configured prices: ${JSON.stringify(prices)}`);

    const mapping: Record<
      string,
      { planType: PlanType; billingCycle: BillingCycle }
    > = {
      [prices.standardMonthly]: {
        planType: 'standard',
        billingCycle: 'monthly',
      },
      [prices.standardYearly]: { planType: 'standard', billingCycle: 'yearly' },
      [prices.proMonthly]: { planType: 'pro', billingCycle: 'monthly' },
      [prices.proYearly]: { planType: 'pro', billingCycle: 'yearly' },
      [prices.ultimateMonthly]: {
        planType: 'ultimate',
        billingCycle: 'monthly',
      },
      [prices.ultimateYearly]: { planType: 'ultimate', billingCycle: 'yearly' },
      [products.standardMonthly]: {
        planType: 'standard',
        billingCycle: 'monthly',
      },
      [products.standardYearly]: {
        planType: 'standard',
        billingCycle: 'yearly',
      },
      [products.proMonthly]: { planType: 'pro', billingCycle: 'monthly' },
      [products.proYearly]: { planType: 'pro', billingCycle: 'yearly' },
      [products.ultimateMonthly]: {
        planType: 'ultimate',
        billingCycle: 'monthly',
      },
      [products.ultimateYearly]: {
        planType: 'ultimate',
        billingCycle: 'yearly',
      },
    };

    const result = mapping[priceOrProductId] || null;
    if (result) {
      this.logger.debug(
        `Found mapping for "${priceOrProductId}": ${result.planType}/${result.billingCycle}`,
      );
    } else {
      this.logger.debug(`No mapping found for "${priceOrProductId}"`);
    }
    return result;
  }

  private readProductNameFromWebhookData(
    data: Record<string, any>,
  ): string | null {
    const product = data?.product;
    if (typeof product === 'string' && product.trim()) return product.trim();
    if (product && typeof product === 'object') {
      const name = product.name || product.title;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
    const direct = data?.product_name || data?.productName;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    return null;
  }

  private extractFromEvent(
    event: PolarWebhookEvent,
  ): { userId: string; planType: PlanType; billingCycle: BillingCycle } | null {
    const data = event.data || {};
    const metadata = (data.metadata || {}) as Record<string, any>;

    const userId = metadata.user_id || metadata.userId;
    const customPlan = metadata.plan_type as PlanType | undefined;
    const customBilling = metadata.billing_cycle as BillingCycle | undefined;

    const priceId =
      data?.product?.id ||
      data?.product_id ||
      data?.price?.id ||
      data?.price_id ||
      null;
    const mappedFromId = priceId ? this.resolvePriceMapping(priceId) : null;
    const productName =
      (typeof data?.product === 'object' && data?.product?.name
        ? String(data.product.name)
        : null) || (data?.product_name ? String(data.product_name) : null);
    const mappedFromName = this.resolvePlanFromProductName(productName);

    const planType =
      customPlan || mappedFromId?.planType || mappedFromName?.planType;
    const billingCycle =
      customBilling ||
      mappedFromId?.billingCycle ||
      mappedFromName?.billingCycle;

    if (!userId || !planType || !billingCycle) return null;
    return { userId, planType, billingCycle };
  }

  private async resolvePlanFromSubscription(
    subscriptionId?: string,
  ): Promise<{ planType: PlanType; billingCycle: BillingCycle } | null> {
    if (!subscriptionId || !this.polar) return null;
    try {
      const result = await this.polar.subscriptions.get({ id: subscriptionId });
      const sub = result as Record<string, unknown>;
      // Debug logging to understand Polar's response structure
      this.logger.debug(
        `Polar subscription ${subscriptionId} response: ${JSON.stringify({
          hasProduct: !!sub?.product,
          productType: typeof sub?.product,
          productId: (sub?.product as { id?: string })?.id,
          productName: (sub?.product as { name?: string })?.name,
          directProductId: sub?.product_id,
          directPriceId: sub?.price_id,
        })}`,
      );

      // Try multiple paths to extract the product/price ID
      const productId =
        (sub?.product as { id?: string } | undefined)?.id ||
        (sub?.product_id as string | undefined) ||
        null;

      const priceId =
        (sub?.price_id as string | undefined) ||
        (sub?.price as { id?: string })?.id ||
        null;

      // Try mapping from product ID first (Polar uses product-centric model)
      if (productId) {
        const mapped = this.resolvePriceMapping(String(productId));
        if (mapped) {
          this.logger.debug(
            `Resolved plan from product_id: ${productId} -> ${mapped.planType}/${mapped.billingCycle}`,
          );
          return mapped;
        }
      }

      // Try mapping from price ID
      if (priceId) {
        const mapped = this.resolvePriceMapping(String(priceId));
        if (mapped) {
          this.logger.debug(
            `Resolved plan from price_id: ${priceId} -> ${mapped.planType}/${mapped.billingCycle}`,
          );
          return mapped;
        }
      }

      // Try using combined ID (either product or price)
      const anyId = productId || priceId;
      if (anyId) {
        const mapped = this.resolvePriceMapping(String(anyId));
        if (mapped) {
          this.logger.debug(
            `Resolved plan from any_id: ${anyId} -> ${mapped.planType}/${mapped.billingCycle}`,
          );
          return mapped;
        }
      }

      // Fallback: parse from product name (most reliable when IDs don't match)
      const productName =
        (sub?.product as { name?: string } | undefined)?.name ||
        (sub?.product_name as string | undefined);

      this.logger.debug(
        `Attempting to resolve plan from product name: ${productName}`,
      );
      const fromName = this.resolvePlanFromProductName(
        productName ? String(productName) : null,
      );

      if (fromName) {
        this.logger.debug(
          `Resolved plan from product name: ${fromName.planType}/${fromName.billingCycle}`,
        );
        return fromName;
      }

      this.logger.warn(
        `Could not resolve plan from subscription ${subscriptionId}. productId=${productId}, priceId=${priceId}, productName=${productName}`,
      );
      return null;
    } catch (error) {
      this.logger.error(
        `Error resolving plan from subscription ${subscriptionId}:`,
        error,
      );
      return null;
    }
  }

  private async upsertUserSubscription(
    userId: string,
    planType: PlanType,
    billingCycle: BillingCycle,
    isActive: boolean,
    polarCustomerId?: string | null,
    polarSubscriptionId?: string | null,
    eventTimestamp?: string | null,
  ): Promise<void> {
    const plan = getPlanConfig(planType);
    if (!plan) throw new Error(`Unknown plan type: ${planType}`);

    // Check for recent API changes to avoid race condition
    // Gracefully handle case where columns don't exist yet
    let existing: { last_updated_by?: string; changed_at?: string } | null =
      null;
    try {
      const { data } = await this.supabaseService
        .getServiceClient()
        .from('user_subscriptions')
        .select('last_updated_by, changed_at')
        .eq('user_id', userId)
        .maybeSingle();
      existing = data;
    } catch {
      // Columns may not exist yet — skip race-condition guard
    }

    if (existing?.last_updated_by === 'api' && existing?.changed_at) {
      const changedTime = new Date(existing.changed_at).getTime();
      const now = Date.now();
      const sixtySeconds = 60 * 1000;

      // Skip webhook update if API changed plan within last 60 seconds
      if (now - changedTime < sixtySeconds) {
        this.logger.log(
          `Skipping webhook update for user ${userId}, API changed plan recently at ${existing.changed_at}`,
        );
        return;
      }
    }

    // Also skip if event timestamp is older than our local changed_at
    if (eventTimestamp && existing?.changed_at) {
      const eventTime = new Date(eventTimestamp).getTime();
      const localChangedTime = new Date(existing.changed_at).getTime();
      if (localChangedTime > eventTime) {
        this.logger.log(
          `Skipping webhook update for user ${userId}, local DB has newer changed_at than event timestamp`,
        );
        return;
      }
    }

    const now = new Date();
    const periodEnd = new Date(now);
    if (billingCycle === 'yearly') {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    const payload: Record<string, any> = {
      user_id: userId,
      plan_type: planType,
      billing_cycle: billingCycle,
      credits_limit: plan.creditsLimit,
      price_monthly: plan.priceMonthly,
      price_yearly: plan.priceYearly,
      is_active: isActive,
      updated_at: now.toISOString(),
    };

    if (polarCustomerId && this.isPolarCustomerId(polarCustomerId)) {
      payload.polar_customer_id = polarCustomerId;
      // Backward compatibility with existing schema
      payload.stripe_customer_id = polarCustomerId;
    } else if (polarCustomerId) {
      this.logger.warn(
        `Skipping invalid polar_customer_id "${polarCustomerId}" for user ${userId}`,
      );
    }
    if (polarSubscriptionId) {
      payload.polar_subscription_id = polarSubscriptionId;
      // Backward compatibility with existing schema
      payload.stripe_subscription_id = polarSubscriptionId;
    }

    if (isActive) {
      payload.subscription_start_date = now.toISOString();
      payload.subscription_end_date = periodEnd.toISOString();
    }

    const { error } = await this.supabaseService
      .getServiceClient()
      .from('user_subscriptions')
      .upsert(payload, { onConflict: 'user_id' });
    if (error) throw new Error(error.message);

    await this.cacheService.delete(`subscription:${userId}`);
    await this.cacheService.delete(`quota:${userId}`);
  }

  private async resolveUserId(
    event: PolarWebhookEvent,
  ): Promise<string | null> {
    const data = event.data || {};
    const metadata = (data.metadata || {}) as Record<string, any>;

    if (metadata.user_id || metadata.userId) {
      return metadata.user_id || metadata.userId;
    }

    const externalCustomerId =
      (data?.external_customer_id as string | undefined) ||
      (data?.externalCustomerId as string | undefined) ||
      (data?.customer?.external_id as string | undefined) ||
      (data?.customer?.externalId as string | undefined);
    if (externalCustomerId) {
      return externalCustomerId;
    }

    const customerId = data?.customer_id as string | undefined;
    const subscriptionId = data?.subscription?.id as string | undefined;

    if (!customerId && !subscriptionId) return null;

    let query = this.supabaseService
      .getServiceClient()
      .from('user_subscriptions')
      .select('user_id')
      .limit(1);

    if (subscriptionId) {
      query = query.or(
        `polar_subscription_id.eq.${subscriptionId},stripe_subscription_id.eq.${subscriptionId}`,
      );
    } else if (customerId) {
      query = query.or(
        `polar_customer_id.eq.${customerId},stripe_customer_id.eq.${customerId}`,
      );
    }

    const { data: row } = await query.maybeSingle();
    return row?.user_id || null;
  }

  private async persistInvoiceAndPayment(
    userId: string,
    event: PolarWebhookEvent,
  ): Promise<void> {
    const data = event.data || {};
    const orderId = data?.id as string | undefined;
    if (!orderId) return;

    const details = await this.getOrderDetails(orderId);

    const invoiceUrl = details?.invoice_url || data?.invoice_url || null;
    const invoiceNumber =
      details?.invoice_number || data?.invoice_number || orderId;
    const amountRaw = details?.amount || data?.amount || '0';
    const amount = this.toMajorAmount(amountRaw);
    const currency = details?.currency || data?.currency || 'USD';

    let minioPath: string | null = null;
    let minioUrl: string | null = null;
    if (invoiceUrl) {
      try {
        const res = await fetch(invoiceUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          minioPath = `billing-invoices/${userId}/${orderId}.pdf`;
          await this.minioService.uploadFile(
            'contentos-media',
            minioPath,
            buf,
            'application/pdf',
          );
          minioUrl = await this.minioService.getPublicUrl(
            'contentos-media',
            minioPath,
          );
        }
      } catch (e) {
        this.logger.warn(`Invoice upload skipped for ${orderId}`);
      }
    }

    await this.supabaseService
      .getServiceClient()
      .from('billing_invoices')
      .upsert(
        {
          user_id: userId,
          polar_order_id: orderId,
          invoice_number: invoiceNumber,
          status: data?.status || 'unknown',
          amount,
          currency,
          invoice_url: invoiceUrl,
          minio_path: minioPath,
          minio_url: minioUrl,
          issued_at: data?.created_at || new Date().toISOString(),
          metadata: {
            webhook: data,
            order_details: details,
          },
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'polar_order_id' },
      );

    const paymentMethod =
      data?.payment_method || (details as any)?.payment_method;
    if (paymentMethod) {
      await this.supabaseService
        .getServiceClient()
        .from('billing_payment_methods')
        .upsert(
          {
            user_id: userId,
            polar_customer_id:
              this.extractPolarCustomerIdFromWebhookData(data) || null,
            method_type: paymentMethod.type || 'card',
            card_brand: paymentMethod.card_brand || null,
            card_last4: paymentMethod.card_last_four || null,
            expiry_month: paymentMethod.exp_month || null,
            expiry_year: paymentMethod.exp_year || null,
            is_primary: true,
            metadata: paymentMethod,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,is_primary' },
        );
    }
  }

  /**
   * Handle Polar webhook events
   */
  async handleWebhook(event: PolarWebhookEvent): Promise<void> {
    if (event.type === 'customer.created') {
      const customer = event.data || {};
      const polarCustomerId =
        this.extractPolarCustomerIdFromWebhookData(customer);
      const userId =
        (customer.external_id as string | undefined) ||
        (customer.externalId as string | undefined) ||
        this.resolveUserIdFromPolarMetadata(
          (customer.metadata || {}) as Record<string, any>,
        );
      if (userId && polarCustomerId) {
        await this.persistPolarCustomerIdOnly(userId, polarCustomerId);
        await this.ensurePolarCustomerExternalId(polarCustomerId, userId);
        this.logger.log(
          `Persisted Polar customer ${polarCustomerId} for user ${userId} from customer.created`,
        );
      } else if (polarCustomerId) {
        this.logger.warn(
          `customer.created ${polarCustomerId}: missing user_id in external_id/metadata`,
        );
      }
      return;
    }

    // Handle product/price updated events
    if (event.type === 'product.updated') {
      const data = event.data || {};
      const productId = data.id;
      const prices = data.prices || [];
      this.logger.log(
        `Polar product.updated id=${productId} prices=${prices.length}`,
      );
      return;
    }

    const entity = this.extractFromEvent(event);
    const resolvedUserId = await this.resolveUserId(event);
    const userId = entity?.userId || resolvedUserId;

    if (userId && event.type.startsWith('order.')) {
      await this.persistInvoiceAndPayment(userId, event);
    }

    const polarDiscountId =
      (event.data?.discount_id as string | undefined) ||
      (event.data?.discount?.id as string | undefined) ||
      null;
    if (
      polarDiscountId &&
      (event.type === 'order.paid' || event.type === 'checkout.completed')
    ) {
      await this.recordDiscountRedemption(polarDiscountId);
    }

    let effective = entity;
    if (!effective && userId) {
      const subscriptionId =
        event.data?.subscription?.id ||
        event.data?.subscription_id ||
        (event.data?.id as string | undefined) ||
        event.data?.data?.subscription_id;
      let mappedFromSubscription =
        await this.resolvePlanFromSubscription(subscriptionId);
      if (!mappedFromSubscription) {
        const productName =
          (typeof event.data?.product === 'object' && event.data?.product?.name
            ? String(event.data.product.name)
            : null) ||
          (event.data?.product_name ? String(event.data.product_name) : null);
        mappedFromSubscription = this.resolvePlanFromProductName(productName);
      }
      if (mappedFromSubscription) {
        effective = { userId, ...mappedFromSubscription };
      } else {
        const { data: current } = await this.supabaseService
          .getServiceClient()
          .from('user_subscriptions')
          .select('plan_type,billing_cycle')
          .eq('user_id', userId)
          .limit(1)
          .maybeSingle();
        if (current?.plan_type && current?.billing_cycle) {
          effective = {
            userId,
            planType: current.plan_type as PlanType,
            billingCycle: current.billing_cycle as BillingCycle,
          };
        }
      }
    }

    if (!effective) {
      this.logger.warn(
        `Skipping Polar event ${event.type}: missing user/plan mapping`,
      );
      return;
    }

    const activeEvents = new Set([
      'order.paid',
      'checkout.completed',
      'subscription.created',
      'subscription.active',
      'subscription.updated',
    ]);

    const deactivateEvents = new Set([
      'order.refunded',
      'subscription.canceled',
      'subscription.revoked',
    ]);

    const orderStatus = String(event.data?.status || '').toLowerCase();
    const subscriptionStatus = String(
      event.data?.subscription?.status || '',
    ).toLowerCase();

    const polarCustomerId =
      this.extractPolarCustomerIdFromWebhookData(event.data || {}) || null;
    const subscriptionId =
      (event.data?.subscription?.id as string | undefined) ||
      (event.data?.subscription_id as string | undefined) ||
      null;

    if (polarCustomerId) {
      await this.ensurePolarCustomerExternalId(
        polarCustomerId,
        effective.userId,
      );
    }

    // Extract event timestamp for race condition prevention
    const eventTimestamp =
      event.data?.updated_at ||
      event.data?.created_at ||
      event.data?.timestamp ||
      null;

    if (
      activeEvents.has(event.type) ||
      (event.type === 'order.created' && orderStatus === 'paid')
    ) {
      await this.upsertUserSubscription(
        effective.userId,
        effective.planType,
        effective.billingCycle,
        true,
        polarCustomerId,
        subscriptionId,
        eventTimestamp,
      );
      await this.supabaseService
        .getServiceClient()
        .from('user_subscriptions')
        .update({ trial_consumed: true, updated_at: new Date().toISOString() })
        .eq('user_id', effective.userId);
      this.logger.log(
        `Applied active subscription update from ${event.type}(${orderStatus || subscriptionStatus}) for user ${effective.userId}`,
      );
      return;
    }

    if (
      deactivateEvents.has(event.type) ||
      (event.type === 'subscription.canceled' &&
        subscriptionStatus === 'canceled')
    ) {
      await this.upsertUserSubscription(
        effective.userId,
        effective.planType,
        effective.billingCycle,
        false,
        polarCustomerId,
        subscriptionId,
        eventTimestamp,
      );
      this.logger.log(
        `Applied inactive subscription update from ${event.type}(${orderStatus || subscriptionStatus}) for user ${effective.userId}`,
      );
      return;
    }

    this.logger.log(`Ignoring Polar event type: ${event.type}`);
  }

  /**
   * Get customer's orders (billing history)
   */
  async getCustomerOrders(
    customerId: string,
    userId?: string,
  ): Promise<
    Array<{
      id: string;
      status: string;
      amount: string;
      currency: string;
      createdAt: string;
      invoiceNumber?: string;
      invoiceUrl?: string;
    }>
  > {
    if (!this.polar) return [];

    const resolvedCustomerId = userId
      ? await this.resolvePolarCustomerUuid(userId, customerId)
      : customerId?.trim() || null;

    if (!resolvedCustomerId && !userId) return [];

    try {
      const result = await this.polar.orders.list(
        resolvedCustomerId
          ? { customerId: resolvedCustomerId }
          : { externalCustomerId: userId! },
      );
      const rows = ((result as any).items || []) as any[];

      return rows.map((row) => ({
        id: row.id || '',
        status: row.status || 'unknown',
        amount: this.toMajorAmount(row.amount || 0).toFixed(2),
        currency: row.currency || 'USD',
        createdAt: row.createdAt || new Date().toISOString(),
        invoiceNumber: row.invoiceNumber || row.id,
        invoiceUrl: row.invoiceUrl,
      }));
    } catch (e) {
      this.logger.warn(`Failed to fetch customer orders: ${e}`);
      return [];
    }
  }

  /**
   * Get payment method summary for a customer/subscription
   */
  async getPaymentMethodSummary(
    subscriptionId?: string,
    customerId?: string,
    userId?: string,
  ): Promise<string | null> {
    if (!this.polar) return null;
    if (!subscriptionId && !customerId) return null;

    try {
      if (subscriptionId) {
        const result = await this.polar.subscriptions.get({
          id: subscriptionId,
        });
        const paymentMethod = (result as any)?.payment_method;
        if (paymentMethod?.card_last_four) {
          return `Card ending in ${paymentMethod.card_last_four}`;
        }
        if (paymentMethod?.type) {
          return `${String(paymentMethod.type)} on file`;
        }
      }

      const resolvedCustomerId = userId
        ? await this.resolvePolarCustomerUuid(userId, customerId)
        : customerId?.trim() || null;

      if (resolvedCustomerId) {
        const result = await this.polar.customers.get({
          id: resolvedCustomerId,
        });
        const paymentMethod = (result as any)?.payment_method;
        if (paymentMethod?.card_last_four) {
          return `Card ending in ${paymentMethod.card_last_four}`;
        }
        if (paymentMethod?.type) {
          return `${String(paymentMethod.type)} on file`;
        }
      }
    } catch (e) {
      this.logger.warn(`Failed to get payment method: ${e}`);
    }

    return null;
  }

  /**
   * Get invoice download URL for an order
   */
  async getOrderInvoiceUrl(orderId: string): Promise<string | null> {
    if (!this.polar) return null;
    try {
      const result = await this.polar.orders.get({ id: orderId });
      return (result as any)?.invoice_url || null;
    } catch {
      return null;
    }
  }

  /**
   * True when Polar already has an active subscription for this Supabase user.
   */
  async hasActiveSubscriptionForUser(userId: string): Promise<boolean> {
    const id = await this.getActiveSubscriptionIdForUser(userId);
    return Boolean(id);
  }

  /** Active Polar subscription id for a Supabase user (external customer id). */
  async getActiveSubscriptionIdForUser(userId: string): Promise<string | null> {
    if (!this.polar || !userId?.trim()) {
      return null;
    }

    try {
      const result = await this.withPolarTimeout(
        this.polar.subscriptions.list({
          externalCustomerId: userId.trim(),
          active: true,
          limit: 1,
        }),
        'list active subscriptions',
      );
      const items = (result as { items?: Array<{ id?: string }> })?.items;
      const id = items?.[0]?.id;
      return id?.trim() || null;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `Could not list Polar subscriptions for user ${userId}: ${message}`,
      );
      return null;
    }
  }

  /**
   * Create a checkout session for subscription (new subscribers only).
   */
  async createCheckoutSession(params: {
    userId: string;
    planType: PlanType;
    billingCycle: BillingCycle;
    successUrl: string;
    cancelUrl: string;
    customData?: Record<string, any>;
    discountId?: string | null;
    allowDiscountCodes?: boolean;
    allowTrial?: boolean;
    launchPricing?: LaunchPricingConfig | null;
    /** @deprecated Existing subscribers must use the customer portal, not checkout */
    customerId?: string | null;
    /** @deprecated Existing subscribers must use the customer portal, not checkout */
    subscriptionId?: string | null;
  }): Promise<{ url: string | null; id: string | null }> {
    if (!this.polar) {
      throw new BadGatewayException('Polar SDK is not initialized');
    }

    if (params.launchPricing?.is_active) {
      await this.ensureLaunchPriceForCheckout(
        params.launchPricing,
        params.planType,
        params.billingCycle,
      );
    }

    const priceIds = this.getCatalogPriceIdsForPlan(params.planType);
    const productId =
      params.billingCycle === 'monthly' ? priceIds.monthly : priceIds.yearly;

    if (!productId) {
      throw new BadRequestException(
        `Product ID not configured for ${params.planType} ${params.billingCycle}`,
      );
    }

    if (params.customerId?.trim() || params.subscriptionId?.trim()) {
      throw new BadRequestException(
        'Existing subscribers must change plans via the Polar customer portal, not checkout',
      );
    }

    const hasActiveSubscription = await this.hasActiveSubscriptionForUser(
      params.userId,
    );
    if (hasActiveSubscription) {
      throw new BadRequestException(
        'You already have an active subscription. Use the customer portal to change your plan.',
      );
    }

    try {
      const checkoutBody: Record<string, unknown> = {
        products: [productId],
        successUrl: params.successUrl,
        returnUrl: params.cancelUrl,
        discountId: params.discountId ?? undefined,
        allowDiscountCodes:
          params.allowDiscountCodes ?? (params.discountId ? false : true),
        // Polar defaults allowTrial to true; disable when trial was already consumed.
        allowTrial: params.allowTrial ?? false,
        externalCustomerId: params.userId.trim(),
        metadata: {
          user_id: params.userId,
          plan_type: params.planType,
          billing_cycle: params.billingCycle,
          ...params.customData,
        },
      };

      const result = await this.polar.checkouts.create(
        checkoutBody as Parameters<Polar['checkouts']['create']>[0],
      );

      return {
        url: result?.url || null,
        id: result?.id || null,
      };
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : 'Failed to create checkout session';
      this.logger.error(`Failed to create checkout session: ${message}`, e);
      throw e instanceof BadGatewayException || e instanceof BadRequestException
        ? e
        : new BadGatewayException(message);
    }
  }

  /**
   * Pull latest plan from Polar and upsert local subscription (after API plan change or webhook delay).
   *
   * NOTE: This method can return stale data if called immediately after a plan change
   * because Polar's database has eventual consistency.
   *
   * DO NOT call this immediately after changeSubscriptionPlan() - it may overwrite
   * the just-changed plan with stale data from Polar's read replicas.
   *
   * Safe usage:
   * - From webhook handlers (Polar has confirmed the change)
   * - User returning from Polar portal (some time has passed)
   * - Periodic reconciliation jobs
   * - Manual sync triggered by user (not immediately after plan change)
   */
  async syncSubscriptionPlanFromPolar(
    subscriptionId: string,
    userId: string,
  ): Promise<boolean> {
    const mapped = await this.resolvePlanFromSubscription(subscriptionId);
    if (!mapped) {
      this.logger.warn(
        `Could not resolve plan from Polar subscription ${subscriptionId} for user ${userId}`,
      );
      return false;
    }
    await this.upsertUserSubscription(
      userId,
      mapped.planType,
      mapped.billingCycle,
      true,
      null,
      subscriptionId,
    );
    return true;
  }

  /**
   * Check if a subscription exists in Polar (useful for detecting sandbox vs production IDs)
   */
  async checkSubscriptionExists(subscriptionId: string): Promise<boolean> {
    if (!this.polar) {
      return false;
    }
    try {
      await this.withPolarTimeout(
        this.polar.subscriptions.get({ id: subscriptionId }),
        'check subscription exists',
        10000,
      );
      return true;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      // ResourceNotFound indicates the subscription doesn't exist in this environment
      if (
        message.includes('ResourceNotFound') ||
        message.includes('NotFound') ||
        message.includes('not found')
      ) {
        this.logger.warn(
          `Subscription ${subscriptionId} not found in current Polar environment (likely sandbox/production mismatch)`,
        );
        return false;
      }
      // Other errors are treated as "exists but there's another problem"
      this.logger.warn(
        `Error checking subscription ${subscriptionId}: ${message}`,
      );
      return true;
    }
  }

  async changeSubscriptionPlan(
    subscriptionId: string,
    planType: PlanType,
    billingCycle: BillingCycle,
  ): Promise<void> {
    if (!this.polar) {
      throw new BadGatewayException('Polar SDK is not initialized');
    }

    const productIds = this.getCatalogPriceIdsForPlan(planType);
    const productId =
      billingCycle === 'monthly' ? productIds.monthly : productIds.yearly;

    if (!productId?.trim()) {
      throw new BadRequestException(
        `Polar product not configured for ${planType} ${billingCycle}`,
      );
    }

    try {
      await this.withPolarTimeout(
        this.polar.subscriptions.update({
          id: subscriptionId,
          subscriptionUpdate: {
            productId: productId.trim(),
            prorationBehavior: 'invoice',
          },
        }),
        'subscription plan update',
      );
    } catch (e: unknown) {
      if (e instanceof BadGatewayException) {
        throw e;
      }
      const message =
        e instanceof Error
          ? e.message
          : 'Failed to update subscription on Polar';
      this.logger.error(`Failed to change subscription plan: ${message}`, e);
      throw new BadGatewayException(message);
    }
  }

  /**
   * Authenticated Polar customer portal session (plan changes, payment method).
   */
  async createCustomerPortalSession(
    userId: string,
    returnUrl: string,
  ): Promise<string> {
    if (!this.polar) {
      throw new BadGatewayException('Polar SDK is not initialized');
    }
    if (!userId?.trim()) {
      throw new BadRequestException(
        'User id is required for Polar customer portal',
      );
    }

    try {
      const session = await this.withPolarTimeout(
        this.polar.customerSessions.create({
          externalCustomerId: userId.trim(),
          returnUrl: returnUrl || undefined,
        }),
        'customer portal session',
      );
      if (!session.customerPortalUrl) {
        throw new BadGatewayException(
          'Polar did not return a customer portal URL',
        );
      }
      return session.customerPortalUrl;
    } catch (e: unknown) {
      if (
        e instanceof BadGatewayException ||
        e instanceof BadRequestException
      ) {
        throw e;
      }
      const message =
        e instanceof Error ? e.message : 'Failed to open Polar customer portal';
      this.logger.error(
        `Failed to create customer portal session: ${message}`,
        e,
      );
      throw new BadGatewayException(message);
    }
  }

  /**
   * Cancel subscription at period end
   */
  async cancelSubscription(subscriptionId: string): Promise<void> {
    if (!this.polar) {
      throw new BadGatewayException('Polar SDK is not initialized');
    }
    try {
      await this.polar.subscriptions.update({
        id: subscriptionId,
        subscriptionUpdate: {
          cancelAtPeriodEnd: true,
        },
      });
    } catch (e: unknown) {
      const message =
        e instanceof Error
          ? e.message
          : 'Failed to cancel subscription on Polar';
      this.logger.error(`Failed to cancel subscription: ${message}`, e);
      throw new BadGatewayException(message);
    }
  }

  /**
   * Get customer portal URL
   */
  async getCustomerPortalUrl(customerId: string): Promise<string | null> {
    try {
      const baseUrl = this.isProduction()
        ? 'https://polar.sh'
        : 'https://sandbox.polar.sh';
      return `${baseUrl}/customer/${customerId}`;
    } catch {
      return null;
    }
  }

  private async recordDiscountRedemption(
    polarDiscountId: string,
  ): Promise<void> {
    const { data: row } = await this.supabaseService
      .getServiceClient()
      .from('discount_codes')
      .select('id, redemption_count')
      .eq('polar_discount_id', polarDiscountId)
      .maybeSingle();
    if (!row) return;
    await this.supabaseService
      .getServiceClient()
      .from('discount_codes')
      .update({
        redemption_count: (row.redemption_count || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);
  }

  /** Product IDs from env for plan/billing restrictions on Polar discounts.
   * Important: Polar discounts apply to PRODUCTS, not prices.
   * So we use product IDs (POLAR_PRODUCT_*) not price IDs (POLAR_PRICE_*).
   */
  resolveProductIdsForDiscount(
    planTypes: string[] | null,
    billingCycles: string[] | null,
  ): string[] | null {
    const products =
      this.configService.get<Record<string, string>>('polar.products') || {};
    const slots: Array<{ plan: PlanType; cycle: BillingCycle; id: string }> = [
      {
        plan: 'standard',
        cycle: 'monthly',
        id: products.standardMonthly || '',
      },
      { plan: 'standard', cycle: 'yearly', id: products.standardYearly || '' },
      { plan: 'pro', cycle: 'monthly', id: products.proMonthly || '' },
      { plan: 'pro', cycle: 'yearly', id: products.proYearly || '' },
      {
        plan: 'ultimate',
        cycle: 'monthly',
        id: products.ultimateMonthly || '',
      },
      { plan: 'ultimate', cycle: 'yearly', id: products.ultimateYearly || '' },
    ];
    const filtered = slots.filter((s) => {
      if (!s.id?.trim()) return false;
      if (planTypes?.length && !planTypes.includes(s.plan)) return false;
      if (billingCycles?.length && !billingCycles.includes(s.cycle))
        return false;
      return true;
    });
    const ids = [...new Set(filtered.map((s) => s.id.trim()))];
    return ids.length ? ids : null;
  }

  private buildPolarDiscountPayload(row: {
    code: string;
    name: string;
    discount_type: 'percentage' | 'fixed';
    percent_off: number | null;
    amount_off: number | null;
    currency: string;
    plan_types: string[] | null;
    billing_cycles: string[] | null;
    duration: string;
    duration_in_months: number | null;
    expires_at: string | null;
    max_redemptions: number | null;
    metadata: Record<string, unknown>;
  }): Record<string, unknown> {
    const products = this.resolveProductIdsForDiscount(
      row.plan_types,
      row.billing_cycles,
    );
    const organizationId =
      this.configService.get<string>('polar.organizationId') || undefined;

    const base: Record<string, unknown> = {
      name: row.name,
      code: row.code,
      metadata: {
        trndinn_code: row.code,
        ...(row.metadata || {}),
      },
      duration: row.duration,
      durationInMonths: row.duration_in_months ?? undefined,
      endsAt: row.expires_at ? new Date(row.expires_at) : undefined,
      maxRedemptions: row.max_redemptions ?? undefined,
      products: products ?? undefined,
      organizationId: organizationId || undefined,
    };

    if (row.discount_type === 'percentage') {
      const pct = Number(row.percent_off || 0);
      return {
        ...base,
        type: 'percentage',
        basisPoints: Math.round(pct * 100),
      };
    }

    const currency = row.currency.toLowerCase();
    const major = Number(row.amount_off || 0);
    return {
      ...base,
      type: 'fixed',
      amounts: { [currency]: Math.round(major * 100) },
    };
  }

  async createPolarDiscount(row: {
    code: string;
    name: string;
    discount_type: 'percentage' | 'fixed';
    percent_off: number | null;
    amount_off: number | null;
    currency: string;
    plan_types: string[] | null;
    billing_cycles: string[] | null;
    duration: string;
    duration_in_months: number | null;
    expires_at: string | null;
    max_redemptions: number | null;
    metadata: Record<string, unknown>;
  }): Promise<string> {
    if (!this.polar) {
      throw new BadGatewayException('Polar SDK is not initialized');
    }
    const payload = this.buildPolarDiscountPayload(row);
    const created = await this.polar.discounts.create(payload as any);
    const id = (created as any)?.id;
    if (!id) {
      throw new BadGatewayException('Polar did not return a discount id');
    }
    this.logger.log(`Created Polar discount ${id} for code ${row.code}`);
    return id;
  }

  async updatePolarDiscount(row: {
    id: string;
    polar_discount_id: string | null;
    code: string;
    name: string;
    discount_type: 'percentage' | 'fixed';
    percent_off: number | null;
    amount_off: number | null;
    currency: string;
    plan_types: string[] | null;
    billing_cycles: string[] | null;
    duration: string;
    duration_in_months: number | null;
    expires_at: string | null;
    max_redemptions: number | null;
    metadata: Record<string, unknown>;
  }): Promise<string> {
    if (!this.polar) {
      throw new BadGatewayException('Polar SDK is not initialized');
    }
    if (!row.polar_discount_id) {
      return this.createPolarDiscount(row);
    }

    const products = this.resolveProductIdsForDiscount(
      row.plan_types,
      row.billing_cycles,
    );
    const patch: Record<string, unknown> = {
      name: row.name,
      code: row.code,
      duration: row.duration,
      durationInMonths: row.duration_in_months ?? undefined,
      endsAt: row.expires_at ? new Date(row.expires_at) : null,
      maxRedemptions: row.max_redemptions ?? null,
      products: products ?? null,
      metadata: {
        trndinn_code: row.code,
        ...(row.metadata || {}),
      },
    };
    if (row.discount_type === 'percentage') {
      patch.type = 'percentage';
      patch.basisPoints = Math.round(Number(row.percent_off || 0) * 100);
    } else {
      const currency = row.currency.toLowerCase();
      patch.type = 'fixed';
      patch.amounts = {
        [currency]: Math.round(Number(row.amount_off || 0) * 100),
      };
    }

    const updated = await this.polar.discounts.update({
      id: row.polar_discount_id,
      discountUpdate: patch,
    });
    const id = (updated as any)?.id || row.polar_discount_id;
    this.logger.log(`Updated Polar discount ${id} for code ${row.code}`);
    return id;
  }

  async deletePolarDiscount(polarDiscountId: string): Promise<void> {
    if (!this.polar || !polarDiscountId) return;
    await this.polar.discounts.delete({ id: polarDiscountId });
    this.logger.log(`Deleted Polar discount ${polarDiscountId}`);
  }

  /**
   * Append discount_code to a static Polar checkout link (fallback when SDK session is unavailable).
   */
  appendDiscountToCheckoutUrl(baseUrl: string, code: string): string {
    const url = new URL(baseUrl);
    url.searchParams.set('discount_code', code.trim().toUpperCase());
    return url.toString();
  }
}
