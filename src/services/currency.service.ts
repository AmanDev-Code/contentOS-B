import { Injectable, Logger } from '@nestjs/common';
import { AppSettingsService } from './app-settings.service';
import { CacheService } from './cache.service';

// Default exchange rate: 1 INR = 0.01197 USD (1 USD = 83.5 INR)
const DEFAULT_INR_TO_USD_RATE = 0.01197;
const DEFAULT_USD_TO_INR_RATE = 83.5;

const CURRENCY_CACHE_KEY = 'currency:exchange_rate';
const CURRENCY_CACHE_TTL = 3600; // 1 hour

export interface ExchangeRateData {
  inr_to_usd: number;
  usd_to_inr: number;
  last_updated: string;
  updated_by?: string;
}

@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name);

  constructor(
    private readonly appSettingsService: AppSettingsService,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Convert INR amount to USD
   * @param inrAmount - Amount in INR
   * @param rate - Optional custom exchange rate (1 INR = X USD)
   * @returns Amount in USD, rounded to 2 decimal places
   */
  convertInrToUsd(inrAmount: number, rate?: number): number {
    const exchangeRate = rate ?? DEFAULT_INR_TO_USD_RATE;
    const usdAmount = inrAmount * exchangeRate;
    return this.roundToTwoDecimals(usdAmount);
  }

  /**
   * Convert USD amount to INR
   * @param usdAmount - Amount in USD
   * @param rate - Optional custom exchange rate (1 USD = X INR)
   * @returns Amount in INR
   */
  convertUsdToInr(usdAmount: number, rate?: number): number {
    const exchangeRate = rate ?? DEFAULT_USD_TO_INR_RATE;
    return usdAmount * exchangeRate;
  }

  /**
   * Format INR amount for display
   * @param amount - Amount in INR
   * @returns Formatted string with INR symbol (e.g., "₹99")
   */
  formatInr(amount: number): string {
    return `₹${Math.round(amount)}`;
  }

  /**
   * Format USD amount for display
   * @param amount - Amount in USD
   * @returns Formatted string with USD symbol (e.g., "$1.19")
   */
  formatUsd(amount: number): string {
    return `$${this.roundToTwoDecimals(amount).toFixed(2)}`;
  }

  /**
   * Get current exchange rate from database (with caching)
   * @returns Exchange rate data (INR to USD and USD to INR rates)
   */
  async getExchangeRate(): Promise<ExchangeRateData> {
    // Try cache first
    const cached = await this.cacheService.get(CURRENCY_CACHE_KEY) as ExchangeRateData | null;
    if (cached) {
      return cached;
    }

    // Fetch from database
    const rateData = await this.appSettingsService.get<ExchangeRateData>('currency_exchange_rate');

    if (rateData && rateData.inr_to_usd && rateData.usd_to_inr) {
      // Cache the result
      await this.cacheService.set(CURRENCY_CACHE_KEY, rateData, CURRENCY_CACHE_TTL);
      return rateData;
    }

    // Return default if not found in database
    const defaultData: ExchangeRateData = {
      inr_to_usd: DEFAULT_INR_TO_USD_RATE,
      usd_to_inr: DEFAULT_USD_TO_INR_RATE,
      last_updated: new Date().toISOString(),
      updated_by: 'system',
    };

    return defaultData;
  }

  /**
   * Get the current INR to USD rate (convenience method)
   * @returns Current INR to USD exchange rate
   */
  async getInrToUsdRate(): Promise<number> {
    const rateData = await this.getExchangeRate();
    return rateData.inr_to_usd;
  }

  /**
   * Update exchange rate from Forex API fetch (system cron).
   */
  async updateExchangeRateFromForex(
    usdToInr: number,
    inrToUsd: number,
    forexLastUpdated: string,
    updatedBy = 'forex-api',
  ): Promise<void> {
    if (usdToInr <= 0 || inrToUsd <= 0 || !Number.isFinite(usdToInr) || !Number.isFinite(inrToUsd)) {
      throw new Error('Exchange rates must be positive numbers');
    }

    const rateData: ExchangeRateData = {
      inr_to_usd: inrToUsd,
      usd_to_inr: usdToInr,
      last_updated: forexLastUpdated || new Date().toISOString(),
      updated_by: updatedBy,
    };

    // updated_by column is auth.users UUID; actor label lives in rateData.updated_by
    const saved = await this.appSettingsService.set(
      'currency_exchange_rate',
      rateData,
    );
    if (!saved) {
      throw new Error('Failed to persist forex exchange rate to app_settings');
    }

    await this.appSettingsService.invalidateCache('currency_exchange_rate');
    await this.cacheService.delete(CURRENCY_CACHE_KEY);
    this.logger.log(
      `Forex exchange rate synced: 1 USD = ${usdToInr} INR (by ${updatedBy})`,
    );
  }

  /**
   * Update exchange rate in database (admin only)
   * @param rate - The INR to USD exchange rate
   * @param updatedBy - Optional user ID who updated the rate
   */
  async updateExchangeRate(rate: number, updatedBy?: string): Promise<void> {
    if (rate <= 0 || !Number.isFinite(rate)) {
      throw new Error('Exchange rate must be a positive number');
    }

    // Calculate the inverse rate
    const usdToInrRate = 1 / rate;

    const rateData: ExchangeRateData = {
      inr_to_usd: rate,
      usd_to_inr: usdToInrRate,
      last_updated: new Date().toISOString(),
      updated_by: updatedBy,
    };

    // Save to database
    await this.appSettingsService.set('currency_exchange_rate', rateData, updatedBy);

    // Invalidate cache
    await this.cacheService.delete(CURRENCY_CACHE_KEY);

    this.logger.log(`Exchange rate updated: 1 INR = ${rate} USD (by ${updatedBy || 'system'})`);
  }

  /**
   * Calculate yearly price with discount
   * @param monthlyPrice - Monthly price in any currency
   * @param discountPercent - Discount percentage (e.g., 20 for 20% off)
   * @returns Yearly price after discount, rounded to 2 decimal places
   */
  calculateYearlyPrice(monthlyPrice: number, discountPercent: number): number {
    const yearlyPrice = monthlyPrice * 12;
    const discountAmount = yearlyPrice * (discountPercent / 100);
    const discountedPrice = yearlyPrice - discountAmount;
    return this.roundToTwoDecimals(discountedPrice);
  }

  /**
   * Convert INR to USD using the current database rate
   * @param inrAmount - Amount in INR
   * @returns Amount in USD, rounded to 2 decimal places
   */
  async convertInrToUsdWithCurrentRate(inrAmount: number): Promise<number> {
    const rate = await this.getInrToUsdRate();
    return this.convertInrToUsd(inrAmount, rate);
  }

  /**
   * Convert USD to INR using the current database rate
   * @param usdAmount - Amount in USD
   * @returns Amount in INR
   */
  async convertUsdToInrWithCurrentRate(usdAmount: number): Promise<number> {
    const rateData = await this.getExchangeRate();
    return this.convertUsdToInr(usdAmount, rateData.usd_to_inr);
  }

  /**
   * Format price for display based on currency
   * @param amount - Amount in the specified currency
   * @param currency - Currency code ('INR' or 'USD')
   * @returns Formatted price string
   */
  formatPrice(amount: number, currency: 'INR' | 'USD'): string {
    if (currency === 'INR') {
      return this.formatInr(amount);
    }
    return this.formatUsd(amount);
  }

  /**
   * Invalidate the exchange rate cache
   */
  async invalidateCache(): Promise<void> {
    await this.cacheService.delete(CURRENCY_CACHE_KEY);
    this.logger.log('Exchange rate cache invalidated');
  }

  private roundToTwoDecimals(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
