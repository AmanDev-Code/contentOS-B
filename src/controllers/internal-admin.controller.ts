import { Controller, HttpException, HttpStatus, Post, Req } from '@nestjs/common';
import { TrendingHashtagOrchestratorService } from '../services/trending-hashtag-orchestrator.service';

/**
 * Dev-only internal endpoints for local testing without user JWT.
 * Protected by header `x-internal-admin-secret`.
 */
@Controller('internal/admin')
export class InternalAdminController {
  constructor(
    private readonly trendingOrchestratorService: TrendingHashtagOrchestratorService,
  ) {}

  private assertEnabledAndAuthorized(req: any): void {
    if (process.env.NODE_ENV === 'production') {
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }
    const secret = process.env.INTERNAL_ADMIN_SECRET || '';
    if (!secret) {
      throw new HttpException(
        'INTERNAL_ADMIN_SECRET not configured',
        HttpStatus.BAD_REQUEST,
      );
    }
    const provided = String(req?.headers?.['x-internal-admin-secret'] || '');
    if (provided !== secret) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
  }

  @Post('tags/refresh-all')
  async refreshAllTags(@Req() req: any) {
    this.assertEnabledAndAuthorized(req);
    await this.trendingOrchestratorService.enqueueSyncNow();
    return { success: true, message: 'Global tag sync queued' };
  }
}

