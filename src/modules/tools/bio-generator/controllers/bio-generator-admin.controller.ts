/**
 * BioGeneratorAdminController — Owner/admin-only analytics for the bio tool.
 *
 * GET /admin/bio-generator/analytics
 *   Returns thumbs-up/down aggregates broken down by platform, angle, tone,
 *   focus area, emojis on/off, and bio type — plus the 50 most recent votes
 *   with the bio snapshot so admins can spot-check what people are voting on.
 *
 * Guards: AuthGuard (must be logged in) + AdminGuard (owner role). Same
 * pattern used by every other `/admin/*` controller in the repo.
 */

import { Controller, Get, HttpException, HttpStatus, Logger, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../../../../guards/admin.guard';
import { AuthGuard } from '../../../../guards/auth.guard';
import { BioFeedbackService } from '../services/bio-feedback.service';

@ApiTags('admin-bio-generator')
@Controller('admin/bio-generator')
@ApiBearerAuth()
@UseGuards(AuthGuard, AdminGuard)
export class BioGeneratorAdminController {
  private readonly logger = new Logger(BioGeneratorAdminController.name);

  constructor(private readonly feedback: BioFeedbackService) {}

  @Get('analytics')
  @ApiOperation({
    summary:
      'Aggregate thumbs-up/thumbs-down for the bio generator — overall + per platform/angle/tone/focus/emoji/type + recent 50 votes.',
  })
  async analytics() {
    try {
      const analytics = await this.feedback.analytics();
      return { success: true, ...analytics };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load analytics';
      this.logger.error(msg);
      throw new HttpException(msg, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
