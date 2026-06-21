import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { AppController } from './app.controller';
import { AppService } from './app.service';

import { LinkedinModule } from './integrations/social/providers/linkedin/linkedin.module';
import { GenerationController } from './controllers/generation.controller';
import { LinkedinController } from './controllers/linkedin.controller';
import { WebhookController } from './controllers/webhook.controller';
import { HealthController } from './controllers/health.controller';
import { CacheController } from './controllers/cache.controller';
import { QuotaController } from './controllers/quota.controller';
import { SubscriptionController } from './controllers/subscription.controller';
import { UsageController } from './controllers/usage.controller';
import { CreditsController } from './controllers/credits.controller';
import { UsageTrackingService } from './services/usage-tracking.service';
import { PublicController } from './controllers/public.controller';
import { ContactController } from './controllers/contact.controller';
import { ContactService } from './services/contact.service';
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
import { AdminOnboardingController } from './controllers/admin-onboarding.controller';
import { PolarController } from './controllers/polar.controller';
import { OutboundWebhooksController } from './controllers/outbound-webhooks.controller';
import { ApiKeysController } from './controllers/api-keys.controller';
import { PostsV1Controller } from './controllers/api-v1/posts.v1.controller';
import { SocialAccountsV1Controller } from './controllers/api-v1/social-accounts.v1.controller';
import { MediaV1Controller } from './controllers/api-v1/media.v1.controller';
import { OpenApiV1Controller } from './controllers/api-v1/openapi.v1.controller';
import { InternalController } from './controllers/internal.controller';
import { CareersController } from './controllers/careers.controller';
import { AdminCareersController } from './controllers/admin-careers.controller';
import { BlogController } from './controllers/blog.controller';
import { AdminBlogController } from './controllers/admin-blog.controller';
import { ContentEngineController } from './controllers/content-engine.controller';
import {
  NewsletterController,
  AdminNewsletterController,
} from './controllers/newsletter.controller';
import { AdminSeoPagesController } from './controllers/admin-seo-pages.controller';
import { AdminSeoAiFillController } from './controllers/admin-seo-ai-fill.controller';
import { AdminAiModelsController } from './controllers/admin-ai-models.controller';
import {
  AdminSeoKeywordsController,
  AdminSeoAssignmentsController,
} from './controllers/admin-seo-keywords.controller';
import { ContentEngineService } from './services/content-engine.service';
import { ListmonkService } from './services/listmonk.service';
import { NewsletterService } from './services/newsletter.service';
import { PlatformPublishersService } from './services/platform-publishers.service';
import { SeoKeywordsService } from './services/seo-keywords.service';
import {
  ReferralController,
  PublicReferralController,
} from './controllers/referral.controller';
import { AdminReferralController } from './controllers/admin-referral.controller';
import { AdminMediaController } from './controllers/admin-media.controller';
import { AdminSubscriptionPlansController } from './controllers/admin-subscription-plans.controller';
import { PublicSiteContentController } from './controllers/public-site-content.controller';
import { AdminSiteContentController } from './controllers/admin-site-content.controller';
import { SiteContentService } from './services/site-content.service';
import { AdminDiscountCodesController } from './controllers/admin-discount-codes.controller';
import { AdminCurrencyController } from './controllers/admin-currency.controller';
import { AdminLaunchPricingController } from './controllers/admin-launch-pricing.controller';
import { PublicLaunchPricingController } from './controllers/public-launch-pricing.controller';
import { AdminPaymentGatewayController } from './controllers/admin-payment-gateway.controller';
import { DiscountCodesService } from './services/discount-codes.service';
import { CurrencyService } from './services/currency.service';
import { LaunchPricingService } from './services/launch-pricing.service';
import { FeedbackController } from './controllers/feedback.controller';
import { BrandProfilesController } from './controllers/brand-profiles.controller';
import { UserFeedbackController } from './controllers/user-feedback.controller';
import { PlatformAdminFeedbackController } from './controllers/platform-admin-feedback.controller';
import { PlatformAdminUserFeedbackController } from './controllers/platform-admin-user-feedback.controller';
import { PlatformAccessController } from './controllers/platform-access.controller';
import { PlatformGrantsController } from './controllers/platform-grants.controller';
import { PlatformUsersController } from './controllers/platform-users.controller';
import { ModerationController } from './controllers/moderation.controller';
import {
  MaintenanceController,
  AdminMaintenanceController,
} from './controllers/maintenance.controller';
import { MaintenanceService } from './services/maintenance.service';
import { AppSettingsService } from './services/app-settings.service';
import { ExchangeRateService } from './services/exchange-rate.service';
import { ExchangeRateCronService } from './cron/exchange-rate.cron';
import { MissedPostSweeperCronService } from './cron/missed-post-sweeper.cron';
import { PostEngagementSyncCronService } from './cron/post-engagement-sync.cron';

import { SupabaseService } from './services/supabase.service';
import { GenerationService } from './services/generation.service';
import { LinkedinService } from './services/linkedin.service';
import { N8nService } from './services/n8n.service';
import { CacheService } from './services/cache.service';
import { QuotaService } from './services/quota.service';
import { CreditBucketService } from './services/credit-bucket.service';
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
import { PolarService } from './services/polar.service';
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
import { SeoAiFillService } from './services/seo-ai-fill.service';
import { BlogService } from './services/blog.service';
import { BlogManagementGuard } from './guards/blog-management.guard';
import { FeedbackService } from './services/feedback.service';
import { BrandProfilesService } from './services/brand-profiles.service';
import { BrandKitExtractionService } from './services/brand-kit-extraction.service';
import { BrandVisionAnalysisService } from './services/brand-vision-analysis.service';
import { AiModelRegistryService } from './services/ai-model-registry.service';
import { AiGatewayService } from './services/ai-gateway.service';
import { WebResearchService } from './services/web-research.service';
import { UserFeedbackService } from './services/user-feedback.service';
import { PlatformAccessService } from './services/platform-access.service';
import { ReferralService } from './services/referral.service';
import { FeedbackQueueBootstrapService } from './services/feedback-queue-bootstrap.service';
import { OutboundWebhookService } from './services/outbound-webhook.service';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import { WebhookDispatcherService } from './services/webhook-dispatcher.service';
import { WebhookDeliveryProcessor } from './processors/webhook-delivery.processor';
import { ApiKeyService } from './services/api-key.service';
import { ApiKeyAuthGuard } from './guards/api-key-auth.guard';
import { ApiV1PostsService } from './services/api-v1-posts.service';
import { PlatformStaffGuard } from './guards/platform-staff.guard';
import { ModerationGuard } from './guards/moderation.guard';
import { ModerationService } from './modules/moderation/moderation.service';
import { CreditPreflightGuard } from './guards/credit-preflight.guard';
import { CustomTopicCreditService } from './modules/credits/custom-topic-credit.service';

import { ProfileRepository } from './repositories/profile.repository';
import { OptionalAuthGuard } from './guards/optional-auth.guard';
import { GenerationJobRepository } from './repositories/generation-job.repository';
import { GeneratedContentRepository } from './repositories/generated-content.repository';
import { UserPublishedPostRepository } from './repositories/user-published-post.repository';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { PostStyleLearningService } from './modules/post-ai/post-style-learning.service';
import { PromptFormatterService } from './modules/post-ai/prompt-formatter.service';

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
import { SocialChannelGuard } from './guards/social-channel.guard';
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
      name: QUEUE_NAMES.SOCIAL_PUBLISH,
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
    BullModule.registerQueue({
      name: QUEUE_NAMES.WEBHOOK_DELIVERY,
    }),
    ScheduleModule.forRoot(),
    // Sprint 1.3/1.4 social provider engine. Self-registers the LinkedIn
    // provider into the registry on boot and exports the connection bridge so
    // LinkedinController can dual-write into the new social_accounts + Vault
    // model (gated by FEATURE_SOCIAL_PROVIDER_V2).
    LinkedinModule,
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
    UsageController,
    CreditsController,
    PublicController,
    ContactController,
    PublicSiteContentController,
    AdminSiteContentController,
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
    AdminOnboardingController,
    InternalController,
    CareersController,
    AdminCareersController,
    BlogController,
    AdminBlogController,
    ContentEngineController,
    NewsletterController,
    AdminNewsletterController,
    AdminSeoPagesController,
    AdminSeoAiFillController,
    AdminAiModelsController,
    AdminSeoKeywordsController,
    AdminSeoAssignmentsController,
    FeedbackController,
    BrandProfilesController,
    UserFeedbackController,
    PlatformAdminFeedbackController,
    PlatformAdminUserFeedbackController,
    PlatformAccessController,
    PlatformGrantsController,
    PlatformUsersController,
    ModerationController,
    MaintenanceController,
    AdminMaintenanceController,
    ReferralController,
    PublicReferralController,
    PublicLaunchPricingController,
    AdminReferralController,
    AdminMediaController,
    AdminSubscriptionPlansController,
    AdminDiscountCodesController,
    AdminLaunchPricingController,
    AdminCurrencyController,
    AdminPaymentGatewayController,
    PolarController,
    OutboundWebhooksController,
    ApiKeysController,
    PostsV1Controller,
    SocialAccountsV1Controller,
    MediaV1Controller,
    OpenApiV1Controller,
  ],
  providers: [
    AppService,
    SupabaseService,
    GenerationService,
    LinkedinService,
    N8nService,
    CacheService,
    QuotaService,
    CreditBucketService,
    SubscriptionService,
    SiteContentService,
    ContactService,
    UsageTrackingService,
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
    PolarService,
    DiscountCodesService,
    LaunchPricingService,
    IdempotencyService,
    TrendingTagsService,
    TrendingHashtagEngineService,
    TrendingHashtagOrchestratorService,
    BrowserPoolService,
    ScraperCredentialsService,
    PostRefinementService,
    CareersService,
    CareersJobCopyAiService,
    SeoAiFillService,
    BlogService,
    ContentEngineService,
    ListmonkService,
    NewsletterService,
    PlatformPublishersService,
    SeoKeywordsService,
    BlogManagementGuard,
    FeedbackService,
    BrandProfilesService,
    BrandKitExtractionService,
    BrandVisionAnalysisService,
    AiModelRegistryService,
    AiGatewayService,
    WebResearchService,
    UserFeedbackService,
    PlatformAccessService,
    ReferralService,
    PlatformStaffGuard,
    FeedbackQueueBootstrapService,
    OutboundWebhookService,
    WebhookDeliveryService,
    WebhookDispatcherService,
    WebhookDeliveryProcessor,
    ApiKeyService,
    ApiKeyAuthGuard,
    ApiV1PostsService,
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
    UserPublishedPostRepository,
    PostStyleLearningService,
    PromptFormatterService,
    SubscriptionRepository,
    GenerationWorker,
    GenerationWorkerManager,
    MediaCarouselWorker,
    PostPublishingProcessor,
    TrendingHashtagProcessor,
    RateLimitMiddleware,
    UserRateLimitGuard,
    PaywallGuard,
    SocialChannelGuard,
    CreditPreflightGuard,
    ModerationGuard,
    ModerationService,
    CustomTopicCreditService,
    Reflector,
    CustomTopicGenerationService,
    CarouselTrainingCaptureService,
    OpenAIRateLimiterService,
    MaintenanceService,
    AppSettingsService,
    CurrencyService,
    ExchangeRateService,
    ExchangeRateCronService,
    MissedPostSweeperCronService,
    PostEngagementSyncCronService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RateLimitMiddleware).forRoutes('*'); // Apply to all routes
  }
}
