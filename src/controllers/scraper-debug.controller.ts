import {
  Controller,
  Get,
  Post,
  Headers,
  HttpException,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ScraperSessionHealthService } from '../services/scrapers/session-health.service';
import { InstagramScraperService } from '../services/scrapers/instagram.scraper';
import { TwitterScraperService } from '../services/scrapers/twitter.scraper';
import { LinkedinScraperService } from '../services/scrapers/linkedin.scraper';
import { TrendingHashtagOrchestratorService } from '../services/trending-hashtag-orchestrator.service';
import { ScraperEventLogService } from '../services/scrapers/scraper-event-log.service';

function assertSecret(secret?: string) {
  const expected = process.env.ADMIN_ACTION_SECRET || '';
  if (!expected || !secret || secret !== expected) {
    throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
  }
}

@ApiTags('scraper-debug')
@Controller('scraper-debug')
export class ScraperDebugController {
  constructor(
    private readonly health: ScraperSessionHealthService,
    private readonly instagram: InstagramScraperService,
    private readonly twitter: TwitterScraperService,
    private readonly linkedin: LinkedinScraperService,
    private readonly orchestrator: TrendingHashtagOrchestratorService,
    private readonly eventLog: ScraperEventLogService,
  ) {}

  @Get('events')
  @ApiOperation({ summary: 'Recent scraper events (secret-gated)' })
  async events(
    @Query('limit') limit?: string,
    @Headers('x-admin-action-secret') secret?: string,
  ) {
    assertSecret(secret);
    const n = Math.max(1, Math.min(parseInt(limit || '50', 10) || 50, 200));
    return {
      success: true,
      data: {
        summary: this.eventLog.summary(),
        events: this.eventLog.list(n),
      },
    };
  }

  @Post('refresh-all')
  @ApiOperation({
    summary: 'Queue global refresh of all active tags (secret-gated)',
  })
  async refreshAll(@Headers('x-admin-action-secret') secret?: string) {
    assertSecret(secret);
    await this.orchestrator.enqueueSyncNow();
    return { success: true, message: 'Global tag sync queued' };
  }

  @Get('health')
  @ApiOperation({ summary: 'Session cookie health (secret-gated)' })
  async healthCheck(@Headers('x-admin-action-secret') secret?: string) {
    assertSecret(secret);
    const data = await this.health.check();
    return { success: true, data };
  }

  @Get('fetch')
  @ApiOperation({
    summary: 'Test-fetch one tag on one platform (secret-gated)',
  })
  async testFetch(
    @Query('platform') platform: string,
    @Query('tag') tag: string,
    @Query('limit') limit?: string,
    @Headers('x-admin-action-secret') secret?: string,
  ) {
    assertSecret(secret);
    if (!platform || !tag) {
      throw new HttpException(
        'platform and tag are required',
        HttpStatus.BAD_REQUEST,
      );
    }
    const n = Math.max(1, Math.min(parseInt(limit || '10', 10) || 10, 30));
    const started = Date.now();
    try {
      let posts: unknown[] = [];
      if (platform === 'instagram') posts = await this.instagram.fetch(tag, n);
      else if (platform === 'twitter' || platform === 'x')
        posts = await this.twitter.fetch(tag, n);
      else if (platform === 'linkedin')
        posts = await this.linkedin.fetch(tag, n);
      else
        throw new HttpException(
          'platform must be instagram|twitter|linkedin',
          HttpStatus.BAD_REQUEST,
        );
      return {
        success: true,
        platform,
        tag,
        elapsedMs: Date.now() - started,
        count: posts.length,
        sample: posts.slice(0, 3),
      };
    } catch (error) {
      return {
        success: false,
        platform,
        tag,
        elapsedMs: Date.now() - started,
        error: (error as Error).message,
      };
    }
  }
}
