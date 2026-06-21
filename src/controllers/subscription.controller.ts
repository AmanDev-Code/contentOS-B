import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  UseGuards,
  Req,
  HttpException,
  HttpStatus,
  ValidationPipe,
  UsePipes,
  Param,
  Query,
  Logger,
} from '@nestjs/common';
import {
  SubscriptionService,
  UserSubscription,
  SubscriptionPlan,
  BillingInfo,
} from '../services/subscription.service';
import { AuthService } from '../services/auth.service';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { IsString, IsIn, IsOptional } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { DiscountCodesService } from '../services/discount-codes.service';
import { PolarService } from '../services/polar.service';
import { LaunchPricingService } from '../services/launch-pricing.service';
import { resolvePolarBillingReturnUrl } from '../utils/polar-billing-url.util';

class UpdateSubscriptionDto {
  @IsString()
  @IsIn(['free', 'standard', 'pro', 'ultimate'])
  planType: string;

  @IsString()
  @IsIn(['monthly', 'yearly'])
  billingCycle: string;

  @IsOptional()
  @IsString()
  stripePaymentMethodId?: string;
}

class ChangePlanDto {
  @IsString()
  @IsIn(['standard', 'pro', 'ultimate'])
  planType: 'standard' | 'pro' | 'ultimate';

  @IsString()
  @IsIn(['monthly', 'yearly'])
  billingCycle: 'monthly' | 'yearly';
}

class CheckoutUrlDto {
  @IsString()
  @IsIn(['standard', 'pro', 'ultimate'])
  planType: 'standard' | 'pro' | 'ultimate';

  @IsString()
  @IsIn(['monthly', 'yearly'])
  billingCycle: 'monthly' | 'yearly';

  @IsOptional()
  @IsString()
  discountCode?: string;

  @IsOptional()
  @IsString()
  successUrl?: string;

  @IsOptional()
  @IsString()
  cancelUrl?: string;
}

@Controller('subscription')
@UseGuards(AuthGuard, PaywallGuard)
export class SubscriptionController {
  private readonly logger = new Logger(SubscriptionController.name);

  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly authService: AuthService,
    private readonly polarService: PolarService,
    private readonly discountCodesService: DiscountCodesService,
    private readonly configService: ConfigService,
    private readonly launchPricingService: LaunchPricingService,
  ) {}

  @Get()
  async getUserSubscription(@Req() req: any): Promise<UserSubscription | null> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException(
        'User not authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }

    try {
      return await this.subscriptionService.getUserSubscription(userId);
    } catch (error) {
      console.error('Error getting user subscription:', error);
      throw new HttpException(
        'Failed to get subscription',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('plans')
  // Remove auth guard for public plans endpoint
  async getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    try {
      return await this.subscriptionService.getSubscriptionPlans();
    } catch (error) {
      console.error('Error getting subscription plans:', error);
      throw new HttpException(
        'Failed to get subscription plans',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('billing')
  async getBillingInfo(@Req() req: any): Promise<BillingInfo> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException(
        'User not authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }

    try {
      return await this.subscriptionService.getBillingInfo(userId);
    } catch (error) {
      console.error('Error getting billing info:', error);
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(
        'Failed to get billing information',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Put('update')
  @UsePipes(new ValidationPipe({ transform: true }))
  async updateSubscription(
    @Req() req: any,
    @Body() updateDto: UpdateSubscriptionDto,
  ): Promise<UserSubscription> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException(
        'User not authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }

    try {
      const subscription = await this.subscriptionService.updateSubscription(
        userId,
        updateDto.planType,
        updateDto.billingCycle as 'monthly' | 'yearly',
      );

      // Send upgrade confirmation email
      const plans = await this.subscriptionService.getSubscriptionPlans();
      const plan = plans.find((p) => p.planType === updateDto.planType);
      if (plan) {
        const amount =
          updateDto.billingCycle === 'yearly'
            ? plan.priceYearly
            : plan.priceMonthly;
        await this.authService.handleSubscriptionUpgrade(
          userId,
          plan.name,
          amount,
        );
      }

      return subscription;
    } catch (error) {
      console.error('Error updating subscription:', error);
      if (error.message.includes('Invalid plan')) {
        throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
      }
      throw new HttpException(
        'Failed to update subscription',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('cancel')
  async cancelSubscription(@Req() req: any): Promise<{
    success: boolean;
    message: string;
    cancelledViaPolar?: boolean;
  }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException(
        'User not authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }

    try {
      const result = await this.subscriptionService.cancelSubscription(userId);
      return {
        success: true,
        message: result.message || 'Subscription cancelled successfully',
        cancelledViaPolar: result.cancelledViaPolar,
      };
    } catch (error) {
      console.error('Error cancelling subscription:', error);

      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Failed to cancel subscription';
      const statusCode =
        typeof (error as { getStatus?: () => number })?.getStatus === 'function'
          ? (error as { getStatus: () => number }).getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR;

      throw new HttpException(
        {
          statusCode,
          message: errorMessage,
        },
        statusCode,
      );
    }
  }

  @Post('change-plan')
  @UsePipes(new ValidationPipe({ transform: true }))
  async changePlan(
    @Req() req: any,
    @Body() body: ChangePlanDto,
  ): Promise<{ success: boolean; message: string }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException(
        'User not authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }
    try {
      await this.subscriptionService.changePlanForExistingSubscription(
        userId,
        body.planType,
        body.billingCycle,
      );
      return {
        success: true,
        message:
          'Plan change submitted to Polar. Your subscription will update after payment is confirmed.',
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to change subscription plan';
      const status =
        typeof (error as { getStatus?: () => number })?.getStatus === 'function'
          ? (error as { getStatus: () => number }).getStatus()
          : HttpStatus.BAD_REQUEST;
      throw new HttpException(message, status);
    }
  }

  @Get('usage')
  async getUsageStats(@Req() req: any): Promise<{
    currentPeriodUsage: number;
    remainingCredits: number;
    percentageUsed: number;
    resetDate: string;
    planType: string;
    creditsLimit: number;
  }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException(
        'User not authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }

    try {
      const billingInfo = await this.subscriptionService.getBillingInfo(userId);
      return {
        currentPeriodUsage: billingInfo.usage.currentPeriodUsage,
        remainingCredits: billingInfo.usage.remainingCredits,
        percentageUsed: billingInfo.usage.percentageUsed,
        resetDate: billingInfo.usage.resetDate,
        planType: billingInfo.subscription.planType,
        creditsLimit: billingInfo.subscription.creditsLimit,
      };
    } catch (error) {
      console.error('Error getting usage stats:', error);
      throw new HttpException(
        'Failed to get usage statistics',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('portal-url')
  async getPortalUrl(
    @Req() req: { user?: { id?: string } },
    @Query('intent') intent?: 'change' | 'switch',
    @Query('planType') _planType?: 'standard' | 'pro' | 'ultimate',
    @Query('billingCycle') _billingCycle?: 'monthly' | 'yearly',
  ): Promise<{ url: string; intent: 'change' | 'switch' }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException(
        'User not authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const frontendUrl =
      this.configService.get<string>('frontendUrl') || 'http://localhost:3000';
    const returnUrl = resolvePolarBillingReturnUrl(
      frontendUrl,
      'portal_return',
    );
    const resolvedIntent = intent === 'switch' ? 'switch' : 'change';

    try {
      const url = await this.subscriptionService.getCustomerPortalUrl(
        userId,
        returnUrl,
      );
      return { url, intent: resolvedIntent };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to open Polar customer portal';
      const status =
        typeof (error as { getStatus?: () => number })?.getStatus === 'function'
          ? (error as { getStatus: () => number }).getStatus()
          : HttpStatus.BAD_REQUEST;
      throw new HttpException(message, status);
    }
  }

  @Post('customer-portal')
  async getCustomerPortal(
    @Req() req: { user?: { id?: string } },
    @Body() body: { returnUrl?: string },
  ): Promise<{ url: string }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException(
        'User not authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const frontendUrl =
      this.configService.get<string>('frontendUrl') || 'http://localhost:3000';
    const returnUrl = resolvePolarBillingReturnUrl(
      frontendUrl,
      'portal_return',
      body.returnUrl,
    );

    try {
      const url = await this.subscriptionService.getCustomerPortalUrl(
        userId,
        returnUrl,
      );
      return { url };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to open Polar customer portal';
      const status =
        typeof (error as { getStatus?: () => number })?.getStatus === 'function'
          ? (error as { getStatus: () => number }).getStatus()
          : HttpStatus.BAD_REQUEST;
      throw new HttpException(message, status);
    }
  }

  @Post('sync-from-polar')
  async syncFromPolar(
    @Req() req: { user?: { id?: string } },
  ): Promise<{ synced: boolean }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException(
        'User not authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }

    try {
      const synced =
        await this.subscriptionService.syncBillingFromPolar(userId);
      return { synced };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to sync subscription from Polar';
      throw new HttpException(message, HttpStatus.BAD_GATEWAY);
    }
  }

  @Post('checkout-url')
  @UsePipes(new ValidationPipe({ transform: true }))
  async getCheckoutUrl(
    @Req() req: { user?: { id?: string } },
    @Body() body: CheckoutUrlDto,
  ): Promise<{
    url: string;
    checkoutId?: string | null;
    discountApplied?: boolean;
    discountCode?: string;
    redirectKind: 'checkout' | 'portal' | 'in_app';
    message?: string;
  }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException(
        'User not authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const frontendUrl =
      this.configService.get<string>('frontendUrl') || 'http://localhost:3000';
    const successUrl = resolvePolarBillingReturnUrl(
      frontendUrl,
      'success',
      body.successUrl,
    );
    const portalReturnUrl = resolvePolarBillingReturnUrl(
      frontendUrl,
      'portal_return',
    );
    const cancelUrl = resolvePolarBillingReturnUrl(
      frontendUrl,
      'cancel',
      body.cancelUrl,
    );

    let polarDiscountId: string | undefined;
    let normalizedCode: string | undefined;
    if (body.discountCode?.trim()) {
      const validated = await this.discountCodesService.validateForCheckout(
        body.discountCode,
        body.planType,
        body.billingCycle,
      );
      polarDiscountId = validated.polarDiscountId;
      normalizedCode = validated.code;
    }

    const existing = await this.subscriptionService.getUserSubscription(userId);
    const isChangingPlan =
      !existing ||
      existing.planType !== body.planType ||
      existing.billingCycle !== body.billingCycle;

    const portalPlanChangeMessage =
      'Polar allows only one subscription per account. To change your plan or billing cycle, open the customer portal — your card on file will be charged any prorated difference.';

    // Polar rejects checkouts.create when the customer already has an active subscription.
    // Never call checkouts.create for existing subscribers — only the customer portal.
    const dbHasPolarSubscription = Boolean(
      existing?.polarSubscriptionId?.trim() && existing.isActive,
    );
    const shouldProbePolarForSubscription =
      dbHasPolarSubscription ||
      Boolean(existing?.polarCustomerId?.trim()) ||
      (Boolean(existing?.isActive) && existing?.planType !== 'free');

    let shouldUseCustomerPortal = dbHasPolarSubscription;
    if (!shouldUseCustomerPortal && shouldProbePolarForSubscription) {
      shouldUseCustomerPortal =
        await this.polarService.hasActiveSubscriptionForUser(userId);
    }

    const launchPricing = await this.launchPricingService.getActive();

    const checkoutParams = {
      userId,
      planType: body.planType,
      billingCycle: body.billingCycle,
      successUrl,
      cancelUrl,
      discountId: polarDiscountId ?? null,
      allowDiscountCodes: !polarDiscountId,
      launchPricing,
      customData: {
        app: 'trndinn',
        app_reference: `trndinn_${userId}_${body.planType}_${body.billingCycle}_${Date.now()}`,
        ...(normalizedCode ? { discount_code: normalizedCode } : {}),
        ...(shouldUseCustomerPortal ? { plan_change_intent: true } : {}),
      },
    };

    if (shouldUseCustomerPortal && isChangingPlan) {
      if (normalizedCode) {
        this.logger.warn(
          `Promo code ${normalizedCode} ignored for in-app plan change (user ${userId})`,
        );
      }
      await this.subscriptionService.changePlanForExistingSubscription(
        userId,
        body.planType,
        body.billingCycle,
      );
      return {
        url: portalReturnUrl,
        checkoutId: null,
        discountApplied: false,
        discountCode: normalizedCode,
        redirectKind: 'in_app',
        message:
          'Plan updated on Polar. Your card on file was charged any prorated difference.',
      };
    }

    if (shouldUseCustomerPortal) {
      this.logger.log(
        `User ${userId} opening Polar customer portal (manage subscription)`,
      );

      const portalUrl = await this.polarService.createCustomerPortalSession(
        userId,
        portalReturnUrl,
      );
      return {
        url: portalUrl,
        checkoutId: null,
        discountApplied: false,
        discountCode: normalizedCode,
        redirectKind: 'portal',
        message: portalPlanChangeMessage,
      };
    }

    const session = await this.polarService.createCheckoutSession({
      ...checkoutParams,
      allowTrial: !(existing?.trialConsumed ?? false),
    });

    if (!session.url) {
      throw new HttpException(
        'Failed to create Polar checkout session. Ensure POLAR_ACCESS_TOKEN and POLAR_PRICE_* are configured.',
        HttpStatus.BAD_GATEWAY,
      );
    }

    return {
      url: session.url,
      checkoutId: session.id,
      discountApplied: Boolean(polarDiscountId),
      discountCode: normalizedCode,
      redirectKind: 'checkout',
    };
  }

  @Get('discount/validate')
  async validateDiscount(
    @Query('code') code: string,
    @Query('planType') planType: 'standard' | 'pro' | 'ultimate',
    @Query('billingCycle') billingCycle: 'monthly' | 'yearly',
  ) {
    if (!code?.trim()) {
      throw new HttpException('code is required', HttpStatus.BAD_REQUEST);
    }
    if (!planType || !billingCycle) {
      throw new HttpException(
        'planType and billingCycle are required',
        HttpStatus.BAD_REQUEST,
      );
    }
    const validated = await this.discountCodesService.validateForCheckout(
      code,
      planType,
      billingCycle,
    );
    return {
      valid: true,
      code: validated.code,
      name: validated.name,
      discountType: validated.discountType,
      percentOff: validated.percentOff,
      amountOff: validated.amountOff,
      currency: validated.currency,
    };
  }

  @Get('invoice/:transactionId')
  async getInvoiceDownloadUrl(
    @Req() req: any,
    @Param('transactionId') transactionId: string,
  ): Promise<{ url: string }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException(
        'User not authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const url = await this.subscriptionService.resolveInvoiceDownloadUrl(
      userId,
      transactionId,
    );
    if (!url) {
      throw new HttpException(
        'Invoice URL not available',
        HttpStatus.NOT_FOUND,
      );
    }
    return { url };
  }
}
