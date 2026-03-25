import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { GetUser } from '../decorators/get-user.decorator';
import { OnboardingService } from '../services/onboarding.service';

@Controller('onboarding')
@UseGuards(AuthGuard, PaywallGuard)
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('status')
  async getStatus(@GetUser() user: { id: string }) {
    const status = await this.onboardingService.getStatus(user.id);
    return { success: true, ...status };
  }

  @Post('complete')
  async completeOnboarding(
    @GetUser() user: { id: string },
    @Body()
    body: {
      role?: string;
      goal?: string;
      teamSize?: string;
      postingFrequency?: string;
      focusArea?: string;
      referralSource?: string;
    },
  ) {
    await this.onboardingService.completeOnboarding(user.id, body || {});
    return { success: true };
  }

  @Post('tour-complete')
  async completeTour(@GetUser() user: { id: string }) {
    await this.onboardingService.completeTour(user.id);
    return { success: true };
  }
}
