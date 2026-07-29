import { Module } from '@nestjs/common';
import { ToolsController } from './controllers/tools.controller';
import { ToolsService } from './services/tools.service';
import { InstagramReelService } from './services/instagram-reel.service';
import { CacheService } from '../../services/cache.service';
import { RateLimiterService } from '../../services/rate-limiter.service';
import { ToolRateLimitGuard } from '../../guards/tool-rate-limit.guard';
import { ScraperCredentialsService } from '../../services/scrapers/scraper-credentials.service';
import { MediaEngineModule } from '../media-engine';

@Module({
  imports: [MediaEngineModule],
  controllers: [ToolsController],
  providers: [
    ToolsService,
    InstagramReelService,
    CacheService,
    RateLimiterService,
    ToolRateLimitGuard,
    ScraperCredentialsService,
  ],
  exports: [ToolsService, InstagramReelService],
})
export class ToolsModule {}
