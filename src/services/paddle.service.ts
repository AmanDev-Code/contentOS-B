import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { SupabaseService } from './supabase.service';
import { getPlanConfig } from '../config/plans.config';
import { MinioService } from './minio.service';
import { CacheService } from './cache.service';

type PlanType = 'standard' | 'pro' | 'ultimate';
type BillingCycle = 'monthly' | 'yearly';

type PaddleWebhookEvent = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  notification_id: string;
  data: Record<string, any>;
};

type PaddleApiListResponse<T> = {
  data?: T[];
};

@Injectable()
export class PaddleService {
  private readonly logger = new Logger(PaddleService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly minioService: MinioService,
    private readonly cacheService: CacheService,
  ) {}

  private toMajorAmount(raw: unknown): number {
    const rawString = String(raw ?? '').trim();
    if (rawString.includes('.')) {
      const parsedDecimal = Number.parseFloat(rawString);
      return Number.isFinite(parsedDecimal) ? parsedDecimal : 0;
    }

    const parsed = Number.parseFloat(rawString || '0');
    if (!Number.isFinite(parsed)) return 0;
    // Heuristic for Paddle minor-unit amounts in integer payloads.
    // Most webhook/API totals arrive as minor units when integer.
    return Number.isInteger(parsed) ? parsed / 100 : parsed;
  }

  private getApiBaseUrl(): string {
    const env = this.configService.get<string>('paddle.env') || 'sandbox';
    return env === 'production'
      ? 'https://api.paddle.com'
      : 'https://sandbox-api.paddle.com';
  }

  private async paddleGet<T>(path: string): Promise<T | null> {
    const apiKey = this.configService.get<string>('paddle.apiKey') || '';
    if (!apiKey) return null;

    const res = await fetch(`${this.getApiBaseUrl()}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      this.logger.warn(`Paddle API GET ${path} failed: ${res.status}`);
      return null;
    }

    return (await res.json()) as T;
  }

  private async paddlePatch<T>(path: string, payload: Record<string, any>): Promise<T | null> {
    const apiKey = this.configService.get<string>('paddle.apiKey') || '';
    if (!apiKey) return null;

    const res = await fetch(`${this.getApiBaseUrl()}${path}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.warn(`Paddle API PATCH ${path} failed: ${res.status} ${body}`);
      return null;
    }

    return (await res.json()) as T;
  }

  private async getTransactionDetails(
    transactionId: string,
  ): Promise<Record<string, any> | null> {
    const result = await this.paddleGet<{ data?: Record<string, any> }>(
      `/transactions/${encodeURIComponent(transactionId)}`,
    );
    return result?.data || null;
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    const secret = this.configService.get<string>('paddle.webhookSecret') || '';
    if (!secret) {
      this.logger.warn(
        'PADDLE_WEBHOOK_SECRET is missing; skipping signature verification.',
      );
      return true;
    }

    if (!signatureHeader) return false;

    const pairs = signatureHeader.split(';').map((chunk) => chunk.trim());
    const map = new Map<string, string>();
    for (const p of pairs) {
      const idx = p.indexOf('=');
      if (idx <= 0) continue;
      map.set(p.slice(0, idx), p.slice(idx + 1));
    }

    const ts = map.get('ts');
    const h1 = map.get('h1');
    if (!ts || !h1) return false;

    const payload = `${ts}:${rawBody}`;
    const computed = createHmac('sha256', secret).update(payload).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(computed), Buffer.from(h1));
    } catch {
      return false;
    }
  }

  private resolvePriceMapping(priceId: string): {
    planType: PlanType;
    billingCycle: BillingCycle;
  } | null {
    const prices = this.configService.get<any>('paddle.prices') || {};
    const mapping: Record<string, { planType: PlanType; billingCycle: BillingCycle }> = {
      [prices.standardMonthly]: { planType: 'standard', billingCycle: 'monthly' },
      [prices.standardYearly]: { planType: 'standard', billingCycle: 'yearly' },
      [prices.proMonthly]: { planType: 'pro', billingCycle: 'monthly' },
      [prices.proYearly]: { planType: 'pro', billingCycle: 'yearly' },
      [prices.ultimateMonthly]: { planType: 'ultimate', billingCycle: 'monthly' },
      [prices.ultimateYearly]: { planType: 'ultimate', billingCycle: 'yearly' },
    };
    return mapping[priceId] || null;
  }

  private extractFromEvent(
    event: PaddleWebhookEvent,
  ): { userId: string; planType: PlanType; billingCycle: BillingCycle } | null {
    const data = event.data || {};
    const custom = (data.custom_data || {}) as Record<string, any>;

    const userId = custom.user_id || custom.userId;
    const customPlan = custom.plan_type as PlanType | undefined;
    const customBilling = custom.billing_cycle as BillingCycle | undefined;

    const priceId =
      data?.items?.[0]?.price?.id ||
      data?.items?.[0]?.price_id ||
      data?.price_id ||
      null;
    const mapped = priceId ? this.resolvePriceMapping(priceId) : null;

    const planType = customPlan || mapped?.planType;
    const billingCycle = customBilling || mapped?.billingCycle;

    if (!userId || !planType || !billingCycle) return null;
    return { userId, planType, billingCycle };
  }

  private async resolvePlanFromSubscription(
    subscriptionId?: string,
  ): Promise<{ planType: PlanType; billingCycle: BillingCycle } | null> {
    if (!subscriptionId) return null;
    const result = await this.paddleGet<{ data?: Record<string, any> }>(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
    const priceId =
      result?.data?.items?.[0]?.price?.id ||
      result?.data?.items?.[0]?.price_id ||
      null;
    if (!priceId) return null;
    return this.resolvePriceMapping(priceId);
  }

  private async upsertUserSubscription(
    userId: string,
    planType: PlanType,
    billingCycle: BillingCycle,
    isActive: boolean,
    paddleCustomerId?: string | null,
    paddleSubscriptionId?: string | null,
  ): Promise<void> {
    const plan = getPlanConfig(planType);
    if (!plan) throw new Error(`Unknown plan type: ${planType}`);

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

    if (paddleCustomerId) {
      payload.paddle_customer_id = paddleCustomerId;
      // Backward compatibility for existing reads.
      payload.stripe_customer_id = paddleCustomerId;
    }
    if (paddleSubscriptionId) {
      payload.paddle_subscription_id = paddleSubscriptionId;
      payload.stripe_subscription_id = paddleSubscriptionId;
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

    // Ensure /subscription/billing reads fresh values right after webhook.
    await this.cacheService.delete(`subscription:${userId}`);
    await this.cacheService.delete(`quota:${userId}`);
  }

  private async resolveUserId(event: PaddleWebhookEvent): Promise<string | null> {
    const data = event.data || {};
    const custom = (data.custom_data || {}) as Record<string, any>;
    if (custom.user_id || custom.userId) {
      return custom.user_id || custom.userId;
    }

    const customerId = data?.customer_id as string | undefined;
    const subscriptionId = data?.subscription_id as string | undefined;
    if (!customerId && !subscriptionId) return null;

    let query = this.supabaseService
      .getServiceClient()
      .from('user_subscriptions')
      .select('user_id')
      .limit(1);

    if (subscriptionId) {
      query = query.or(
        `paddle_subscription_id.eq.${subscriptionId},stripe_subscription_id.eq.${subscriptionId}`,
      );
    } else if (customerId) {
      query = query.or(
        `paddle_customer_id.eq.${customerId},stripe_customer_id.eq.${customerId}`,
      );
    }

    const { data: row } = await query.maybeSingle();
    return row?.user_id || null;
  }

  private async persistInvoiceAndPayment(
    userId: string,
    event: PaddleWebhookEvent,
  ): Promise<void> {
    const data = event.data || {};
    const transactionId = data?.id as string | undefined;
    if (!transactionId) return;
    const details = await this.getTransactionDetails(transactionId);

    const invoiceUrl =
      details?.details?.invoice_url ||
      details?.invoice_url ||
      details?.invoice_pdf ||
      data?.details?.invoice_url ||
      data?.invoice_url ||
      data?.invoice_pdf ||
      null;
    const invoiceNumber =
      details?.invoice_number ||
      details?.invoice_id ||
      details?.details?.invoice_number ||
      data?.invoice_number ||
      data?.invoice_id ||
      data?.details?.invoice_number ||
      null;
    const amountRaw =
      details?.details?.totals?.total ||
      details?.total ||
      details?.grand_total ||
      data?.details?.totals?.total ||
      data?.total ||
      data?.grand_total ||
      '0';
    const amount = this.toMajorAmount(amountRaw);
    const currency =
      details?.currency_code || details?.currency || data?.currency_code || data?.currency || 'USD';

    let minioPath: string | null = null;
    let minioUrl: string | null = null;
    if (invoiceUrl) {
      try {
        const res = await fetch(invoiceUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          minioPath = `billing-invoices/${userId}/${transactionId}.pdf`;
          await this.minioService.uploadFile(
            'contentos-media',
            minioPath,
            buf,
            'application/pdf',
          );
          minioUrl = await this.minioService.getPublicUrl('contentos-media', minioPath);
        }
      } catch (e) {
        this.logger.warn(`Invoice upload skipped for ${transactionId}`);
      }
    }

    await this.supabaseService.getServiceClient().from('billing_invoices').upsert(
      {
        user_id: userId,
        paddle_transaction_id: transactionId,
        invoice_number: invoiceNumber,
        status: data?.status || 'unknown',
        amount,
        currency,
        invoice_url: invoiceUrl,
        minio_path: minioPath,
        minio_url: minioUrl,
        issued_at: data?.billed_at || data?.created_at || new Date().toISOString(),
        metadata: {
          webhook: data,
          transaction_details: details,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'paddle_transaction_id' },
    );

    const card = data?.payment_method?.card;
    if (card || data?.payment_method?.type) {
      const customerId = (data?.customer_id as string | undefined) || null;
      await this.supabaseService
        .getServiceClient()
        .from('billing_payment_methods')
        .upsert(
          {
            user_id: userId,
            paddle_customer_id: customerId,
            method_type: data?.payment_method?.type || 'card',
            card_brand: card?.type || card?.brand || null,
            card_last4: card?.last4 || null,
            expiry_month: card?.expiry_month || null,
            expiry_year: card?.expiry_year || null,
            is_primary: true,
            metadata: data?.payment_method || {},
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,is_primary' },
        );
    }
  }

  async handleWebhook(event: PaddleWebhookEvent): Promise<void> {
    const entity = this.extractFromEvent(event);
    const resolvedUserId = await this.resolveUserId(event);
    const userId = entity?.userId || resolvedUserId;
    if (userId && event.event_type.startsWith('transaction.')) {
      await this.persistInvoiceAndPayment(userId, event);
    }

    let effective = entity;
    if (!effective && userId) {
      const mappedFromSubscription = await this.resolvePlanFromSubscription(
        event.data?.subscription_id as string | undefined,
      );
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
      if (effective) {
        effective = {
          userId: effective.userId,
          planType: effective.planType,
          billingCycle: effective.billingCycle,
        };
      }
    }

    // Always try to resolve plan/billing from payload first for subscription updates.
    if (!effective) {
      this.logger.warn(
        `Skipping Paddle event ${event.event_type}: missing user/plan mapping`,
      );
      return;
    }

    const activeEvents = new Set([
      'transaction.paid',
      'transaction.completed',
      'subscription.activated',
      'subscription.created',
      'subscription.updated',
      'subscription.resumed',
      'subscription.trialing',
    ]);

    const deactivateEvents = new Set([
      'transaction.payment_failed',
      'transaction.canceled',
      'subscription.canceled',
      'subscription.past_due',
      'subscription.paused',
    ]);

    const transactionStatus = String(event.data?.status || '').toLowerCase();
    const transactionUpdatedIsActive =
      event.event_type === 'transaction.updated' &&
      (transactionStatus === 'paid' || transactionStatus === 'completed');
    const transactionUpdatedIsInactive =
      event.event_type === 'transaction.updated' &&
      (transactionStatus === 'canceled' ||
        transactionStatus === 'cancelled' ||
        transactionStatus === 'payment_failed' ||
        transactionStatus === 'past_due');

    if (activeEvents.has(event.event_type) || transactionUpdatedIsActive) {
      await this.upsertUserSubscription(
        effective.userId,
        effective.planType,
        effective.billingCycle,
        true,
        (event.data?.customer_id as string | undefined) || null,
        (event.data?.subscription_id as string | undefined) || null,
      );
      await this.supabaseService
        .getServiceClient()
        .from('user_subscriptions')
        .update({ trial_consumed: true, updated_at: new Date().toISOString() })
        .eq('user_id', effective.userId);
      this.logger.log(
        `Applied active subscription update from ${event.event_type}(${transactionStatus}) for user ${effective.userId}`,
      );
      return;
    }

    if (deactivateEvents.has(event.event_type) || transactionUpdatedIsInactive) {
      await this.upsertUserSubscription(
        effective.userId,
        effective.planType,
        effective.billingCycle,
        false,
        (event.data?.customer_id as string | undefined) || null,
        (event.data?.subscription_id as string | undefined) || null,
      );
      this.logger.log(
        `Applied inactive subscription update from ${event.event_type}(${transactionStatus}) for user ${effective.userId}`,
      );
      return;
    }

    this.logger.log(`Ignoring Paddle event type: ${event.event_type}`);
  }

  async getCustomerTransactions(customerId: string): Promise<
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
    if (!customerId) return [];

    const result =
      await this.paddleGet<PaddleApiListResponse<Record<string, any>>>(
        `/transactions?customer_id=${encodeURIComponent(customerId)}&per_page=20`,
      );
    const rows = result?.data || [];

    return rows.map((row) => ({
      id: row.id || '',
      status: row.status || 'unknown',
      amount:
        this.toMajorAmount(
          row.details?.totals?.total || row.total || row.grand_total || '0',
        ).toFixed(2),
      currency: row.currency_code || row.currency || 'USD',
      createdAt: row.created_at || row.billed_at || new Date().toISOString(),
      invoiceNumber:
        row.invoice_number || row.invoice_id || row.details?.invoice_number,
      invoiceUrl:
        row.details?.invoice_url || row.invoice_url || row.invoice_pdf,
    }));
  }

  async getPaymentMethodSummary(
    subscriptionId?: string,
    customerId?: string,
  ): Promise<string | null> {
    let result: { data?: Record<string, any> } | null = null;
    if (subscriptionId) {
      result = await this.paddleGet<{ data?: Record<string, any> }>(
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      );
    }
    const data = result?.data;
    if (data) {
      const card =
        data?.payment_method?.card ||
        data?.billing_details?.payment_method?.card ||
        data?.management_urls?.payment_method;
      if (card?.last4) {
        return `Card ending in ${card.last4}`;
      }
      if (data?.payment_method?.last4) {
        return `Card ending in ${data.payment_method.last4}`;
      }
      if (data?.payment_method?.type) {
        return `${String(data.payment_method.type)} on file`;
      }
    }

    // Fallback: try latest customer transactions for payment method details.
    if (customerId) {
      // Preferred fallback: customer payment methods endpoint.
      const pmResult =
        await this.paddleGet<PaddleApiListResponse<Record<string, any>>>(
          `/customers/${encodeURIComponent(customerId)}/payment-methods?per_page=10`,
        );
      const methods = pmResult?.data || [];
      for (const method of methods) {
        const card =
          method?.card ||
          method?.details?.card ||
          method?.method_details?.card;
        if (card?.last4) {
          return `Card ending in ${card.last4}`;
        }
        const methodType = method?.type || method?.method_type;
        if (methodType) {
          return `${String(methodType)} on file`;
        }
      }

      const txResult =
        await this.paddleGet<PaddleApiListResponse<Record<string, any>>>(
          `/transactions?customer_id=${encodeURIComponent(customerId)}&per_page=10`,
        );
      const rows = txResult?.data || [];
      for (const row of rows) {
        // Some payloads include payments[].method_details.card.last4
        const paymentCards = Array.isArray(row?.payments) ? row.payments : [];
        for (const p of paymentCards) {
          const pCard = p?.method_details?.card;
          if (pCard?.last4) {
            return `Card ending in ${pCard.last4}`;
          }
        }
        const txCard =
          row?.payment_method?.card ||
          row?.payment_method_details?.card ||
          row?.details?.payment_method?.card;
        if (txCard?.last4) {
          return `Card ending in ${txCard.last4}`;
        }
        const txType = row?.payment_method?.type || row?.payment_method_details?.type;
        if (txType) {
          return `${String(txType)} on file`;
        }
      }
    }

    return null;
  }

  async getTransactionInvoiceUrl(transactionId: string): Promise<string | null> {
    const apiKey = this.configService.get<string>('paddle.apiKey') || '';
    if (!apiKey) return null;

    // Official endpoint for downloadable invoice PDF per transaction.
    const res = await fetch(
      `${this.getApiBaseUrl()}/transactions/${encodeURIComponent(transactionId)}/invoice`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        redirect: 'manual',
      },
    );

    // Some responses return a redirect URL directly.
    const location = res.headers.get('location');
    if (location) return location;

    if (res.ok) {
      try {
        const body = (await res.json()) as Record<string, any>;
        const data = body?.data || {};
        return data?.url || data?.download_url || data?.pdf_url || null;
      } catch {
        return null;
      }
    }

    // Fallback to transaction details, if invoice endpoint is unavailable.
    const details = await this.getTransactionDetails(transactionId);
    return (
      details?.details?.invoice_url ||
      details?.invoice_url ||
      details?.invoice_pdf ||
      null
    );
  }

  async changeSubscriptionPlan(
    subscriptionId: string,
    planType: PlanType,
    billingCycle: BillingCycle,
  ): Promise<boolean> {
    const prices = this.configService.get<any>('paddle.prices') || {};
    const targetPriceId =
      planType === 'standard'
        ? billingCycle === 'yearly'
          ? prices.standardYearly
          : prices.standardMonthly
        : planType === 'pro'
          ? billingCycle === 'yearly'
            ? prices.proYearly
            : prices.proMonthly
          : billingCycle === 'yearly'
            ? prices.ultimateYearly
            : prices.ultimateMonthly;

    if (!targetPriceId) return false;

    const result = await this.paddlePatch<{ data?: Record<string, any> }>(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        items: [{ price_id: targetPriceId, quantity: 1 }],
        proration_billing_mode: 'prorated_immediately',
      },
    );
    return !!result?.data;
  }
}

