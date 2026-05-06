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
import { ScraperDebugController } from './controllers/scraper-debug.controller';
import { EmailController } from './controllers/email.controller';
import { EmailWebhookController } from './controllers/email-webhook.controller';
import { AuthController } from './controllers/auth.controller';
import { ProfileController } from './controllers/profile.controller';
import { OnboardingController } from './controllers/onboarding.controller';
import { PaddleController } from './controllers/paddle.controller';
import { InternalController } from './controllers/internal.controller';
import { CareersController } from './controllers/careers.controller';
import { AdminCareersController } from './controllers/admin-careers.controller';
import { BlogController } from './controllers/blog.controller';
import { AdminBlogController } from './controllers/admin-blog.controller';
import { AdminSeoPagesController } from './controllers/admin-seo-pages.controller';
import { FeedbackController } from './controllers/feedback.controller';
import { PlatformAdminFeedbackController } from './controllers/platform-admin-feedback.controller';
import { PlatformAccessController } from './controllers/platform-access.controller';
import { PlatformGrantsController } from './controllers/platform-grants.controller';
import { PlatformUsersController } from './controllers/platform-users.controller';
import { ModerationController } from './controllers/moderation.controller';
import {
  MaintenanceController,
  AdminMaintenanceController,
} from './controllers/maintenance.controller';
import { MaintenanceService } from './services/maintenance.service';

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
import { ImmediatePostPublishService } from './services/immediate-post-publish.service';
import { LinkedinOAuthStateService } from './services/linkedin-oauth-state.service';
import { NotificationService } from './services/notification.service';
import { EmailService } from './services/email.service';
import { AuthService } from './services/auth.service';
import { OnboardingService } from './services/onboarding.service';
import { PaddleService } from './services/paddle.service';
import { IdempotencyService } from './services/idempotency.service';
import { TrendingTagsService } from './services/trending-tags.service';
import { TrendingHashtagEngineService } from './services/trending-hashtag-engine.service';
import { TrendingHashtagOrchestratorService } from './services/trending-hashtag-orchestrator.service';
import { InstagramScraperService } from './services/scrapers/instagram.scraper';
import { LinkedinScraperService } from './services/scrapers/linkedin.scraper';
import { TwitterScraperService } from './services/scrapers/twitter.scraper';
import { ScraperSessionHealthService } from './services/scrapers/session-health.service';
import { BrowserPoolService } from './services/scrapers/browser-pool.service';
import { ScraperEventLogService } from './services/scrapers/scraper-event-log.service';
import { ScraperCredentialsService } from './services/scrapers/scraper-credentials.service';
import { PostRefinementService } from './services/post-refinement.service';
import { CareersService } from './services/careers.service';
import { CareersJobCopyAiService } from './services/careers-job-copy-ai.service';
import { BlogService } from './services/blog.service';
import { BlogManagementGuard } from './guards/blog-management.guard';
import { FeedbackService } from './services/feedback.service';
import { PlatformAccessService } from './services/platform-access.service';
import { FeedbackQueueBootstrapService } from './services/feedback-queue-bootstrap.service';
import { PlatformStaffGuard } from './guards/platform-staff.guard';
import { ModerationGuard } from './guards/moderation.guard';
import { ModerationService } from './modules/moderation/moderation.service';
import { CreditPreflightGuard } from './guards/credit-preflight.guard';
import { CustomTopicCreditService } from './modules/credits/custom-topic-credit.service';

import { ProfileRepository } from './repositories/profile.repository';
import { OptionalAuthGuard } from './guards/optional-auth.guard';
import { GenerationJobRepository } from './repositories/generation-job.repository';
import { GeneratedContentRepository } from './repositories/generated-content.repository';
import { SubscriptionRepository } from './repositories/subscription.repository';

import { GenerationWorker } from './workers/generation.worker';
import { GenerationWorkerManager } from './workers/generation-worker-manager';
import { MediaCarouselWorker } from './workers/media-carousel.worker';
import { PostPublishingProcessor } from './processors/post-publishing.processor';
import { TrendingHashtagProcessor } from './workers/trending-hashtag.processor';
import { FeedbackRewardProcessor } from './processors/feedback-reward.processor';
import { FeedbackReminderProcessor } from './processors/feedback-reminder.processor';
import { MaintenanceProcessor } from './processors/maintenance.processor';
import { RateLimitMiddleware } from './middleware/rate-limit.middleware';
import { UserRateLimitGuard } from './guards/user-rate-limit.guard';
import { PaywallGuard } from './guards/paywall.guard';
import { Reflector } from '@nestjs/core';

import { CustomTopicGenerationService } from './modules/post-ai/custom-topic-generation.service';
import { CarouselTrainingCaptureService } from './services/carousel-training-capture.service';
import { OpenAIRateLimiterService } from './services/openai-rate-limiter.service';

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
    BullModule.registerQueue({
      name: QUEUE_NAMES.MEDIA_SINGLE,
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.MEDIA_CAROUSEL,
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.TRENDING_HASHTAGS,
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.FEEDBACK_REWARD,
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.FEEDBACK_REMINDER,
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.MAINTENANCE,
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
    ScraperDebugController,
    EmailController,
    EmailWebhookController,
    AuthController,
    ProfileController,
    OnboardingController,
    PaddleController,
    InternalController,
    CareersController,
    AdminCareersController,
    BlogController,
    AdminBlogController,
    AdminSeoPagesController,
    FeedbackController,
    PlatformAdminFeedbackController,
    PlatformAccessController,
    PlatformGrantsController,
    PlatformUsersController,
    ModerationController,
    MaintenanceController,
    AdminMaintenanceController,
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
    ImmediatePostPublishService,
    LinkedinOAuthStateService,
    {
      provide: NotificationService,
      useClass: NotificationService,
    },
    EmailService,
    AuthService,
    OnboardingService,
    PaddleService,
    IdempotencyService,
    TrendingTagsService,
    TrendingHashtagEngineService,
    TrendingHashtagOrchestratorService,
    BrowserPoolService,
    ScraperCredentialsService,
    PostRefinementService,
    CareersService,
    CareersJobCopyAiService,
    BlogService,
    BlogManagementGuard,
    FeedbackService,
    PlatformAccessService,
    PlatformStaffGuard,
    FeedbackQueueBootstrapService,
    FeedbackRewardProcessor,
    FeedbackReminderProcessor,
    MaintenanceProcessor,
    ScraperEventLogService,
    InstagramScraperService,
    TwitterScraperService,
    LinkedinScraperService,
    ScraperSessionHealthService,
    ProfileRepository,
    OptionalAuthGuard,
    GenerationJobRepository,
    GeneratedContentRepository,
    SubscriptionRepository,
    GenerationWorker,
    GenerationWorkerManager,
    MediaCarouselWorker,
    PostPublishingProcessor,
    TrendingHashtagProcessor,
    RateLimitMiddleware,
    UserRateLimitGuard,
    PaywallGuard,
    CreditPreflightGuard,
    ModerationGuard,
    ModerationService,
    CustomTopicCreditService,
    Reflector,
    CustomTopicGenerationService,
    CarouselTrainingCaptureService,
    OpenAIRateLimiterService,
    MaintenanceService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RateLimitMiddleware).forRoutes('*'); // Apply to all routes
  }
}
