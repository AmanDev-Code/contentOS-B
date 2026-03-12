import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import configuration from './config/configuration';
import { AppController } from './app.controller';
import { AppService } from './app.service';

import { GenerationController } from './controllers/generation.controller';
import { LinkedinController } from './controllers/linkedin.controller';
import { WebhookController } from './controllers/webhook.controller';
import { HealthController } from './controllers/health.controller';
import { CacheController } from './controllers/cache.controller';
import { QuotaController } from './controllers/quota.controller';
import { SubscriptionController } from './controllers/subscription.controller';
import { PublicController } from './controllers/public.controller';

import { SupabaseService } from './services/supabase.service';
import { GenerationService } from './services/generation.service';
import { LinkedinService } from './services/linkedin.service';
import { N8nService } from './services/n8n.service';
import { CacheService } from './services/cache.service';
import { QuotaService } from './services/quota.service';
import { SubscriptionService } from './services/subscription.service';

import { ProfileRepository } from './repositories/profile.repository';
import { GenerationJobRepository } from './repositories/generation-job.repository';
import { GeneratedContentRepository } from './repositories/generated-content.repository';
import { SubscriptionRepository } from './repositories/subscription.repository';

import { GenerationWorker } from './workers/generation.worker';
import { GenerationWorkerManager } from './workers/generation-worker-manager';

import { QUEUE_NAMES } from './common/constants';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          password: process.env.REDIS_PASSWORD || undefined,
        },
      }),
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.CONTENT_GENERATION,
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.LINKEDIN_PUBLISH,
    }),
  ],
  controllers: [
    AppController,
    GenerationController,
    LinkedinController,
    WebhookController,
    HealthController,
    CacheController,
    QuotaController,
    SubscriptionController,
    PublicController,
  ],
  providers: [
    AppService,
    SupabaseService,
    GenerationService,
    LinkedinService,
    N8nService,
    CacheService,
    QuotaService,
    SubscriptionService,
    ProfileRepository,
    GenerationJobRepository,
    GeneratedContentRepository,
    SubscriptionRepository,
    GenerationWorker,
    GenerationWorkerManager,
  ],
})
export class AppModule {}
