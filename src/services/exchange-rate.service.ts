import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from './supabase.service';
import { CacheService } from './cache.service';
import { CurrencyService } from './currency.service';

const EXCHANGE_RATES_CACHE_KEY = 'forex:daily_rates';
const EXCHANGE_RATES_CACHE_TTL = 86400; // 24 hours
const IST_TIMEZONE = 'Asia/Kolkata';
const FOREX_BASE_CURRENCY = 'USD';

export interface ExchangeRateRecord {
  id: string;
  base_currency: string;
  target_currency: string;
  rate: number;
  date: string;
  fetched_at: string;
  source: string;
}

export interface ForexRateEntry {
  code: string;
  name: string;
  rate: number;
}

export interface ForexApiResponse {
  base_code: string;
  base_name?: string;
  base_amount?: number;
  last_updated: string;
  rates: ForexRateEntry[];
}

export interface ForexProbeResult {
  ok: boolean;
  latencyMs: number;
  lastUpdated: string | null;
  usdToInr: number | null;
  rateCount: number;
  message: string;
}

@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
    private readonly currencyService: CurrencyService,
  ) {}

  /**
   * Live probe of the Forex API (used by admin health checks).
   */
  async probeForexApi(): Promise<ForexProbeResult> {
    const apiKey = this.configService.get<string>('forex.apiKey');
    const baseUrl = this.configService.get<string>('forex.baseUrl');

    if (!apiKey) {
      return {
        ok: false,
        latencyMs: 0,
        lastUpdated: null,
        usdToInr: null,
        rateCount: 0,
        message: 'FOREX_API_KEY is not configured',
      };
    }

    const start = Date.now();
    try {
      const data = await this.callForexRatesApi(apiKey, baseUrl!);
      const latencyMs = Date.now() - start;
      const inrEntry = data.rates.find((r) => r.code === 'INR');

      return {
        ok: true,
        latencyMs,
        lastUpdated: data.last_updated,
        usdToInr: inrEntry?.rate ?? null,
        rateCount: data.rates.length,
        message: `Forex API responded in ${latencyMs}ms with ${data.rates.length} rates`,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        lastUpdated: null,
        usdToInr: null,
        rateCount: 0,
        message: error.message || 'Forex API probe failed',
      };
    }
  }

  /**
   * Fetch daily exchange rates from Forex API (USD base).
   */
  async fetchDailyRates(): Promise<ExchangeRateRecord[]> {
    const apiKey = this.configService.get<string>('forex.apiKey');
    const baseUrl = this.configService.get<string>('forex.baseUrl');

    if (!apiKey) {
      this.logger.error('FOREX_API_KEY not configured. Skipping rate fetch.');
      throw new Error('FOREX_API_KEY is not configured');
    }

    const today = this.getTodayInIst();

    try {
      const data = await this.callForexRatesApi(apiKey, baseUrl!);
      const fetchedAt = new Date().toISOString();

      this.logger.log(
        `Fetched ${data.rates.length} rates from Forex API (base ${data.base_code}, updated ${data.last_updated})`,
      );

      const records: ExchangeRateRecord[] = data.rates.map((entry) => ({
        id: `${FOREX_BASE_CURRENCY}-${entry.code}-${today}`,
        base_currency: FOREX_BASE_CURRENCY,
        target_currency: entry.code,
        rate: entry.rate,
        date: today,
        fetched_at: fetchedAt,
        source: 'forex-aws.silverlining.cloud',
      }));

      await this.upsertRates(records);
      await this.cacheService.set(
        EXCHANGE_RATES_CACHE_KEY,
        records,
        EXCHANGE_RATES_CACHE_TTL,
      );

      const inrEntry = data.rates.find((r) => r.code === 'INR');
      if (inrEntry && inrEntry.rate > 0) {
        await this.syncToCurrencyService(inrEntry.rate, data.last_updated);
      } else {
        this.logger.warn('INR rate not found in Forex API response');
      }

      this.logger.log(
        `Exchange rates updated for ${today}: ${records.length} currencies`,
      );
      return records;
    } catch (error) {
      this.logger.error('Failed to fetch exchange rates:', error.message);
      throw error;
    }
  }

  private async callForexRatesApi(
    apiKey: string,
    baseUrl: string,
  ): Promise<ForexApiResponse> {
    const url = `${baseUrl.replace(/\/$/, '')}/rates`;
    this.logger.log(
      `Fetching exchange rates from ${url} for base ${FOREX_BASE_CURRENCY}`,
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ base: FOREX_BASE_CURRENCY }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as ForexApiResponse;

    if (!Array.isArray(data.rates)) {
      throw new Error(
        'Forex API returned invalid rates payload (expected array)',
      );
    }

    return data;
  }

  private async upsertRates(records: ExchangeRateRecord[]): Promise<void> {
    if (records.length === 0) return;

    const { error } = await this.supabaseService
      .getServiceClient()
      .from('exchange_rates')
      .upsert(records, {
        onConflict: 'base_currency,target_currency,date',
      });

    if (error) {
      this.logger.error('Failed to upsert exchange rates:', error.message);
      throw error;
    }
  }

  /**
   * Sync USD/INR pair to legacy currency settings (app_settings).
   * @param usdToInr - how many INR per 1 USD (from Forex API with USD base)
   */
  private async syncToCurrencyService(
    usdToInr: number,
    forexLastUpdated: string,
    updatedBy = 'forex-api',
  ): Promise<void> {
    const inrToUsd = 1 / usdToInr;
    this.logger.log(
      `Syncing to currency service: 1 USD = ${usdToInr} INR (1 INR = ${inrToUsd} USD)`,
    );

    await this.currencyService.updateExchangeRateFromForex(
      usdToInr,
      inrToUsd,
      forexLastUpdated,
      updatedBy,
    );

    this.logger.log('USD/INR exchange rate synced to currency service');
  }

  async getRate(
    targetCurrency: string,
    baseCurrency: string = FOREX_BASE_CURRENCY,
    date?: string,
  ): Promise<number | null> {
    const rateDate = date || this.getTodayInIst();
    const cacheKey = `forex:rate:${baseCurrency}:${targetCurrency}:${rateDate}`;

    const cached = await this.cacheService.get(cacheKey);
    if (cached !== null) {
      return cached as number;
    }

    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('exchange_rates')
      .select('rate')
      .eq('base_currency', baseCurrency)
      .eq('target_currency', targetCurrency)
      .eq('date', rateDate)
      .single();

    if (error || !data) {
      if (targetCurrency === 'INR' && baseCurrency === FOREX_BASE_CURRENCY) {
        const currencyData = await this.currencyService.getExchangeRate();
        return currencyData.usd_to_inr;
      }
      return null;
    }

    await this.cacheService.set(cacheKey, data.rate, EXCHANGE_RATES_CACHE_TTL);
    return data.rate;
  }

  /** USD to INR: how many INR per 1 USD */
  async getUsdToInrRate(date?: string): Promise<number | null> {
    const fromDb = await this.getRate('INR', FOREX_BASE_CURRENCY, date);
    if (fromDb !== null) return fromDb;
    const currencyData = await this.currencyService.getExchangeRate();
    return currencyData.usd_to_inr;
  }

  async getAllRates(date?: string): Promise<ExchangeRateRecord[]> {
    const rateDate = date || this.getTodayInIst();
    const cacheKey = `forex:all-rates:${rateDate}`;

    const cached = await this.cacheService.get(cacheKey);
    if (cached) {
      return cached as ExchangeRateRecord[];
    }

    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('exchange_rates')
      .select('*')
      .eq('date', rateDate)
      .eq('base_currency', FOREX_BASE_CURRENCY);

    if (error) {
      this.logger.error('Failed to get rates from database:', error.message);
      return [];
    }

    const rates = data || [];

    if (rates.length > 0) {
      await this.cacheService.set(cacheKey, rates, EXCHANGE_RATES_CACHE_TTL);
    }

    return rates;
  }

  async forceRefresh(): Promise<{
    success: boolean;
    count: number;
    usdToInr: number | null;
    message: string;
  }> {
    const rates = await this.fetchDailyRates();
    const inrRecord = rates.find((r) => r.target_currency === 'INR');

    return {
      success: true,
      count: rates.length,
      usdToInr: inrRecord?.rate ?? null,
      message: `Successfully fetched ${rates.length} exchange rates`,
    };
  }

  async getStatus(): Promise<{
    baseCurrency: string;
    date: string;
    totalCurrencies: number;
    lastFetchedAt: string | null;
    usdToInr: number | null;
    inrToUsd: number | null;
    cached: boolean;
  }> {
    const today = this.getTodayInIst();
    const rates = await this.getAllRates(today);
    const currencyData = await this.currencyService.getExchangeRate();
    const cached =
      (await this.cacheService.get(`forex:all-rates:${today}`)) !== null;
    const inrRecord = rates.find((r) => r.target_currency === 'INR');
    const usdToInr = inrRecord?.rate ?? currencyData.usd_to_inr;
    const inrToUsd = usdToInr ? 1 / usdToInr : currencyData.inr_to_usd;

    return {
      baseCurrency: FOREX_BASE_CURRENCY,
      date: today,
      totalCurrencies: rates.length,
      lastFetchedAt: rates[0]?.fetched_at || currencyData.last_updated || null,
      usdToInr,
      inrToUsd,
      cached,
    };
  }

  async convert(
    amount: number,
    fromCurrency: string,
    toCurrency: string,
    date?: string,
  ): Promise<{ amount: number; rate: number; date: string }> {
    const rateDate = date || this.getTodayInIst();

    if (fromCurrency === toCurrency) {
      return { amount, rate: 1, date: rateDate };
    }

    if (fromCurrency === 'USD' && toCurrency === 'INR') {
      const rate = await this.getUsdToInrRate(rateDate);
      if (!rate) throw new Error('Exchange rate not found for USD -> INR');
      return { amount: amount * rate, rate, date: rateDate };
    }

    if (fromCurrency === 'INR' && toCurrency === 'USD') {
      const usdToInr = await this.getUsdToInrRate(rateDate);
      if (!usdToInr) throw new Error('Exchange rate not found for INR -> USD');
      const rate = 1 / usdToInr;
      return { amount: amount * rate, rate, date: rateDate };
    }

    const fromRate = await this.getRate(
      fromCurrency,
      FOREX_BASE_CURRENCY,
      rateDate,
    );
    const toRate = await this.getRate(
      toCurrency,
      FOREX_BASE_CURRENCY,
      rateDate,
    );
    if (!fromRate || !toRate) {
      throw new Error(
        `Exchange rate not found for ${fromCurrency} -> ${toCurrency}`,
      );
    }

    const rate = toRate / fromRate;
    return { amount: amount * rate, rate, date: rateDate };
  }

  private getTodayInIst(): string {
    const now = new Date();
    const istTime = new Date(
      now.toLocaleString('en-US', { timeZone: IST_TIMEZONE }),
    );
    return istTime.toISOString().split('T')[0];
  }
}
