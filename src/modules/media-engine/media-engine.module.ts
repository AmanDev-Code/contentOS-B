import { Module, OnModuleInit } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { QUEUES } from './core';
import { CacheService } from '../../services/cache.service';
import { BrowserPoolService } from '../../services/scrapers/browser-pool.service';
import { EmailService } from '../../services/email.service';
import { SupabaseService } from '../../services/supabase.service';

// Services
import {
  DeviceManagerService,
  CookieManagerService,
  SessionManagerService,
  SessionPoolService,
  CircuitBreakerService,
  CooldownManagerService,
  EngineOrchestratorService,
  HealthCheckerService,
  MediaEngineAlertService,
} from './services';

// Engines
import {
  InstagramPrivateApiEngine,
  InstagramMobileApiEngine,
  InstagramBrowserEngine,
  InstagramEmbedEngine,
} from './extractors';

// Workers
import { MediaDownloadWorker } from './workers';

/**
 * Media Engine Module — Universal media extraction system.
 *
 * COMPLETELY ISOLATED from main Trndinn core.
 * Uses existing: DragonflyDB (via CacheService), BullMQ, Playwright, MinIO.
 *
 * Architecture:
 * Request → BullMQ Queue → Worker → Engine Orchestrator → Engine Chain → Result
 *
 * Engine chain (priority order):
 * 1. Instagram Private API (GraphQL doc_id POST)
 * 2. Instagram Mobile API (/api/v1/media/)
 * 3. Instagram Browser (Playwright)
 * 4. Instagram Embed (unauthenticated — no session needed)
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUES.DOWNLOAD, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } },
      { name: QUEUES.HEALTH_CHECK },
      { name: QUEUES.SESSION_REFRESH },
    ),
  ],
  providers: [
    // External dependencies (provided locally — not imported from a shared module)
    CacheService,
    BrowserPoolService,
    EmailService,
    SupabaseService,

    // Core services (order matters for DI resolution)
    MediaEngineAlertService,
    DeviceManagerService,
    CookieManagerService,
    SessionManagerService,
    SessionPoolService,
    CircuitBreakerService,
    CooldownManagerService,
    EngineOrchestratorService,
    HealthCheckerService,

    // Engines
    InstagramPrivateApiEngine,
    InstagramMobileApiEngine,
    InstagramBrowserEngine,
    InstagramEmbedEngine,

    // Workers
    MediaDownloadWorker,
  ],
  exports: [
    EngineOrchestratorService,
    SessionPoolService,
    HealthCheckerService,
    DeviceManagerService,
    MediaEngineAlertService,
    CircuitBreakerService,
  ],
})
export class MediaEngineModule implements OnModuleInit {
  constructor(
    private readonly orchestrator: EngineOrchestratorService,
    private readonly privateApi: InstagramPrivateApiEngine,
    private readonly mobileApi: InstagramMobileApiEngine,
    private readonly browserEngine: InstagramBrowserEngine,
    private readonly embedEngine: InstagramEmbedEngine,
  ) {}

  /**
   * Register all engines with the orchestrator on module init.
   */
  onModuleInit(): void {
    this.orchestrator.registerEngine(this.privateApi);
    this.orchestrator.registerEngine(this.mobileApi);
    this.orchestrator.registerEngine(this.browserEngine);
    this.orchestrator.registerEngine(this.embedEngine);
  }
}
