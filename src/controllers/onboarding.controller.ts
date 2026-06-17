import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { GetUser } from '../decorators/get-user.decorator';
import { OnboardingService } from '../services/onboarding.service';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('questions')
  async getActiveQuestions() {
    const questions = await this.onboardingService.listActiveQuestions();
    return { success: true, data: questions };
  }

  @Get('status')
  @UseGuards(AuthGuard, PaywallGuard)
  async getStatus(@GetUser() user: { id: string }) {
    const status = await this.onboardingService.getStatus(user.id);
    return { success: true, ...status };
  }

  @Post('complete')
  @UseGuards(AuthGuard, PaywallGuard)
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

  @Post('responses')
  @UseGuards(AuthGuard, PaywallGuard)
  async saveResponses(
    @GetUser() user: { id: string },
    @Body()
    body: {
      responses: { questionId: string; selectedOption: string }[];
    },
  ) {
    if (!body.responses || !Array.isArray(body.responses)) {
      return { success: false, error: 'responses array is required' };
    }

    const saved = await this.onboardingService.saveAllResponses(
      user.id,
      body.responses,
    );
    return { success: true, data: saved };
  }

  @Post('response')
  @UseGuards(AuthGuard, PaywallGuard)
  async saveResponse(
    @GetUser() user: { id: string },
    @Body()
    body: {
      questionId: string;
      selectedOption: string;
    },
  ) {
    if (!body.questionId || !body.selectedOption) {
      return {
        success: false,
        error: 'questionId and selectedOption are required',
      };
    }

    const saved = await this.onboardingService.saveResponse(
      user.id,
      body.questionId,
      body.selectedOption,
    );
    return { success: true, data: saved };
  }

  @Get('my-responses')
  @UseGuards(AuthGuard, PaywallGuard)
  async getMyResponses(@GetUser() user: { id: string }) {
    const responses = await this.onboardingService.getUserResponses(user.id);
    return { success: true, data: responses };
  }

  @Post('tour-complete')
  @UseGuards(AuthGuard, PaywallGuard)
  async completeTour(@GetUser() user: { id: string }) {
    await this.onboardingService.completeTour(user.id);
    return { success: true };
  }

  @Post('activation-complete')
  @UseGuards(AuthGuard, PaywallGuard)
  async completeActivation(@GetUser() user: { id: string }) {
    await this.onboardingService.completeActivation(user.id);
    return { success: true };
  }
}
