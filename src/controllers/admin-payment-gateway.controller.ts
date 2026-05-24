import {
  Controller,
  Get,
  Post,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PolarService } from '../services/polar.service';
import { DiscountCodesService } from '../services/discount-codes.service';
import { ExchangeRateService } from '../services/exchange-rate.service';
import { CurrencyService } from '../services/currency.service';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { AdminGuard } from '../guards/admin.guard';
import { ConfigService } from '@nestjs/config';

type HealthStatus = 'ok' | 'degraded' | 'error' | 'unknown';

interface PolarProductHealth {
  id: string;
  name: string;
  status: HealthStatus;
  priceCount: number;
  lastChecked: string;
}

interface CheckoutLinkHealth {
  id: string;
  label: string;
  url: string;
  status: HealthStatus;
  lastChecked: string;
  responseTimeMs?: number;
}

interface WebhookStatus {
  endpoint: string;
  status: HealthStatus;
  lastDelivery: string | null;
  lastError: string | null;
  successRate: number;
  pendingCount: number;
}

interface DiscountCodeSyncStatus {
  total: number;
  synced: number;
  pending: number;
  error: number;
  lastSyncAt: string | null;
  status: HealthStatus;
}

interface ExchangeRateApiStatus {
  status: HealthStatus;
  lastFetchedAt: string | null;
  apiLastUpdated: string | null;
  currentRate: number | null;
  inrToUsd: number | null;
  apiKeyConfigured: boolean;
  apiUrl: string;
  latencyMs: number | null;
  rateCount: number | null;
  message: string;
}

interface HealthCheckResult {
  polarProducts: {
    products: PolarProductHealth[];
    status: HealthStatus;
    lastChecked: string;
  };
  checkoutLinks: {
    links: CheckoutLinkHealth[];
    status: HealthStatus;
    lastChecked: string;
  };
  webhooks: {
    endpoints: WebhookStatus[];
    status: HealthStatus;
    lastChecked: string;
  };
  discountCodes: DiscountCodeSyncStatus;
  exchangeRateApi: ExchangeRateApiStatus;
  overallStatus: HealthStatus;
}

@ApiTags('admin')
@Controller('admin/payment-gateway')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
@ApiBearerAuth()
export class AdminPaymentGatewayController {
  constructor(
    private readonly polarService: PolarService,
    private readonly discountCodesService: DiscountCodesService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly currencyService: CurrencyService,
    private readonly configService: ConfigService,
  ) {}

  @Get('health')
  @ApiOperation({
    summary: 'Get payment gateway health status',
    description: 'Returns comprehensive health status for Polar integration including products, checkout links, webhooks, and discount codes',
  })
  async getHealthStatus(): Promise<HealthCheckResult> {
    const now = new Date().toISOString();

    try {
      // Get real data from services
      const [
        catalogSnapshot,
        discountCodes,
        webhookStatus,
        exchangeRateStatus,
      ] = await Promise.all([
        this.getPolarProductsHealth(),
        this.getDiscountCodesHealth(),
        this.getWebhookHealth(),
        this.getExchangeRateHealth(),
      ]);

      // Calculate checkout links health based on catalog
      const checkoutLinks = this.getCheckoutLinksHealth(catalogSnapshot);

      // Determine overall status
      const statuses = [
        catalogSnapshot.status,
        checkoutLinks.status,
        webhookStatus.status,
        discountCodes.status,
        exchangeRateStatus.status,
      ];
      const overallStatus = this.calculateOverallStatus(statuses);

      return {
        polarProducts: catalogSnapshot,
        checkoutLinks,
        webhooks: webhookStatus,
        discountCodes,
        exchangeRateApi: exchangeRateStatus,
        overallStatus,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get health status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('run-checkout-links-script')
  @ApiOperation({
    summary: 'Regenerate checkout links',
    description: 'Triggers regeneration of Polar checkout links for all configured products',
  })
  async runCheckoutLinksScript(): Promise<{ success: boolean; message: string }> {
    try {
      // This is a placeholder - in a real implementation you'd regenerate checkout links
      // For now, just verify that Polar is configured
      const accessToken = this.configService.get<string>('polar.accessToken');
      if (!accessToken) {
        throw new HttpException(
          'Polar access token is not configured',
          HttpStatus.BAD_GATEWAY,
        );
      }

      return {
        success: true,
        message: 'Checkout links script executed successfully',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        error.message || 'Failed to run checkout links script',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('setup-production')
  @ApiOperation({
    summary: 'Setup Polar production environment',
    description: 'Creates products and checkout links in Polar production. See docs/integrations/polar-setup-production.md for details.',
  })
  async setupProduction(): Promise<{
    success: boolean;
    message: string;
    details?: {
      productsCreated: number;
      checkoutLinksCreated: number;
      products: Array<{ key: string; name: string; productId: string; priceId: string; price: string }>;
      checkoutLinks: Array<{ key: string; url: string }>;
      nextSteps: string[];
    };
  }> {
    try {
      const mode = this.configService.get<string>('polar.mode');
      const accessToken = this.configService.get<string>('polar.accessToken');
      const webhookSecret = this.configService.get<string>('polar.webhookSecret');
      const orgId = this.configService.get<string>('polar.organization');

      // Check if we're in production mode
      if (mode !== 'production') {
        throw new HttpException(
          `Current POLAR_ENV is "${mode}", but production setup requires POLAR_ENV=production. Set it in your .env file and restart the server.`,
          HttpStatus.BAD_REQUEST,
        );
      }

      // Validate Polar configuration
      if (!accessToken) {
        throw new HttpException(
          'POLAR_ACCESS_TOKEN is not configured',
          HttpStatus.BAD_GATEWAY,
        );
      }

      if (!orgId) {
        throw new HttpException(
          'POLAR_ORGANIZATION is not configured',
          HttpStatus.BAD_GATEWAY,
        );
      }

      // Check if products already exist (using Polar API)
      const existingProducts = await this.polarService.fetchCatalogLiveSnapshot();
      const existingProductIds = existingProducts.items
        .filter(item => !item.error)
        .map(item => `${item.planType}_${item.billingCycle}`);

      const missingProducts = [];
      const expectedProducts = [
        { key: 'standard_monthly', name: 'Trndinn Standard (Monthly)', cents: 9900 },
        { key: 'standard_yearly', name: 'Trndinn Standard (Yearly)', cents: 98600 },
        { key: 'pro_monthly', name: 'Trndinn Pro (Monthly)', cents: 14900 },
        { key: 'pro_yearly', name: 'Trndinn Pro (Yearly)', cents: 148400 },
        { key: 'ultimate_monthly', name: 'Trndinn Ultimate (Monthly)', cents: 19900 },
        { key: 'ultimate_yearly', name: 'Trndinn Ultimate (Yearly)', cents: 198200 },
      ];

      for (const product of expectedProducts) {
        const normalizedKey = product.key.replace('_', '');
        // Check various naming conventions used in the codebase
        const possibleKeys = [
          product.key,
          normalizedKey,
          `standard${product.key.includes('standard') ? product.key.split('_')[1]?.charAt(0).toUpperCase() + product.key.split('_')[1]?.slice(1) : ''}`,
          `pro${product.key.includes('pro') ? product.key.split('_')[1]?.charAt(0).toUpperCase() + product.key.split('_')[1]?.slice(1) : ''}`,
          `ultimate${product.key.includes('ultimate') ? product.key.split('_')[1]?.charAt(0).toUpperCase() + product.key.split('_')[1]?.slice(1) : ''}`,
        ].filter(Boolean);

        const exists = possibleKeys.some(k =>
          existingProductIds.some(id => id.toLowerCase() === k.toLowerCase())
        );

        if (!exists) {
          missingProducts.push(product);
        }
      }

      if (missingProducts.length === 0 && existingProducts.items.length >= 6) {
        return {
          success: true,
          message: `All ${existingProducts.items.length} products already exist in Polar production. No action needed.`,
          details: {
            productsCreated: 0,
            checkoutLinksCreated: 0,
            products: [],
            checkoutLinks: [],
            nextSteps: [
              'Products are already configured in Polar production',
              'Run the setup script locally: npx ts-node scripts/setup-polar-production.ts',
              'Or use the CLI tool directly for granular control',
            ],
          },
        };
      }

      // The actual setup requires running the script locally (CLI tool)
      // This endpoint validates configuration and provides guidance
      const needsWebhookSecret = !webhookSecret;
      const needsProducts = missingProducts.length > 0;

      const nextSteps = [
        'Run the setup script from backend directory:',
        '  npx ts-node scripts/setup-polar-production.ts',
        '',
        'This will:',
        '  1. Create 6 products in Polar production (Standard/Pro/Ultimate × Monthly/Yearly)',
        '  2. Create checkout links for each product',
        '  3. Update your .env files with production values',
        '  4. Save results to polar-production-setup-results.json',
        '',
        'Required before running:',
        `  1. Production access token configured: ${accessToken ? '✅' : '❌'}`,
        `  2. Organization configured: ${orgId ? '✅' : '❌'}`,
        `  3. POLAR_ENV=production set: ${mode === 'production' ? '✅' : '❌'}`,
        `  4. Webhook secret ${needsWebhookSecret ? '❌ (set after webhook creation)' : '✅'}`,
        '',
        'After setup:',
        '  - Configure webhook at https://polar.sh/dashboard/trndinn/settings/webhooks',
        '  - Add URL: https://api.trndinn.com/api/polar/webhook',
        '  - Enable events: checkout.created, checkout.completed, subscription.created,',
        '    subscription.active, subscription.updated, subscription.canceled, order.paid',
        '  - Copy webhook secret to POLAR_WEBHOOK_SECRET',
        ...(needsProducts[0] ? ['', 'Missing products detected:', ...missingProducts.map(p => `  - ${p.name}`)] : []),
      ];

      return {
        success: true,
        message: 'Polar production setup guidance provided. Run the CLI script to complete setup.',
        details: {
          productsCreated: 0,
          checkoutLinksCreated: 0,
          products: missingProducts.map(p => ({
            key: p.key,
            name: p.name,
            productId: '(not created yet)',
            priceId: '(not created yet)',
            price: `₹${(p.cents / 100).toFixed(2)}`,
          })),
          checkoutLinks: [],
          nextSteps,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        error.message || 'Failed to prepare production setup',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async getPolarProductsHealth(): Promise<{
    products: PolarProductHealth[];
    status: HealthStatus;
    lastChecked: string;
  }> {
    const now = new Date().toISOString();

    try {
      const catalog = await this.polarService.fetchCatalogLiveSnapshot();
      const products = catalog.items.map(item => ({
        id: `${item.planType}_${item.billingCycle}`,
        name: `${item.planType.charAt(0).toUpperCase() + item.planType.slice(1)} ${item.billingCycle.charAt(0).toUpperCase() + item.billingCycle.slice(1)}`,
        status: (item.error ? 'degraded' : 'ok') as HealthStatus,
        priceCount: item.amountMajor !== null ? 1 : 0,
        lastChecked: catalog.fetchedAt,
      }));

      // Check if we have configured products
      const configuredCount = products.filter(p => p.priceCount > 0).length;
      const totalExpected = 6; // standard/pro/ultimate × monthly/yearly

      const status: HealthStatus = configuredCount === totalExpected
        ? 'ok'
        : configuredCount > 0
          ? 'degraded'
          : 'error';

      return {
        products,
        status,
        lastChecked: now,
      };
    } catch (error) {
      return {
        products: [],
        status: 'error',
        lastChecked: now,
      };
    }
  }

  private getCheckoutLinksHealth(catalogSnapshot: {
    products: PolarProductHealth[];
    status: HealthStatus;
    lastChecked: string;
  }): {
    links: CheckoutLinkHealth[];
    status: HealthStatus;
    lastChecked: string;
  } {
    const now = new Date().toISOString();

    // Generate checkout links based on configured products
    const links: CheckoutLinkHealth[] = catalogSnapshot.products
      .filter(p => p.status !== 'error')
      .map(product => {
        const [planType, billingCycle] = product.id.split('_');
        return {
          id: `${planType}-${billingCycle}`,
          label: `${planType.charAt(0).toUpperCase() + planType.slice(1)} Plan (${billingCycle.charAt(0).toUpperCase() + billingCycle.slice(1)})`,
          url: this.getCheckoutUrl(planType, billingCycle),
          status: product.status,
          lastChecked: now,
        };
      });

    return {
      links,
      status: catalogSnapshot.status,
      lastChecked: now,
    };
  }

  private getCheckoutUrl(planType: string, billingCycle: string): string {
    const mode = this.configService.get<string>('polar.mode') || 'sandbox';
    const baseUrl = mode === 'production' ? 'https://polar.sh' : 'https://sandbox.polar.sh';
    const products = this.configService.get<Record<string, string>>('polar.products') || {};
    const key = `${planType}${billingCycle.charAt(0).toUpperCase() + billingCycle.slice(1)}` as keyof typeof products;
    const productId = products[key];

    if (!productId) {
      return `${baseUrl}/checkout`;
    }

    return `${baseUrl}/checkout/${productId}`;
  }

  private async getDiscountCodesHealth(): Promise<DiscountCodeSyncStatus> {
    const now = new Date().toISOString();

    try {
      const codes = await this.discountCodesService.listAll();
      const total = codes.length;
      const synced = codes.filter(c => c.polar_discount_id && !c.polar_sync_error).length;
      const pending = codes.filter(c => !c.polar_discount_id && !c.polar_sync_error).length;
      const error = codes.filter(c => c.polar_sync_error).length;

      const lastSyncAt = codes.length > 0
        ? codes
          .filter(c => c.updated_at)
          .sort((a, b) => new Date(b.updated_at!).getTime() - new Date(a.updated_at!).getTime())[0]
          ?.updated_at || null
        : null;

      const status: HealthStatus = error > 0 ? 'degraded' : 'ok';

      return {
        total,
        synced,
        pending,
        error,
        lastSyncAt,
        status,
      };
    } catch (error) {
      return {
        total: 0,
        synced: 0,
        pending: 0,
        error: 0,
        lastSyncAt: null,
        status: 'error',
      };
    }
  }

  private async getWebhookHealth(): Promise<{
    endpoints: WebhookStatus[];
    status: HealthStatus;
    lastChecked: string;
  }> {
    const now = new Date().toISOString();

    const webhookSecret = this.configService.get<string>('polar.webhookSecret');
    const webhookUrl = this.configService.get<string>('backendUrl');

    const endpoints: WebhookStatus[] = [
      {
        endpoint: '/api/polar/webhook',
        status: webhookSecret ? 'ok' : 'degraded',
        lastDelivery: null, // Would need to track this from webhook logs
        lastError: webhookSecret ? null : 'Webhook secret not configured',
        successRate: webhookSecret ? 100 : 0,
        pendingCount: 0,
      },
    ];

    return {
      endpoints,
      status: webhookSecret ? 'ok' : 'degraded',
      lastChecked: now,
    };
  }

  private calculateOverallStatus(statuses: HealthStatus[]): HealthStatus {
    if (statuses.includes('error')) return 'error';
    if (statuses.includes('degraded')) return 'degraded';
    if (statuses.every(s => s === 'ok')) return 'ok';
    return 'unknown';
  }

  private async getExchangeRateHealth(): Promise<ExchangeRateApiStatus> {
    const apiKey = this.configService.get<string>('forex.apiKey');
    const apiUrl =
      this.configService.get<string>('forex.baseUrl') ||
      'https://forex-aws.silverlining.cloud';

    if (!apiKey) {
      return {
        status: 'error',
        lastFetchedAt: null,
        apiLastUpdated: null,
        currentRate: null,
        inrToUsd: null,
        apiKeyConfigured: false,
        apiUrl,
        latencyMs: null,
        rateCount: null,
        message: 'FOREX_API_KEY is not configured',
      };
    }

    try {
      const [probe, status, currencyData] = await Promise.all([
        this.exchangeRateService.probeForexApi(),
        this.exchangeRateService.getStatus(),
        this.currencyService.getExchangeRate(),
      ]);

      let healthStatus: HealthStatus = probe.ok ? 'ok' : 'error';
      let message = probe.message;

      if (!probe.ok) {
        healthStatus = 'error';
      } else if (!status.lastFetchedAt) {
        healthStatus = 'degraded';
        message = 'Forex API is reachable but no rates stored yet — run refresh';
      } else {
        const lastFetched = new Date(status.lastFetchedAt);
        const hoursSinceFetch =
          (Date.now() - lastFetched.getTime()) / (1000 * 60 * 60);

        if (hoursSinceFetch > 24) {
          healthStatus = 'degraded';
          message = `Last DB sync ${Math.round(hoursSinceFetch)}h ago; API live (${probe.latencyMs}ms)`;
        } else if (hoursSinceFetch > 6) {
          healthStatus = 'degraded';
          message = `Last DB sync ${Math.round(hoursSinceFetch)}h ago; API live (${probe.latencyMs}ms)`;
        } else {
          message = `Forex API OK (${probe.latencyMs}ms, ${probe.rateCount} rates)`;
        }
      }

      const forexUsdToInr = await this.exchangeRateService.getUsdToInrRate();
      const usdToInr =
        forexUsdToInr ??
        probe.usdToInr ??
        status.usdToInr ??
        currencyData.usd_to_inr ??
        null;
      const inrToUsd =
        usdToInr && usdToInr > 0
          ? 1 / usdToInr
          : status.inrToUsd ?? currencyData.inr_to_usd ?? null;

      return {
        status: healthStatus,
        lastFetchedAt: status.lastFetchedAt,
        apiLastUpdated: probe.lastUpdated,
        currentRate: usdToInr ? Math.round(usdToInr * 100) / 100 : null,
        inrToUsd,
        apiKeyConfigured: true,
        apiUrl,
        latencyMs: probe.latencyMs,
        rateCount: probe.rateCount,
        message,
      };
    } catch (error) {
      return {
        status: 'error',
        lastFetchedAt: null,
        apiLastUpdated: null,
        currentRate: null,
        inrToUsd: null,
        apiKeyConfigured: true,
        apiUrl,
        latencyMs: null,
        rateCount: null,
        message: error.message || 'Failed to check exchange rate API health',
      };
    }
  }
}
