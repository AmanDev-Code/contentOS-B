import {
  Controller,
  Post,
  Headers,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TrendingHashtagOrchestratorService } from '../services/trending-hashtag-orchestrator.service';
import { CacheService } from '../services/cache.service';

function assertInternalSecret(provided: string | undefined): void {
  const expected = process.env.TRENDING_INTERNAL_SECRET || '';
  if (!expected) {
    throw new HttpException(
      'TRENDING_INTERNAL_SECRET not configured',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  if (!provided || provided !== expected) {
    throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
  }
}

@ApiTags('internal')
@Controller('internal')
export class InternalController {
  constructor(
    private readonly orchestrator: TrendingHashtagOrchestratorService,
    private readonly cacheService: CacheService,
  ) {}

  @Post('trending/refresh-all')
  @ApiOperation({ summary: 'Internal: force refresh all active tags' })
  async refreshAll(@Headers('x-internal-secret') secret?: string) {
    assertInternalSecret(secret);
    await this.orchestrator.enqueueSyncNow();
    return { success: true, message: 'Global tag sync queued' };
  }

  @Post('trending/cache/clear')
  @ApiOperation({ summary: 'Internal: clear trending cache keys' })
  async clearCache(@Headers('x-internal-secret') secret?: string) {
    assertInternalSecret(secret);
    const removed = await this.cacheService.deleteByPrefix('trending:');
    return { success: true, removed };
  }
}
