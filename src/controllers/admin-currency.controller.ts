import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrencyService } from '../services/currency.service';
import { ExchangeRateService } from '../services/exchange-rate.service';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { AdminGuard } from '../guards/admin.guard';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    sub: string;
  };
}

interface UpdateExchangeRateDto {
  rate: number;
}

interface ConvertCurrencyDto {
  amount: number;
  from: 'INR' | 'USD';
  to: 'INR' | 'USD';
}

@ApiTags('admin')
@Controller('admin/currency')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
@ApiBearerAuth()
export class AdminCurrencyController {
  constructor(
    private readonly currencyService: CurrencyService,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  @Get('rate')
  @ApiOperation({ summary: 'Get current INR/USD exchange rate' })
  async getExchangeRate() {
    try {
      const rateData = await this.currencyService.getExchangeRate();
      const forexUsdToInr = await this.exchangeRateService.getUsdToInrRate();
      const usdToInr = forexUsdToInr ?? rateData.usd_to_inr;
      const inrToUsd = usdToInr > 0 ? 1 / usdToInr : rateData.inr_to_usd;
      const isForexSource =
        forexUsdToInr != null ||
        rateData.updated_by === 'system-cron' ||
        rateData.updated_by === 'forex-api';
      const source = isForexSource ? 'forex-api' : rateData.updated_by || 'database';

      return {
        rate: inrToUsd,
        inrToUsd,
        usdToInr,
        displayPrimary: `1 USD = ${usdToInr.toFixed(2)} INR`,
        displaySecondary: `1 INR = ${inrToUsd.toFixed(6)} USD`,
        source,
        updatedAt: rateData.last_updated,
        lastUpdated: rateData.last_updated,
        updatedBy: isForexSource ? 'forex-api' : rateData.updated_by,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get exchange rate',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Put('rate')
  @ApiOperation({ summary: 'Update INR/USD exchange rate (admin only)' })
  async updateExchangeRate(
    @Request() req: AuthenticatedRequest,
    @Body() body: UpdateExchangeRateDto,
  ) {
    const { rate } = body;

    if (rate === undefined || rate === null) {
      throw new HttpException('rate is required', HttpStatus.BAD_REQUEST);
    }

    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new HttpException(
        'rate must be a positive number',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Reasonable bounds check (1 INR should be between 0.001 and 1 USD)
    if (rate < 0.001 || rate > 1) {
      throw new HttpException(
        'rate must be between 0.001 and 1 (1 INR = X USD)',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      await this.currencyService.updateExchangeRate(rate, req.user.id);

      return {
        success: true,
        message: 'Exchange rate updated successfully',
        data: {
          inrToUsd: rate,
          usdToInr: 1 / rate,
          updatedAt: new Date().toISOString(),
          updatedBy: req.user.id,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        error.message || 'Failed to update exchange rate',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('convert')
  @ApiOperation({ summary: 'Convert amount between INR and USD' })
  async convertCurrency(@Body() body: ConvertCurrencyDto) {
    const { amount, from, to } = body;

    if (amount === undefined || amount === null) {
      throw new HttpException('amount is required', HttpStatus.BAD_REQUEST);
    }

    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new HttpException(
        'amount must be a non-negative number',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!from || !to) {
      throw new HttpException(
        'from and to currencies are required',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (from !== 'INR' && from !== 'USD') {
      throw new HttpException(
        'from must be either INR or USD',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (to !== 'INR' && to !== 'USD') {
      throw new HttpException(
        'to must be either INR or USD',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      let convertedAmount: number;
      let formattedResult: string;

      if (from === 'INR' && to === 'USD') {
        convertedAmount = await this.currencyService.convertInrToUsdWithCurrentRate(amount);
        formattedResult = this.currencyService.formatUsd(convertedAmount);
      } else if (from === 'USD' && to === 'INR') {
        convertedAmount = await this.currencyService.convertUsdToInrWithCurrentRate(amount);
        formattedResult = this.currencyService.formatInr(convertedAmount);
      } else {
        // Same currency, no conversion needed
        convertedAmount = amount;
        formattedResult = from === 'INR'
          ? this.currencyService.formatInr(amount)
          : this.currencyService.formatUsd(amount);
      }

      return {
        success: true,
        data: {
          originalAmount: amount,
          from,
          to,
          convertedAmount,
          formatted: formattedResult,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to convert currency',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('calculate-yearly')
  @ApiOperation({ summary: 'Calculate yearly price with discount' })
  async calculateYearlyPrice(
    @Body() body: { monthlyPrice: number; discountPercent: number; currency?: 'INR' | 'USD' },
  ) {
    const { monthlyPrice, discountPercent, currency = 'INR' } = body;

    if (monthlyPrice === undefined || monthlyPrice === null) {
      throw new HttpException('monthlyPrice is required', HttpStatus.BAD_REQUEST);
    }

    if (typeof monthlyPrice !== 'number' || !Number.isFinite(monthlyPrice) || monthlyPrice < 0) {
      throw new HttpException(
        'monthlyPrice must be a non-negative number',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (discountPercent === undefined || discountPercent === null) {
      throw new HttpException('discountPercent is required', HttpStatus.BAD_REQUEST);
    }

    if (
      typeof discountPercent !== 'number' ||
      !Number.isFinite(discountPercent) ||
      discountPercent < 0 ||
      discountPercent > 100
    ) {
      throw new HttpException(
        'discountPercent must be between 0 and 100',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const yearlyPrice = this.currencyService.calculateYearlyPrice(monthlyPrice, discountPercent);
      const totalSavings = monthlyPrice * 12 - yearlyPrice;

      const formattedYearly = currency === 'INR'
        ? this.currencyService.formatInr(yearlyPrice)
        : this.currencyService.formatUsd(yearlyPrice);

      const formattedMonthly = currency === 'INR'
        ? this.currencyService.formatInr(monthlyPrice)
        : this.currencyService.formatUsd(monthlyPrice);

      const formattedSavings = currency === 'INR'
        ? this.currencyService.formatInr(totalSavings)
        : this.currencyService.formatUsd(totalSavings);

      return {
        success: true,
        data: {
          monthlyPrice,
          formattedMonthly,
          yearlyPrice,
          formattedYearly,
          discountPercent,
          totalSavings,
          formattedSavings,
          effectiveMonthly: yearlyPrice / 12,
          formattedEffectiveMonthly: currency === 'INR'
            ? this.currencyService.formatInr(yearlyPrice / 12)
            : this.currencyService.formatUsd(yearlyPrice / 12),
          currency,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to calculate yearly price',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Exchange Rate API Endpoints (using new exchange_rates table)

  @Get('exchange-rate/status')
  @ApiOperation({
    summary: 'Get current exchange rate fetch status (forex API integration)',
    description: 'Returns status of daily exchange rate fetches including USD rate, total currencies, and last fetched time',
  })
  async getExchangeRateStatus() {
    try {
      const status = await this.exchangeRateService.getStatus();
      return {
        success: true,
        data: status,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get exchange rate status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('exchange-rate/refresh')
  @ApiOperation({
    summary: 'Force refresh exchange rates from Forex API',
    description: 'Manually trigger a fetch of exchange rates from the Forex API. This updates the exchange_rates table and syncs the USD rate to currency settings.',
  })
  async refreshExchangeRates() {
    try {
      const result = await this.exchangeRateService.forceRefresh();
      if (!result.success) {
        throw new HttpException(result.message, HttpStatus.INTERNAL_SERVER_ERROR);
      }
      await this.currencyService.invalidateCache();
      const rateData = await this.currencyService.getExchangeRate();
      return {
        success: true,
        data: {
          ...result,
          inrToUsd: rateData.inr_to_usd,
          usdToInr: result.usdToInr ?? rateData.usd_to_inr,
          lastUpdated: rateData.last_updated,
          source: 'forex-api',
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        error.message || 'Failed to refresh exchange rates',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('exchange-rate/all')
  @ApiOperation({
    summary: 'Get all exchange rates for today',
    description: 'Returns all exchange rates fetched today with INR as base currency. Includes USD and other currencies.',
  })
  async getAllExchangeRates() {
    try {
      const rates = await this.exchangeRateService.getAllRates();
      const inrRate = rates.find((r) => r.target_currency === 'INR');

      return {
        success: true,
        data: {
          baseCurrency: 'USD',
          date: rates.length > 0 ? rates[0].date : null,
          totalCurrencies: rates.length,
          inrRate: inrRate || null,
          rates,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get exchange rates',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('exchange-rate/current')
  @ApiOperation({
    summary: 'Get current USD exchange rate',
    description: 'Returns current INR/USD rate from both legacy currency settings and exchange_rates table.',
  })
  async getCurrentExchangeRate() {
    try {
      const rateData = await this.currencyService.getExchangeRate();
      const status = await this.exchangeRateService.getStatus();
      const forexUsdToInr = await this.exchangeRateService.getUsdToInrRate();
      const usdToInr = forexUsdToInr ?? status.usdToInr ?? rateData.usd_to_inr;
      const inrToUsd = usdToInr > 0 ? 1 / usdToInr : rateData.inr_to_usd;
      const isForexSource =
        forexUsdToInr != null ||
        rateData.updated_by === 'system-cron' ||
        rateData.updated_by === 'forex-api';

      return {
        success: true,
        data: {
          inrToUsd,
          usdToInr,
          displayPrimary: `1 USD = ${usdToInr.toFixed(2)} INR`,
          displaySecondary: `1 INR = ${inrToUsd.toFixed(6)} USD`,
          lastUpdated: rateData.last_updated,
          updatedBy: isForexSource ? 'forex-api' : rateData.updated_by,
          source: isForexSource ? 'forex-api' : 'manual/database',
          lastFetchedAt: status.lastFetchedAt,
          totalCurrencies: status.totalCurrencies,
          cached: status.cached,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get exchange rate',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
