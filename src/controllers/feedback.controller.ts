import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthGuard } from '../guards/auth.guard';
import { FeedbackService } from '../services/feedback.service';

interface AuthedRequest extends Request {
  user: { id: string; email: string };
}

@ApiTags('feedback')
@Controller('feedback')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Get('eligibility')
  @ApiOperation({ summary: 'Whether to show the product feedback modal' })
  async eligibility(@Req() req: AuthedRequest) {
    return this.feedbackService.getEligibility(req.user.id);
  }

  @Post('submit')
  @ApiOperation({ summary: 'Submit one-time product feedback' })
  async submit(
    @Req() req: AuthedRequest,
    @Body() body: { rating: number; message?: string },
  ) {
    return this.feedbackService.submitFeedback(req.user.id, body);
  }

  @Post('skip')
  @ApiOperation({ summary: 'Dismiss feedback prompt (retry after 24h)' })
  async skip(@Req() req: AuthedRequest) {
    await this.feedbackService.skipFeedback(req.user.id);
    return { success: true };
  }
}
