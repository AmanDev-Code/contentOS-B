import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { PlatformStaffGuard } from '../guards/platform-staff.guard';
import {
  UserFeedbackService,
  FeedbackType,
  FeedbackStatus,
} from '../services/user-feedback.service';

@ApiTags('platform-admin')
@Controller('platform-admin/user-feedback')
@UseGuards(AuthGuard, PaywallGuard, PlatformStaffGuard)
@ApiBearerAuth()
export class PlatformAdminUserFeedbackController {
  constructor(private readonly userFeedbackService: UserFeedbackService) {}

  @Get()
  @ApiOperation({ summary: 'List all user feedback (admin)' })
  async list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('refresh') refresh?: string,
  ) {
    const p = page ? parseInt(page, 10) : 1;
    const l = limit ? parseInt(limit, 10) : 20;

    const validTypes: FeedbackType[] = ['bug', 'feature', 'general', 'other'];
    const validStatuses: FeedbackStatus[] = ['new', 'reviewed', 'resolved'];

    return this.userFeedbackService.adminListFeedback({
      page: p,
      limit: l,
      type: validTypes.includes(type as FeedbackType)
        ? (type as FeedbackType)
        : undefined,
      status: validStatuses.includes(status as FeedbackStatus)
        ? (status as FeedbackStatus)
        : undefined,
      cacheBuster: refresh === '1' || refresh === 'true',
    });
  }

  @Put(':id/status')
  @ApiOperation({ summary: 'Update feedback status (admin)' })
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: FeedbackStatus; adminNotes?: string },
  ) {
    return this.userFeedbackService.adminUpdateStatus(
      id,
      body.status,
      body.adminNotes,
    );
  }
}
