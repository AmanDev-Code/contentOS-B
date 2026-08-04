import { Module } from '@nestjs/common';
import { InstagramReelController } from './controllers/instagram-reel.controller';
import { InstagramReelService } from './services/instagram-reel.service';
import { CacheService } from '../../../services/cache.service';
import { RateLimiterService } from '../../../services/rate-limiter.service';
import { ToolRateLimitGuard } from '../../../guards/tool-rate-limit.guard';
import { ScraperCredentialsService } from '../../../services/scrapers/scraper-credentials.service';
import { MediaEngineModule } from '../../media-engine';

@Module({
  imports: [MediaEngineModule],
  controllers: [InstagramReelController],
  providers: [
    InstagramReelService,
    CacheService,
    RateLimiterService,
    ToolRateLimitGuard,
    ScraperCredentialsService,
  ],
  exports: [InstagramReelService],
})
export class InstagramReelDownloaderModule {}
