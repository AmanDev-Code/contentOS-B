import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import {
  UsageTrackingService,
  type UsageSummary,
} from '../services/usage-tracking.service';

/**
 * Sprint 1.9 — Usage Tracking Foundation (DATA ONLY, NO ENFORCEMENT).
 *
 * `GET /usage` returns the authed user's current-period post + AI-generation
 * usage alongside display-only plan caps. This endpoint is read-only and never
 * blocks anything — enforcement is deferred to Phase 2 (Sprint 1.9b).
 *
 * NOTE: deliberately NOT behind PaywallGuard — usage must always be readable
 * (including for over-limit / lapsed users) so the panel can render everywhere.
 */
@Controller('usage')
@UseGuards(AuthGuard)
export class UsageController {
  constructor(private readonly usageTrackingService: UsageTrackingService) {}

  @Get()
  async getUsage(@Req() req: { user?: { id?: string } }): Promise<UsageSummary> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    return this.usageTrackingService.getUsageSummary(userId);
  }
}
