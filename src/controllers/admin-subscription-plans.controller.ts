import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  NotFoundException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsNumber, IsObject, IsOptional, IsString, Matches } from 'class-validator';

import { SubscriptionService } from '../services/subscription.service';
import type { PlanDisplayPricingMap } from '../services/subscription.service';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { AdminGuard } from '../guards/admin.guard';

export class PricingDisplaySettingsDto {
  @Matches(/^[A-Za-z]{3}$/)
  defaultCurrency: string;

  @IsArray()
  @Matches(/^[A-Za-z]{3}$/, { each: true })
  supportedCurrencies: string[];
}

export class AdminUpdateSubscriptionPlanDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  creditsLimit?: number;

  @IsOptional()
  @IsNumber()
  priceMonthly?: number;

  @IsOptional()
  @IsNumber()
  priceYearly?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * Per-currency display amounts (not Paddle). Keys: USD, INR, …
   * Example: `{ "USD": { "symbol": "$", "listMonthly": 15, ... } }`
   */
  @IsOptional()
  @IsObject()
  displayPricing?: PlanDisplayPricingMap;
}

const PLAN_TYPES = ['free', 'standard', 'pro', 'ultimate'] as const;

@Controller('admin/subscription-plans')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
export class AdminSubscriptionPlansController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get('pricing-display')
  async getPricingDisplay() {
    return this.subscriptionService.getPricingDisplayMeta();
  }

  @Put('pricing-display')
  @UsePipes(new ValidationPipe({ transform: true }))
  async putPricingDisplay(
    @Body() dto: PricingDisplaySettingsDto,
    @Req() req: { user?: { id?: string } },
  ) {
    const ok = await this.subscriptionService.upsertPricingDisplayMeta(
      {
        defaultCurrency: dto.defaultCurrency.toUpperCase(),
        supportedCurrencies: dto.supportedCurrencies.map((c) => c.toUpperCase()),
      },
      req.user?.id,
    );
    return { ok };
  }

  @Get()
  async list() {
    return this.subscriptionService.adminListAllPlans();
  }

  @Get('paddle-catalog-live')
  async paddleCatalogLive() {
    return this.subscriptionService.getPaddleCatalogLiveSnapshot();
  }

  /** Align Supabase display list prices with live Paddle catalog for paid plans (clears offers for Paddle-currency tier). */
  @Post('import-from-paddle-catalog')
  async importFromPaddleCatalog() {
    return this.subscriptionService.importDisplayPricingFromPaddleCatalog();
  }

  @Put(':planType')
  @UsePipes(new ValidationPipe({ transform: true }))
  async update(
    @Param('planType') planType: string,
    @Body() dto: AdminUpdateSubscriptionPlanDto,
  ) {
    if (!(PLAN_TYPES as readonly string[]).includes(planType)) {
      throw new NotFoundException('Invalid plan type');
    }
    const result = await this.subscriptionService.adminUpdateSubscriptionPlan(
      planType,
      {
        name: dto.name,
        description: dto.description,
        creditsLimit: dto.creditsLimit,
        priceMonthly: dto.priceMonthly,
        priceYearly: dto.priceYearly,
        features: dto.features,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
        displayPricing:
          dto.displayPricing === undefined ? undefined : dto.displayPricing,
      },
    );
    return { ok: true as const, paddleCatalogUpdated: result.paddleCatalogUpdated };
  }
}
