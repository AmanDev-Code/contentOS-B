import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { PlatformStaffGuard } from '../guards/platform-staff.guard';
import { FeedbackService } from '../services/feedback.service';

@ApiTags('platform-admin')
@Controller('platform-admin/feedback')
@UseGuards(AuthGuard, PaywallGuard, PlatformStaffGuard)
@ApiBearerAuth()
export class PlatformAdminFeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Get()
  @ApiOperation({ summary: 'List feedback with aggregates (staff)' })
  async list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('rating') rating?: string,
    @Query('refresh') refresh?: string,
  ) {
    const p = page ? parseInt(page, 10) : 1;
    const l = limit ? parseInt(limit, 10) : 20;
    const r =
      rating !== undefined && rating !== ''
        ? parseInt(rating, 10)
        : undefined;
    return this.feedbackService.adminListFeedback({
      page: p,
      limit: l,
      rating: Number.isFinite(r as number) ? r : undefined,
      cacheBuster: refresh === '1' || refresh === 'true',
    });
  }
}
