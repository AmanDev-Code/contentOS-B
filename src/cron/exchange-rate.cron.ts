import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ExchangeRateService } from '../services/exchange-rate.service';

/**
 * Cron job to fetch daily exchange rates at 5 AM IST
 *
 * IST (India Standard Time) = UTC+5:30
 * 5 AM IST = 11:30 PM UTC (previous day)
 *
 * Using NestJS @Cron with Asia/Kolkata timezone
 * Cron expression: 0 5 * * * (0 seconds, 5 minutes/hour, every day)
 *
 * The cron runs at 5:00 AM India time every day and fetches exchange rates
 * from the Forex API with USD as the base currency (1 USD = X INR).
 */
@Injectable()
export class ExchangeRateCronService {
  private readonly logger = new Logger(ExchangeRateCronService.name);

  constructor(private readonly exchangeRateService: ExchangeRateService) {}

  /**
   * Daily exchange rate fetch at 5 AM IST
   * Cron expression: 0 5 * * *
   * Timezone: Asia/Kolkata (IST)
   *
   * Explanation:
   * - 0: At 0 seconds past the minute
   * - 5: At minute 5 (5 AM)
   * - *: Every hour (but combined with minute 5 = 5 AM)
   * - *: Every day of month
   * - *: Every month
   * - *: Every day of week
   */
  @Cron('0 5 * * *', {
    timeZone: 'Asia/Kolkata',
    name: 'daily-exchange-rate-fetch',
  })
  async handleDailyExchangeRateFetch(): Promise<void> {
    this.logger.log('=== Starting daily exchange rate fetch ===');
    this.logger.log(`CRON Expression: 0 5 * * * (5 AM IST)`);
    this.logger.log(`Timezone: Asia/Kolkata (IST = UTC+5:30)`);
    this.logger.log(`UTC Time: ${new Date().toISOString()}`);
    this.logger.log(`IST Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}`);

    try {
      const startTime = Date.now();
      const rates = await this.exchangeRateService.fetchDailyRates();
      const duration = Date.now() - startTime;

      if (rates.length > 0) {
        // Find USD rate for logging
        const inrRate = rates.find((r) => r.target_currency === 'INR');
        this.logger.log(`Successfully fetched ${rates.length} exchange rates in ${duration}ms`);
        if (inrRate) {
          this.logger.log(`USD/INR: 1 USD = ${inrRate.rate} INR (1 INR = ${(1 / inrRate.rate).toFixed(6)} USD)`);
        }
      } else {
        this.logger.warn('No exchange rates fetched - check FOREX_API_KEY configuration');
      }
    } catch (error) {
      this.logger.error('Failed to fetch daily exchange rates:', error.message);
      this.logger.error('Stack:', error.stack);
    }

    this.logger.log('=== Daily exchange rate fetch completed ===');
  }

  /**
   * Health check ping - runs every hour to verify the cron service is active
   * This helps verify the scheduler is running without triggering actual API calls
   */
  @Cron(CronExpression.EVERY_HOUR, {
    name: 'exchange-rate-cron-health-check',
  })
  async handleHealthCheck(): Promise<void> {
    // Silent health check - only log at debug level
    this.logger.debug('Exchange rate cron service is healthy');
  }
}
