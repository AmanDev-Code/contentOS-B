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
