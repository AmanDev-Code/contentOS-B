import { Controller, Get } from '@nestjs/common';
import { SubscriptionService, SubscriptionPlan } from '../services/subscription.service';

@Controller('public')
export class PublicController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get('plans')
  async getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    try {
      return await this.subscriptionService.getSubscriptionPlans();
    } catch (error) {
      console.error('Error getting subscription plans:', error);
      // Return fallback plans
      return [
        {
          id: 'standard',
          planType: 'standard',
          name: 'Standard',
          description: 'Great for regular content creators',
          creditsLimit: 500,
          priceMonthly: 15.00,
          priceYearly: 150.00,
          features: ['500 AI credits per month', 'Advanced content generation', 'Priority support'],
          isActive: true,
          sortOrder: 1,
        },
        {
          id: 'pro',
          planType: 'pro',
          name: 'Pro',
          description: 'Perfect for businesses and agencies',
          creditsLimit: 2000,
          priceMonthly: 25.00,
          priceYearly: 250.00,
          features: ['2000 AI credits per month', 'Premium content generation', 'Advanced analytics'],
          isActive: true,
          sortOrder: 2,
        },
        {
          id: 'ultimate',
          planType: 'ultimate',
          name: 'Ultimate',
          description: 'For enterprise and high-volume users',
          creditsLimit: 10000,
          priceMonthly: 49.00,
          priceYearly: 490.00,
          features: ['10000 AI credits per month', 'Unlimited content generation', 'Enterprise analytics'],
          isActive: true,
          sortOrder: 3,
        },
      ];
    }
  }
}