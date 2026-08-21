/**
 * BioGeneratorModule — Self-contained NestJS module for the Bio Generator tool.
 *
 * Follows the same modular pattern as AutoCaptionModule and
 * InstagramReelDownloaderModule: everything lives inside this folder, imports
 * only what it uses, exports the service for cross-module reuse.
 *
 * No BullMQ — bio generation is a fast synchronous LLM call (~2-8s), not a
 * long pipeline like captioning. All work happens in the controller path.
 */

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BioGeneratorAdminController } from './controllers/bio-generator-admin.controller';
import { BioGeneratorController } from './controllers/bio-generator.controller';
import { BioFeedbackService, BioGeneratorService, PromptBuilderService } from './services';

// Shared services provided locally so this module has no global deps.
import { AiGatewayService } from '../../../services/ai-gateway.service';
import { AiModelRegistryService } from '../../../services/ai-model-registry.service';
import { AppSettingsService } from '../../../services/app-settings.service';
import { CacheService } from '../../../services/cache.service';
import { RateLimiterService } from '../../../services/rate-limiter.service';
import { SupabaseService } from '../../../services/supabase.service';
import { ProfileRepository } from '../../../repositories/profile.repository';
import { AuthGuard } from '../../../guards/auth.guard';
import { AdminGuard } from '../../../guards/admin.guard';
import { ToolRateLimitGuard } from '../../../guards/tool-rate-limit.guard';

@Module({
  controllers: [BioGeneratorController, BioGeneratorAdminController],
  providers: [
    ConfigService,
    CacheService,
    SupabaseService,
    AppSettingsService,
    AiModelRegistryService,
    AiGatewayService,
    RateLimiterService,
    ProfileRepository,
    AuthGuard,
    AdminGuard,
    ToolRateLimitGuard,
    PromptBuilderService,
    BioFeedbackService,
    BioGeneratorService,
  ],
  exports: [BioGeneratorService, BioFeedbackService],
})
export class BioGeneratorModule {}
