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
import { MediaController } from './controllers/media.controller';
import { PostsController } from './controllers/posts.controller';
import { ContentController } from './controllers/content.controller';
import { MinioProxyController } from './controllers/minio-proxy.controller';
import { NotificationController } from './controllers/notification.controller';
import { AdminController } from './controllers/admin.controller';
import { EmailController } from './controllers/email.controller';
import { EmailWebhookController } from './controllers/email-webhook.controller';
import { AuthController } from './controllers/auth.controller';
import { ProfileController } from './controllers/profile.controller';
import { OnboardingController } from './controllers/onboarding.controller';
import { PaddleController } from './controllers/paddle.controller';

import { SupabaseService } from './services/supabase.service';
import { GenerationService } from './services/generation.service';
import { LinkedinService } from './services/linkedin.service';
import { N8nService } from './services/n8n.service';
import { CacheService } from './services/cache.service';
import { QuotaService } from './services/quota.service';
import { SubscriptionService } from './services/subscription.service';
import { MediaGenerationService } from './services/media-generation.service';
import { MinioService } from './services/minio.service';
import { PostSchedulingService } from './services/post-scheduling.service';
import { NotificationService } from './services/notification.service';
import { EmailService } from './services/email.service';
import { AuthService } from './services/auth.service';
import { OnboardingService } from './services/onboarding.service';
import { PaddleService } from './services/paddle.service';

import { ProfileRepository } from './repositories/profile.repository';
import { OptionalAuthGuard } from './guards/optional-auth.guard';
import { GenerationJobRepository } from './repositories/generation-job.repository';
import { GeneratedContentRepository } from './repositories/generated-content.repository';
import { SubscriptionRepository } from './repositories/subscription.repository';

import { GenerationWorker } from './workers/generation.worker';
import { GenerationWorkerManager } from './workers/generation-worker-manager';
import { PostPublishingProcessor } from './processors/post-publishing.processor';
import { RateLimitMiddleware } from './middleware/rate-limit.middleware';
import { PaywallGuard } from './guards/paywall.guard';
import { Reflector } from '@nestjs/core';

import { QUEUE_NAMES } from './common/constants';
import { MiddlewareConsumer, NestModule } from '@nestjs/common';

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
    BullModule.registerQueue({
      name: 'post-publishing',
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
    MediaController,
    PostsController,
    ContentController,
    MinioProxyController,
    NotificationController,
    AdminController,
    EmailController,
    EmailWebhookController,
    AuthController,
    ProfileController,
    OnboardingController,
    PaddleController,
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
    MediaGenerationService,
    MinioService,
    PostSchedulingService,
    {
      provide: NotificationService,
      useClass: NotificationService,
    },
    EmailService,
    AuthService,
    OnboardingService,
    PaddleService,
    ProfileRepository,
    OptionalAuthGuard,
    GenerationJobRepository,
    GeneratedContentRepository,
    SubscriptionRepository,
    GenerationWorker,
    GenerationWorkerManager,
    PostPublishingProcessor,
    RateLimitMiddleware,
    PaywallGuard,
    Reflector,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RateLimitMiddleware).forRoutes('*'); // Apply to all routes
  }
}
