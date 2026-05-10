import { Controller, Get } from '@nestjs/common';
import {
  SubscriptionService,
  SubscriptionPlan,
  PublicPlansPayload,
} from '../services/subscription.service';

@Controller('public')
export class PublicController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get('plans')
  async getSubscriptionPlans(): Promise<PublicPlansPayload> {
    try {
      return await this.subscriptionService.getPublicPlansPayload();
    } catch (error) {
      console.error('Error getting subscription plans:', error);

      const plans: SubscriptionPlan[] = [
        {
          id: 'standard',
          planType: 'standard',
          name: 'Standard',
          description: 'Great for regular content creators',
          creditsLimit: 500,
          priceMonthly: 15.0,
          priceYearly: 150.0,
          features: [
            '500 AI credits per month',
            'Advanced content generation',
            'Priority support',
          ],
          isActive: true,
          sortOrder: 1,
          displayPricing: null,
        },
        {
          id: 'pro',
          planType: 'pro',
          name: 'Pro',
          description: 'Perfect for businesses and agencies',
          creditsLimit: 2000,
          priceMonthly: 25.0,
          priceYearly: 250.0,
          features: [
            '2000 AI credits per month',
            'Premium content generation',
            'Advanced analytics',
          ],
          isActive: true,
          sortOrder: 2,
          displayPricing: null,
        },
        {
          id: 'ultimate',
          planType: 'ultimate',
          name: 'Ultimate',
          description: 'For enterprise and high-volume users',
          creditsLimit: 10000,
          priceMonthly: 49.0,
          priceYearly: 490.0,
          features: [
            '10000 AI credits per month',
            'Unlimited content generation',
            'Enterprise analytics',
          ],
          isActive: true,
          sortOrder: 3,
          displayPricing: null,
        },
      ];

      return {
        plans,
        pricingDisplay: {
          defaultCurrency: 'USD',
          supportedCurrencies: ['USD', 'INR'],
        },
      };
    }
  }
}
