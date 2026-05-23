import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { LaunchPricingService } from '../services/launch-pricing.service';
import { SubscriptionService } from '../services/subscription.service';

@ApiTags('public')
@Controller('public/launch-pricing')
export class PublicLaunchPricingController {
  constructor(
    private readonly launchPricingService: LaunchPricingService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  @Get('active')
  @ApiOperation({ summary: 'Get active launch pricing for marketing and billing UI' })
  async getActive() {
    const plans = await this.subscriptionService.getSubscriptionPlans();
    const config = await this.launchPricingService.getPublicActiveConfig(plans);
    return {
      success: true,
      config,
    };
  }
}
