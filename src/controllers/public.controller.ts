import { Controller, Get } from '@nestjs/common';
import {
  SubscriptionService,
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
      throw error;
    }
  }
}
