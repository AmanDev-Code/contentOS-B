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

@Controller('subscription')
@UseGuards(AuthGuard, PaywallGuard)
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly authService: AuthService,
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
  async cancelSubscription(
    @Req() req: any,
  ): Promise<{ success: boolean; message: string }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException(
        'User not authenticated',
        HttpStatus.UNAUTHORIZED,
      );
    }

    try {
      await this.subscriptionService.cancelSubscription(userId);
      return {
        success: true,
        message: 'Subscription cancelled successfully',
      };
    } catch (error) {
      console.error('Error cancelling subscription:', error);
      throw new HttpException(
        'Failed to cancel subscription',
        HttpStatus.INTERNAL_SERVER_ERROR,
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
        message: 'Subscription change submitted. Syncing with Paddle events.',
      };
    } catch (error) {
      throw new HttpException(
        error?.message || 'Failed to change subscription plan',
        HttpStatus.BAD_REQUEST,
      );
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

  @Get('invoice/:transactionId')
  async getInvoiceDownloadUrl(
    @Req() req: any,
    @Param('transactionId') transactionId: string,
  ): Promise<{ url: string }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const url = await this.subscriptionService.resolveInvoiceDownloadUrl(
      userId,
      transactionId,
    );
    if (!url) {
      throw new HttpException('Invoice URL not available', HttpStatus.NOT_FOUND);
    }
    return { url };
  }
}
