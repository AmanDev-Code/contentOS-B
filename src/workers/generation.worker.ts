import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { N8nService } from '../services/n8n.service';
import { GenerationJobRepository } from '../repositories/generation-job.repository';
import { GeneratedContentRepository } from '../repositories/generated-content.repository';
import { QuotaService } from '../services/quota.service';
import { NotificationService } from '../services/notification.service';
import { CustomTopicGenerationService } from '../modules/post-ai/custom-topic-generation.service';
import { CustomTopicCreditService } from '../modules/credits/custom-topic-credit.service';
import { MinioService } from '../services/minio.service';
import { MediaGenerationService } from '../services/media-generation.service';
import { CarouselTrainingCaptureService } from '../services/carousel-training-capture.service';
import { OffTopicError } from '../modules/post-ai/errors';
import { CreditSlice } from '../modules/credits/pricing';
import { QUEUE_NAMES, JOB_STAGES } from '../common/constants';
import { JobStatus } from '../common/types';
import {
  inferCarouselVisualStyleFromTopic,
  type CarouselVisualStyle,
} from '../modules/post-ai/carousel-visual-style';
import type {
  CarouselDocumentTheme,
  CarouselSlideOutput,
  TocEntry,
} from '../modules/post-ai/custom-topic.schemas';

const CUSTOM_TOPIC_MEDIA_CONCURRENCY = 3;

/**
 * Bounded parallelism for OpenAI + MinIO work (avoids thundering herd).
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  const pool = Math.max(1, Math.min(concurrency, items.length));

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) break;
      try {
        const value = await fn(items[i], i);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: pool }, () => worker()));
  return results;
}

@Processor(QUEUE_NAMES.CONTENT_GENERATION)
export class GenerationWorker extends WorkerHost {
  private readonly logger = new Logger(GenerationWorker.name);

  constructor(
    private configService: ConfigService,
    private n8nService: N8nService,
    private generationJobRepository: GenerationJobRepository,
    private generatedContentRepository: GeneratedContentRepository,
    private quotaService: QuotaService,
    private notificationService: NotificationService,
    private customTopicGenerationService: CustomTopicGenerationService,
    private customTopicCreditService: CustomTopicCreditService,
    private minioService: MinioService,
    private mediaGenerationService: MediaGenerationService,
    private carouselTrainingCaptureService: CarouselTrainingCaptureService,
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    const { jobId, userId, preferences } = job.data;

    if (preferences?.jobType === 'custom_topic') {
      return this.processCustomTopic(job);
    }

    if (job.name === 'regenerate-carousel') {
      return this.processCarouselRegeneration(job);
    }

    if (job.name === 'regenerate-images') {
      return this.processImageRegeneration(job);
    }

    if (job.name === 'regenerate-image') {
      return this.processSingleImageRegeneration(job);
    }

    if (job.name === 'regenerate-carousel-full') {
      return this.processFullCarouselRegeneration(job);
    }

    this.logger.log(`Processing generation job ${jobId} for user ${userId}`);

    try {
      await this.generationJobRepository.updateStatus(
        jobId,
        JobStatus.GENERATING,
        10,
        JOB_STAGES.TOPIC_DISCOVERY,
      );

      await job.updateProgress(10);

      // Build callback URL for n8n to call when job completes
      const baseUrl =
        this.configService.get<string>('app.baseUrl') ||
        'http://localhost:3000';
      const webhookSecret = this.configService.get<string>('n8n.webhookSecret') || '';
      const callbackQuery = new URLSearchParams({ jobId });
      if (webhookSecret) {
        callbackQuery.set('secret', webhookSecret);
      }
      const callbackUrl = `${baseUrl}/webhook/n8n-callback?${callbackQuery.toString()}`;

      const carouselUrl =
        this.configService.get<string>('n8n.carouselWebhookUrl') || '';
      const ct = preferences?.contentType as string | undefined;
      const useCarousel = ct === 'carousel' && carouselUrl.length > 0;

      this.logger.log(
        `n8n route: contentType=${String(ct)} jobType=${String(preferences?.jobType)} ` +
          `→ ${useCarousel ? `carousel webhook (${carouselUrl})` : `default webhook`}`,
      );

      await this.n8nService.triggerContentGeneration(
        {
          jobId,
          userId,
          callbackUrl,
          callback_url: callbackUrl,
          callbackURL: callbackUrl,
          webhookCallbackUrl: callbackUrl,
          preferences,
        },
        useCarousel ? { webhookUrlOverride: carouselUrl } : undefined,
      );

      await this.generationJobRepository.updateStatus(
        jobId,
        JobStatus.GENERATING,
        30,
        JOB_STAGES.CONTENT_GENERATION,
      );

      await job.updateProgress(30);

      this.logger.log(
        `n8n webhook triggered for job ${jobId}, waiting for completion...`,
      );

      // Wait for n8n to complete by polling the database
      // n8n will call our webhook which updates the job status
      const maxWaitTime = Number(
        this.configService.get<string>('n8n.workflowTimeoutMs') || '300000',
      );
      const pollInterval = 2000; // Check every 2 seconds
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));

        // Check if job status was updated by webhook
        const currentJob = await this.generationJobRepository.findById(jobId);

        if (!currentJob) {
          throw new Error('Job not found in database');
        }

        // Check if n8n completed (webhook was called)
        if (currentJob.status === JobStatus.READY) {
          this.logger.log(`✅ Job ${jobId} completed successfully by n8n`);

          // LOG SUCCESSFUL CREDIT TRANSACTION
          try {
            await this.quotaService.logTransaction(
              userId,
              currentJob.contentId || null,
              'debit',
              0, // No additional charge, already deducted
              'Content generated successfully (1.5 credits total)',
              'generation',
              'text',
            );
            this.logger.log(
              `Logged successful generation transaction for user ${userId}`,
            );
          } catch (logError) {
            this.logger.error(
              `Failed to log transaction for user ${userId}: ${logError.message}`,
            );
          }

          // SEND GENERATION SUCCESS NOTIFICATION
          try {
            if (currentJob.contentId) {
              // Get content title from database
              const content = await this.generatedContentRepository.findById(
                currentJob.contentId,
              );
              const contentTitle = content?.title || 'Your content';
              await this.notificationService.notifyGenerationComplete(
                userId,
                currentJob.contentId,
                contentTitle,
              );
              this.logger.log(
                `Sent generation success notification to user ${userId}`,
              );
            }
          } catch (notificationError) {
            this.logger.error(
              `Failed to send generation success notification: ${notificationError.message}`,
            );
          }

          await job.updateProgress(100);
          return {
            success: true,
            jobId,
            contentId: currentJob.contentId,
            message: 'Content generated successfully',
          };
        }

        if (currentJob.status === JobStatus.FAILED) {
          this.logger.error(
            `❌ Job ${jobId} failed in n8n: ${currentJob.error}`,
          );
          throw new Error(currentJob.error || 'n8n workflow failed');
        }

        // Update progress if changed
        if (currentJob.progress > 30) {
          await job.updateProgress(currentJob.progress);
        }

        this.logger.log(
          `⏳ Job ${jobId} still processing... (${currentJob.progress}%)`,
        );
      }

      // Timeout - n8n didn't respond
      // Final status check before failing on timeout to avoid race with delayed callback.
      const finalJob = await this.generationJobRepository.findById(jobId);
      if (finalJob?.status === JobStatus.READY) {
        await job.updateProgress(100);
        return {
          success: true,
          jobId,
          contentId: finalJob.contentId,
          message: 'Content generated successfully',
        };
      }

      this.logger.error(`⏰ Job ${jobId} timed out waiting for n8n`);
      await this.generationJobRepository.updateError(
        jobId,
        `n8n workflow timeout - no response after ${Math.round(maxWaitTime / 1000)} seconds`,
        0,
      );

      throw new Error('n8n workflow timeout');
    } catch (error) {
      this.logger.error(
        `Failed to process generation job ${jobId}: ${error.message}`,
      );

      // REFUND CREDITS for failed generation
      try {
        await this.quotaService.consumeCredits(
          userId,
          -1.5, // Refund 1.5 credits
          'Refund for failed content generation (1.5 credits)',
          'refund',
          'text',
        );
        this.logger.log(
          `Refunded 1.5 credits to user ${userId} for failed job ${jobId}`,
        );
      } catch (refundError) {
        this.logger.error(
          `Failed to refund credits for user ${userId}: ${refundError.message}`,
        );
      }

      // SEND GENERATION FAILURE NOTIFICATION
      try {
        await this.notificationService.notifyGenerationFailed(
          userId,
          jobId,
          error.message,
          1.5,
        );
        this.logger.log(
          `Sent generation failure notification to user ${userId}`,
        );
      } catch (notificationError) {
        this.logger.error(
          `Failed to send generation failure notification: ${notificationError.message}`,
        );
      }

      // Mark job as failed in database
      await this.generationJobRepository.updateError(
        jobId,
        error.message,
        0, // No auto-retry
      );

      // Don't throw error to prevent BullMQ from retrying
      // User must manually retry via UI
      this.logger.log(
        `Job ${jobId} marked as failed. User can manually retry from UI.`,
      );

      return {
        success: false,
        jobId,
        error: error.message,
        message: 'Job failed. Manual retry required.',
      };
    }
  }

  /**
   * Public entry point so `GenerationWorkerManager` (which consumes the per-user
   * dynamic queue `content-generation-{userId}`) can delegate custom-topic jobs here.
   * Without this delegation, custom-topic jobs would be sent to n8n, which has no
   * matching workflow and would silently time out.
   */
  async processCustomTopic(job: Job): Promise<any> {
    const { jobId, userId, preferences } = job.data;
    const creditSlices: CreditSlice[] = preferences.creditSlices ?? [];
    const contentType: string = preferences.contentType ?? 'text';

    this.logger.log(
      `Processing custom-topic job ${jobId} for user=${userId} type=${contentType}`,
    );

    const emitProgress = (
      subtaskKey: string,
      status: 'queued' | 'running' | 'succeeded' | 'failed',
      percent?: number,
      meta?: Record<string, unknown>,
    ) => {
      this.logger.log(
        `[Worker] emitProgress: job=${jobId} step=${subtaskKey} status=${status}`,
      );
      this.notificationService.emitGenerationProgress(userId, {
        generationId: jobId,
        subtaskKey,
        status,
        percent,
        meta,
      });
    };

    try {
      emitProgress('validating', 'running', 5);
      await this.generationJobRepository.updateStatus(jobId, JobStatus.GENERATING, 10, 'Validating topic');
      await job.updateProgress(10);
      emitProgress('validating', 'succeeded', 8);

      emitProgress('reserving_credits', 'running', 10);
      emitProgress('reserving_credits', 'succeeded', 15);

      emitProgress('generating_text', 'running', 20);
      await this.generationJobRepository.updateStatus(jobId, JobStatus.GENERATING, 25, 'Generating text');
      await job.updateProgress(25);

      if (preferences.contentType === 'carousel' && preferences.trainingDataCaptureOptIn) {
        await this.carouselTrainingCaptureService.record({
          userId,
          generationJobId: jobId,
          consentOptIn: true,
          eventType: 'custom_topic_carousel_started',
          payload: {
            topicPreview: String(preferences.topic || ''),
            slideCount: preferences.slideCount,
            platform: preferences.platform,
            carouselVisualStyle: preferences.carouselVisualStyle ?? 'auto',
            carouselNoteDensity: preferences.carouselNoteDensity ?? null,
            carouselSubjectMode: preferences.carouselSubjectMode ?? 'auto',
            contentType: preferences.contentType,
          },
        });
      }

      // Set user context for rate limiting on media generation
      this.mediaGenerationService.setCurrentUserId(userId);

      // Track whether the lifecycle hooks have already advanced the modal so the
      // post-generate() emits below are idempotent (some recovery paths fire
      // onTextPrimaryReady but never onTextEnhancementComplete if a retry
      // throws — we still need a clean fallback when control returns here).
      let textPrimaryEmitted = false;
      let textEnhancementEmitted = false;

      const result = await this.customTopicGenerationService.generate(
        {
          platform: preferences.platform,
          contentType: preferences.contentType,
          topic: preferences.topic,
          tonality: preferences.tonality,
          wordLimit: preferences.wordLimit,
          imageCount: preferences.imageCount,
          slideCount: preferences.slideCount,
          carouselVisualStyle: preferences.carouselVisualStyle,
          carouselNoteDensity: preferences.carouselNoteDensity,
          carouselSubjectMode: preferences.carouselSubjectMode,
          carouselDocumentMode: preferences.carouselDocumentMode,
          carouselDocumentAuthor: preferences.carouselDocumentAuthor,
          trainingDataCaptureOptIn: preferences.trainingDataCaptureOptIn,
        },
        {
          onTextPrimaryReady: () => {
            if (textPrimaryEmitted) return;
            textPrimaryEmitted = true;
            // Primary LLM JSON parsed — flip Generating-text → succeeded and
            // start Enhancing-and-expanding so the modal moves visibly during
            // the (potentially 30-120s) recovery + moderation phases.
            emitProgress('generating_text', 'succeeded', 40);
            emitProgress('enhancing_text', 'running', 42);
          },
          onCarouselRecoveryStage: (stage, meta) => {
            // Surface recovery stages on the same enhancing_text row so users
            // see continuous movement (improving_slide_density, model_rewrite,
            // post_model_expand, document_deck_quality_issues, etc.) rather
            // than a frozen modal.
            if (!textPrimaryEmitted) {
              textPrimaryEmitted = true;
              emitProgress('generating_text', 'succeeded', 40);
            }
            emitProgress('enhancing_text', 'running', 46, {
              stage,
              ...meta,
            });
            void this.generationJobRepository.updateStatus(
              jobId,
              JobStatus.GENERATING,
              46,
              stage,
            );
          },
          onTextEnhancementComplete: (meta) => {
            if (textEnhancementEmitted) return;
            textEnhancementEmitted = true;
            emitProgress('enhancing_text', 'succeeded', 50, meta);
          },
        },
        userId, // Pass userId for rate limiting
      );

      // Defensive fallbacks: if the service returned without the lifecycle
      // hooks firing (legacy/text mode, or future code paths), still flush the
      // expected step transitions so the FE modal stays in sync.
      if (!textPrimaryEmitted) {
        emitProgress('generating_text', 'succeeded', 40);
        textPrimaryEmitted = true;
      }
      if (!textEnhancementEmitted) {
        emitProgress(
          'enhancing_text',
          'succeeded',
          50,
          result.carouselGenerationMeta
            ? {
                carouselVisualStyle:
                  result.carouselGenerationMeta.resolvedVisualStyle,
                carouselStyleSource: result.carouselGenerationMeta.styleSource,
                carouselNoteDensity: result.carouselGenerationMeta.noteDensity,
                carouselProgrammingSupplement:
                  result.carouselGenerationMeta.programmingModeEffective,
              }
            : undefined,
        );
        textEnhancementEmitted = true;
      }

      // Emit a deterministic "planning slides" phase so the FE step list advances
      // even when the worker is about to start parallel slide rendering. The FE
      // accepts both `composing_pages` (legacy) and `planning_slides` (preferred).
      if (preferences.contentType === 'carousel') {
        emitProgress('planning_slides', 'running', 52);
      }

      if (preferences.contentType === 'carousel' && preferences.trainingDataCaptureOptIn) {
        await this.carouselTrainingCaptureService.record({
          userId,
          generationJobId: jobId,
          consentOptIn: true,
          eventType: 'carousel_plan_ready',
          payload: {
            topicPreview: String(preferences.topic || ''),
            slideCount: preferences.slideCount,
            carouselPlanSummary: result.carouselGenerationMeta?.carouselIntentPlan
              ? {
                  inferredSubject:
                    result.carouselGenerationMeta.carouselIntentPlan.inferredSubject,
                  slideCountPlanned:
                    result.carouselGenerationMeta.carouselIntentPlan.slides.length,
                }
              : {},
            programmingModeEffective:
              result.carouselGenerationMeta?.programmingModeEffective,
            noteDensity: result.carouselGenerationMeta?.noteDensity,
          },
        });
        await this.carouselTrainingCaptureService.record({
          userId,
          generationJobId: jobId,
          consentOptIn: true,
          eventType: 'carousel_text_ready',
          payload: {
            topicPreview: String(preferences.topic || ''),
            slideTitlesSample: ('slides' in result.output
              ? result.output.slides.slice(0, 5).map((s) => s.title)
              : []) as string[],
            slideTotal: ('slides' in result.output ? result.output.slides.length : 0) as number,
            noteDensity: result.carouselGenerationMeta?.noteDensity,
            programmingModeEffective:
              result.carouselGenerationMeta?.programmingModeEffective,
          },
        });
      }
      await this.generationJobRepository.updateStatus(jobId, JobStatus.GENERATING, 50, 'Text generated');
      await job.updateProgress(50);

      let mediaUrls: string[] = [];
      let documentDeckPdfUrl: string | undefined;

      if (contentType === 'image' && 'imagePrompts' in result.output) {
        const imagePrompts = result.output.imagePrompts;
        this.logger.log(
          `Generating ${imagePrompts.length} images (concurrency=${CUSTOM_TOPIC_MEDIA_CONCURRENCY}) for job ${jobId}`,
        );

        const imageResults = await mapWithConcurrency(
          imagePrompts,
          CUSTOM_TOPIC_MEDIA_CONCURRENCY,
          async (prompt, i) => {
            const subtaskKey = `image_${i + 1}`;
            emitProgress(subtaskKey, 'running', 50 + Math.round((i / imagePrompts.length) * 30));
            const buffer = await this.mediaGenerationService.generateSingleImage({
              prompt,
              size: '1024x1024',
              quality: 'medium',
            });
            const url = await this.mediaGenerationService.uploadToMinio(
              buffer,
              `custom-image-${Date.now()}-${i + 1}.png`,
              'image/png',
              userId,
            );
            emitProgress(subtaskKey, 'succeeded', 50 + Math.round(((i + 1) / imagePrompts.length) * 30));
            return url;
          },
        );

        const failedIndices: number[] = [];
        for (let i = 0; i < imageResults.length; i++) {
          const r = imageResults[i];
          if (r.status === 'fulfilled') {
            mediaUrls.push(r.value);
          } else {
            this.logger.error(`Image ${i + 1} generation failed: ${r.reason?.message || r.reason}`);
            emitProgress(`image_${i + 1}`, 'failed');
            failedIndices.push(i + 1);
          }
        }
        if (failedIndices.length > 0) {
          await this.customTopicCreditService.refundImageFail(userId, jobId, failedIndices);
        }
      }

      if (contentType === 'carousel' && 'slides' in result.output) {
        const slides = result.output.slides;

        const docMode = result.carouselGenerationMeta?.documentMode;
        const docTheme: CarouselDocumentTheme | undefined =
          result.carouselGenerationMeta?.documentTheme;
        const usingDocumentDeck =
          (docMode === 'handwritten_notes' || docMode === 'structured_document') &&
          (docTheme === 'notebook' || docTheme === 'clean_document');

        if (usingDocumentDeck) {
          this.logger.log(
            `Rendering document deck (mode=${docMode} theme=${docTheme}) ${slides.length} slides for job ${jobId} — skipping LLM image API.`,
          );
          const tocEntries: TocEntry[] = (result.output as { tocEntries?: TocEntry[] }).tocEntries ?? [];
          const rawAuthor =
            (result.output as { author?: string }).author ||
            result.carouselGenerationMeta?.documentAuthor ||
            undefined;
          const isGenericPlaceholder = /^(your\s*name|author|name|placeholder)$/i.test(
            String(rawAuthor || '').trim(),
          );
          const meta = {
            coverTitle:
              (result.output as { coverTitle?: string }).coverTitle ||
              slides[0]?.title ||
              String(preferences.topic || ''),
            coverSubtitle:
              (result.output as { coverSubtitle?: string }).coverSubtitle || undefined,
            author: isGenericPlaceholder ? 'Trndinn' : rawAuthor,
            brand: 'Trndinn',
          };
          const totalPages = slides.length;
          const docSlideResults = await mapWithConcurrency(
            slides as CarouselSlideOutput[],
            CUSTOM_TOPIC_MEDIA_CONCURRENCY,
            async (slide, i) => {
              const subtaskKey = `slide_${i + 1}`;
              emitProgress(subtaskKey, 'running', 50 + Math.round((i / slides.length) * 30), {
                documentMode: docMode,
                documentTheme: docTheme,
              });
              const buffer = await this.mediaGenerationService.generateDocumentDeckSlide({
                slide,
                pageNumber: slide.pageNumber ?? i + 1,
                totalPages,
                theme: docTheme!,
                meta,
                tocEntries,
              });
              const url = await this.mediaGenerationService.uploadToMinio(
                buffer,
                `custom-doc-slide-${Date.now()}-${i + 1}.jpg`,
                'image/jpeg',
                userId,
              );
              emitProgress(subtaskKey, 'succeeded', 50 + Math.round(((i + 1) / slides.length) * 30), {
                documentMode: docMode,
                documentTheme: docTheme,
              });
              return url;
            },
          );
          const docFailed: number[] = [];
          for (let i = 0; i < docSlideResults.length; i++) {
            const r = docSlideResults[i];
            if (r.status === 'fulfilled') {
              mediaUrls.push(r.value);
            } else {
              this.logger.error(`Document-deck slide ${i + 1} failed: ${r.reason?.message || r.reason}`);
              emitProgress(`slide_${i + 1}`, 'failed');
              docFailed.push(i + 1);
            }
          }
          if (docFailed.length > 0) {
            await this.customTopicCreditService.refundSlideFail(
              userId, jobId, docFailed, true,
            );
          }
          if (
            preferences.trainingDataCaptureOptIn &&
            docFailed.length === 0 &&
            mediaUrls.length === slides.length
          ) {
            await this.carouselTrainingCaptureService.record({
              userId,
              generationJobId: jobId,
              consentOptIn: true,
              eventType: 'carousel_render_complete',
              payload: {
                topicPreview: String(preferences.topic || ''),
                slideCount: slides.length,
                slideTitlesSample: (slides as CarouselSlideOutput[])
                  .slice(0, 5)
                  .map((s) => s.title),
                carouselVisualStyle: result.carouselGenerationMeta?.documentTheme ?? 'document_deck',
                outputMeta: {
                  renderedSlides: mediaUrls.length,
                  documentMode: docMode,
                  documentTheme: docTheme,
                  noteDensity: result.carouselGenerationMeta?.noteDensity,
                },
              },
            });
          }
          // Pre-render PDF so PostModal/ScheduleModal can show "View as PDF" anchor immediately
          // (legacy carousels lazily build PDF on publish in post-scheduling.service.ts).
          if (mediaUrls.length > 0) {
            try {
              const pdfBuffer = await this.mediaGenerationService.createCarouselPdfFromImageUrls(mediaUrls);
              const pdfFileName = `custom-doc-${Date.now()}.pdf`;
              documentDeckPdfUrl = await this.mediaGenerationService.uploadToMinio(
                pdfBuffer,
                pdfFileName,
                'application/pdf',
                userId,
              );
            } catch (e) {
              this.logger.warn(
                `Document deck PDF assembly failed (will rebuild on publish): ${(e as Error).message}`,
              );
            }
          }
          // Skip the legacy carousel render branch entirely for document-deck decks.
          // Continue to the saving phase.
        } else {

        const fallbackStyle: CarouselVisualStyle =
          preferences.carouselVisualStyle &&
          preferences.carouselVisualStyle !== 'auto'
            ? (preferences.carouselVisualStyle as CarouselVisualStyle)
            : inferCarouselVisualStyleFromTopic(String(preferences.topic || '').toLowerCase());

        const visualStyle: CarouselVisualStyle =
          result.carouselGenerationMeta?.resolvedVisualStyle ?? fallbackStyle;

        const nativeHandwritingInImage = Boolean(
          result.carouselGenerationMeta?.nativeHandwritingInImage,
        );

        this.logger.log(
          `Generating ${slides.length} carousel slides (visualStyle=${visualStyle}, concurrency=${CUSTOM_TOPIC_MEDIA_CONCURRENCY}, nativeRasterHandwriting=${nativeHandwritingInImage}) for job ${jobId}`,
        );

        const slideResults = await mapWithConcurrency(
          slides,
          CUSTOM_TOPIC_MEDIA_CONCURRENCY,
          async (slide, i) => {
            const subtaskKey = `slide_${i + 1}`;
            emitProgress(subtaskKey, 'running', 50 + Math.round((i / slides.length) * 30), {
              carouselVisualStyle: visualStyle,
            });

            const handwrittenLike =
              visualStyle === 'handwritten_notebook' ||
              visualStyle === 'handwritten_notebook_dense' ||
              visualStyle === 'whiteboard_notes';

            let buffer: Buffer | undefined;
            let lastErr: Error | undefined;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const gen = await this.mediaGenerationService.generateCustomTopicCarouselSlide(
                  {
                    title: slide.title,
                    body: slide.body,
                    bullets: slide.bullets,
                    denseBullets: slide.denseBullets,
                    codeSnippets: slide.codeSnippets,
                    imagePrompt: slide.imagePrompt,
                    notebookSections: slide.notebookSections,
                    marginNotes: slide.marginNotes,
                  },
                  {
                    visualStyle,
                    strictRetry: attempt > 0,
                    size: '1024x1024',
                    quality: 'medium',
                    noteDensity: result.carouselGenerationMeta?.noteDensity,
                    slideIndex: i,
                    skipTextOverlay: nativeHandwritingInImage,
                  },
                );
                if (handwrittenLike && !gen.overlayApplied && !nativeHandwritingInImage) {
                  throw new Error(
                    'Carousel text overlay pipeline did not complete (notes-style decks require composited typography).',
                  );
                }
                buffer = gen.buffer;
                break;
              } catch (e) {
                lastErr = e instanceof Error ? e : new Error(String(e));
                this.logger.warn(
                  `Slide ${i + 1} render attempt ${attempt + 1} failed: ${lastErr.message}`,
                );
              }
            }

            if (!buffer) {
              throw (
                lastErr ??
                new Error(`Carousel slide ${i + 1} failed after strict regeneration retry`)
              );
            }

            const url = await this.mediaGenerationService.uploadToMinio(
              buffer,
              `custom-slide-${Date.now()}-${i + 1}.jpg`,
              'image/jpeg',
              userId,
            );
            emitProgress(subtaskKey, 'succeeded', 50 + Math.round(((i + 1) / slides.length) * 30), {
              carouselVisualStyle: visualStyle,
            });
            return url;
          },
        );

        const failedSlides: number[] = [];
        for (let i = 0; i < slideResults.length; i++) {
          const r = slideResults[i];
          if (r.status === 'fulfilled') {
            mediaUrls.push(r.value);
          } else {
            this.logger.error(`Slide ${i + 1} generation failed: ${r.reason?.message || r.reason}`);
            emitProgress(`slide_${i + 1}`, 'failed');
            failedSlides.push(i + 1);
          }
        }
        if (failedSlides.length > 0) {
          await this.customTopicCreditService.refundSlideFail(
            userId, jobId, failedSlides, true,
          );
        }
        if (
          preferences.trainingDataCaptureOptIn &&
          failedSlides.length === 0 &&
          mediaUrls.length === slides.length
        ) {
          await this.carouselTrainingCaptureService.record({
            userId,
            generationJobId: jobId,
            consentOptIn: true,
            eventType: 'carousel_render_complete',
            payload: {
              topicPreview: String(preferences.topic || ''),
              slideCount: slides.length,
              carouselVisualStyle: visualStyle,
              outputMeta: {
                renderedSlides: mediaUrls.length,
                noteDensity: result.carouselGenerationMeta?.noteDensity,
              },
            },
          });
        }
        }
      }

      emitProgress('saving', 'running', 85);

      const contentRecord = await this.generatedContentRepository.create(
        userId,
        result.output.caption.slice(0, 100),
        result.output.caption,
        {
          jobId,
          hashtags: result.output.hashtags,
          visualType: contentType !== 'text' ? (contentType as any) : undefined,
          visualUrl: contentType === 'image' && mediaUrls.length > 0 ? mediaUrls[0] : undefined,
          carouselUrls: contentType === 'carousel' && mediaUrls.length > 0 ? mediaUrls : undefined,
          imageUrls: contentType === 'image' && mediaUrls.length > 0 ? mediaUrls : undefined,
          pdfUrl: contentType === 'carousel' ? documentDeckPdfUrl : undefined,
          source: 'custom',
          performancePrediction: {
            customTopicMeta: {
              platform: result.platform,
              contentType: result.contentType,
              tonality: preferences.tonality,
              wordLimit: preferences.wordLimit,
              carouselVisualStyleRequested: preferences.carouselVisualStyle,
              carouselVisualStyleResolved: result.carouselGenerationMeta?.resolvedVisualStyle,
              carouselStyleSource: result.carouselGenerationMeta?.styleSource,
              carouselNoteDensity: result.carouselGenerationMeta?.noteDensity,
              carouselProgrammingModeEffective:
                result.carouselGenerationMeta?.programmingModeEffective,
              carouselDocumentMode: result.carouselGenerationMeta?.documentMode,
              carouselDocumentModeSource: result.carouselGenerationMeta?.documentModeSource,
              carouselDocumentTheme: result.carouselGenerationMeta?.documentTheme,
              trainingDataCaptureOptIn: preferences.trainingDataCaptureOptIn,
              bullets: result.output.bullets,
              cta: result.output.cta,
              imagePrompts: 'imagePrompts' in result.output ? result.output.imagePrompts : undefined,
              slides: 'slides' in result.output ? result.output.slides : undefined,
            },
          },
        },
      );

      emitProgress('saving', 'succeeded', 95);

      await this.generationJobRepository.updateWithContent(
        jobId,
        contentRecord.id,
        JobStatus.READY,
        { message: 'Custom topic generation completed' },
      );

      await job.updateProgress(100);

      this.notificationService.emitGenerationCompleted(userId, {
        generationId: jobId,
        contentId: contentRecord.id,
        contentType: result.contentType,
      });

      await       this.notificationService.notifyGenerationComplete(
        userId,
        contentRecord.id,
        contentRecord.title || 'Custom topic post',
      );

      try {
        const quotaAfter = await this.quotaService.getUserQuota(userId, {
          bypassCache: true,
        });
        const reservedTotal =
          typeof preferences.totalCost === 'number' ? preferences.totalCost : 0;
        this.logger.log(
          `Custom-topic job ${jobId} succeeded contentType=${contentType} reservedTotal=${reservedTotal} remainingCredits=${quotaAfter.remainingCredits}`,
        );
      } catch (e) {
        this.logger.warn(`Post-success quota log failed for ${jobId}: ${(e as Error).message}`);
      }

      emitProgress('done', 'succeeded', 100);

      return {
        success: true,
        jobId,
        contentId: contentRecord.id,
        message: 'Custom topic generation completed',
      };

    } catch (error) {
      const err = error as Error;
      this.logger.error(`Custom-topic job ${jobId} failed: ${err.message}`);

      emitProgress('error', 'failed');

      if (err instanceof OffTopicError) {
        await this.customTopicCreditService.refundAllSlices(userId, jobId, creditSlices);
      } else {
        await this.customTopicCreditService.refundTextFail(userId, jobId, creditSlices);
      }

      await this.notificationService.notifyGenerationFailed(
        userId, jobId, err.message,
        creditSlices.reduce((sum, s) => sum + s.credits, 0),
      );

      await this.generationJobRepository.updateError(jobId, err.message, 0);

      return {
        success: false,
        jobId,
        error: err.message,
        message: 'Custom topic generation failed.',
      };
    }
  }

  async processCarouselRegeneration(job: Job): Promise<any> {
    const {
      jobId,
      userId,
      originalContentId,
      slides,
      carouselVisualStyle,
      carouselNoteDensity,
      carouselDocumentMode,
      carouselDocumentTheme,
      creditSlices,
      totalCost,
    } = job.data;

    this.logger.log(`Processing carousel regeneration job ${jobId} for content ${originalContentId}`);

    const emitProgress = (
      subtaskKey: string,
      status: 'running' | 'succeeded' | 'failed',
      percent?: number,
      meta?: Record<string, unknown>,
    ) => {
      this.notificationService.emitGenerationProgress(userId, {
        generationId: jobId,
        subtaskKey,
        status,
        percent,
        meta,
      });
    };

    try {
      // Set user context for rate limiting
      this.mediaGenerationService.setCurrentUserId(userId);

      await this.generationJobRepository.updateStatus(jobId, JobStatus.GENERATING, 10, 'Starting carousel regeneration');
      await job.updateProgress(10);

      emitProgress('regenerating', 'running', 15);

      const mediaUrls: string[] = [];
      const usingDocumentDeck =
        (carouselDocumentMode === 'handwritten_notes' || carouselDocumentMode === 'structured_document') &&
        (carouselDocumentTheme === 'notebook' || carouselDocumentTheme === 'clean_document');

      if (usingDocumentDeck) {
        const tocEntries: TocEntry[] = [];
        const meta = {
          coverTitle: slides[0]?.title || 'Study Notes',
          coverSubtitle: undefined,
          author: undefined,
          brand: 'Trndinn',
        };
        const totalPages = slides.length;

        const docSlideResults = await mapWithConcurrency(
          slides as CarouselSlideOutput[],
          CUSTOM_TOPIC_MEDIA_CONCURRENCY,
          async (slide, i) => {
            const subtaskKey = `slide_${i + 1}`;
            emitProgress(subtaskKey, 'running', 20 + Math.round((i / slides.length) * 60));
            const buffer = await this.mediaGenerationService.generateDocumentDeckSlide({
              slide,
              pageNumber: slide.pageNumber ?? i + 1,
              totalPages,
              theme: carouselDocumentTheme!,
              meta,
              tocEntries,
            });
            const url = await this.mediaGenerationService.uploadToMinio(
              buffer,
              `regen-doc-slide-${Date.now()}-${i + 1}.jpg`,
              'image/jpeg',
              userId,
            );
            emitProgress(subtaskKey, 'succeeded', 20 + Math.round(((i + 1) / slides.length) * 60));
            return url;
          },
        );

        for (let i = 0; i < docSlideResults.length; i++) {
          const r = docSlideResults[i];
          if (r.status === 'fulfilled') {
            mediaUrls.push(r.value);
          } else {
            this.logger.error(`Regeneration slide ${i + 1} failed: ${r.reason?.message || r.reason}`);
            emitProgress(`slide_${i + 1}`, 'failed');
          }
        }
      } else {
        const slideResults = await mapWithConcurrency(
          slides,
          CUSTOM_TOPIC_MEDIA_CONCURRENCY,
          async (slide: any, i: number) => {
            const subtaskKey = `slide_${i + 1}`;
            emitProgress(subtaskKey, 'running', 20 + Math.round((i / slides.length) * 60));
            const { buffer } = await this.mediaGenerationService.generateCustomTopicCarouselSlide(
              {
                title: slide.title || '',
                body: slide.body || '',
                bullets: slide.bullets,
                denseBullets: slide.denseBullets,
                codeSnippets: slide.codeSnippets,
                notebookSections: slide.notebookSections,
                marginNotes: slide.marginNotes,
                imagePrompt: slide.imagePrompt || slide.title || '',
              },
              {
                visualStyle: carouselVisualStyle as CarouselVisualStyle,
                noteDensity: carouselNoteDensity,
                slideIndex: i,
              },
            );
            const url = await this.mediaGenerationService.uploadToMinio(
              buffer,
              `regen-slide-${Date.now()}-${i + 1}.jpg`,
              'image/jpeg',
              userId,
            );
            emitProgress(subtaskKey, 'succeeded', 20 + Math.round(((i + 1) / slides.length) * 60));
            return url;
          },
        );

        for (let i = 0; i < slideResults.length; i++) {
          const r = slideResults[i];
          if (r.status === 'fulfilled') {
            mediaUrls.push(r.value);
          } else {
            this.logger.error(`Regeneration slide ${i + 1} failed: ${r.reason?.message || r.reason}`);
            emitProgress(`slide_${i + 1}`, 'failed');
          }
        }
      }

      if (mediaUrls.length === 0) {
        throw new Error('All slides failed to regenerate');
      }

      emitProgress('saving', 'running', 85);

      let pdfUrl: string | undefined;
      if (mediaUrls.length > 0) {
        try {
          const pdfBuffer = await this.mediaGenerationService.createCarouselPdfFromImageUrls(mediaUrls);
          pdfUrl = await this.mediaGenerationService.uploadToMinio(
            pdfBuffer,
            `regen-carousel-${Date.now()}.pdf`,
            'application/pdf',
            userId,
          );
        } catch (pdfErr) {
          this.logger.warn(`PDF generation failed during regeneration: ${(pdfErr as Error).message}`);
        }
      }

      await this.generatedContentRepository.updateContent(originalContentId, {
        carousel_urls: mediaUrls,
        pdf_url: pdfUrl,
      });

      emitProgress('saving', 'succeeded', 95);

      await this.generationJobRepository.updateWithContent(
        jobId,
        originalContentId,
        JobStatus.READY,
        { message: 'Carousel regeneration completed' },
      );

      await job.updateProgress(100);

      this.notificationService.emitGenerationCompleted(userId, {
        generationId: jobId,
        contentId: originalContentId,
        contentType: 'carousel',
        regenerated: true,
      });

      emitProgress('done', 'succeeded', 100);

      return {
        success: true,
        jobId,
        contentId: originalContentId,
        message: 'Carousel regeneration completed',
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Carousel regeneration job ${jobId} failed: ${err.message}`);

      emitProgress('error', 'failed');

      await this.customTopicCreditService.refundAllSlices(userId, jobId, creditSlices);

      await this.notificationService.notifyGenerationFailed(
        userId, jobId, err.message, totalCost,
      );

      await this.generationJobRepository.updateError(jobId, err.message, 0);

      return {
        success: false,
        jobId,
        error: err.message,
        message: 'Carousel regeneration failed.',
      };
    }
  }

  async processImageRegeneration(job: Job): Promise<any> {
    const {
      jobId,
      userId,
      originalContentId,
      imagePrompts,
      creditSlices,
      totalCost,
    } = job.data;

    this.logger.log(`Processing image regeneration job ${jobId} for content ${originalContentId}`);

    const emitProgress = (
      subtaskKey: string,
      status: 'running' | 'succeeded' | 'failed',
      percent?: number,
    ) => {
      this.notificationService.emitGenerationProgress(userId, {
        generationId: jobId,
        subtaskKey,
        status,
        percent,
      });
    };

    try {
      // Set user context for rate limiting
      this.mediaGenerationService.setCurrentUserId(userId);

      await this.generationJobRepository.updateStatus(jobId, JobStatus.GENERATING, 10, 'Starting image regeneration');
      await job.updateProgress(10);

      emitProgress('regenerating', 'running', 15);

      const mediaUrls: string[] = [];

      const imageResults = await mapWithConcurrency(
        imagePrompts,
        CUSTOM_TOPIC_MEDIA_CONCURRENCY,
        async (prompt: string, i: number) => {
          const subtaskKey = `image_${i + 1}`;
          emitProgress(subtaskKey, 'running', 20 + Math.round((i / imagePrompts.length) * 60));
          const buffer = await this.mediaGenerationService.generateSingleImage({
            prompt,
            size: '1024x1024',
            quality: 'medium',
          });
          const url = await this.mediaGenerationService.uploadToMinio(
            buffer,
            `regen-image-${Date.now()}-${i + 1}.png`,
            'image/png',
            userId,
          );
          emitProgress(subtaskKey, 'succeeded', 20 + Math.round(((i + 1) / imagePrompts.length) * 60));
          return url;
        },
      );

      for (let i = 0; i < imageResults.length; i++) {
        const r = imageResults[i];
        if (r.status === 'fulfilled') {
          mediaUrls.push(r.value);
        } else {
          this.logger.error(`Regeneration image ${i + 1} failed: ${r.reason?.message || r.reason}`);
          emitProgress(`image_${i + 1}`, 'failed');
        }
      }

      if (mediaUrls.length === 0) {
        throw new Error('All images failed to regenerate');
      }

      emitProgress('saving', 'running', 85);

      await this.generatedContentRepository.updateContent(originalContentId, {
        image_urls: mediaUrls,
        visual_url: mediaUrls[0],
      });

      emitProgress('saving', 'succeeded', 95);

      await this.generationJobRepository.updateWithContent(
        jobId,
        originalContentId,
        JobStatus.READY,
        { message: 'Image regeneration completed' },
      );

      await job.updateProgress(100);

      this.notificationService.emitGenerationCompleted(userId, {
        generationId: jobId,
        contentId: originalContentId,
        contentType: 'image',
        regenerated: true,
      });

      emitProgress('done', 'succeeded', 100);

      return {
        success: true,
        jobId,
        contentId: originalContentId,
        message: 'Image regeneration completed',
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Image regeneration job ${jobId} failed: ${err.message}`);

      emitProgress('error', 'failed');

      await this.customTopicCreditService.refundAllSlices(userId, jobId, creditSlices);

      await this.notificationService.notifyGenerationFailed(
        userId, jobId, err.message, totalCost,
      );

      await this.generationJobRepository.updateError(jobId, err.message, 0);

      return {
        success: false,
        jobId,
        error: err.message,
        message: 'Image regeneration failed.',
      };
    }
  }

  /**
   * Regenerate a single AI image at `imageIndex` inside an existing content
   * record. Atomic: success commits the credit slice and emits
   * `generation.image_regenerated`; failure refunds the slice via the
   * idempotent `refundOnce` slice helper (no double-refund if the worker is
   * retried by a stalled-job recovery path).
   */
  async processSingleImageRegeneration(job: Job): Promise<any> {
    const {
      jobId,
      userId,
      originalContentId,
      imageIndex,
      prompt,
      creditSlices,
      totalCost,
    } = job.data as {
      jobId: string;
      userId: string;
      originalContentId: string;
      imageIndex: number;
      prompt: string;
      creditSlices: CreditSlice[];
      totalCost: number;
    };

    this.logger.log(
      `Processing single-image regeneration job ${jobId} content=${originalContentId} index=${imageIndex}`,
    );

    const subtaskKey = `image_regen_${imageIndex + 1}`;

    const emitProgress = (
      key: string,
      status: 'running' | 'succeeded' | 'failed',
      percent?: number,
    ) => {
      this.notificationService.emitGenerationProgress(userId, {
        generationId: jobId,
        subtaskKey: key,
        status,
        percent,
      });
    };

    try {
      this.mediaGenerationService.setCurrentUserId(userId);

      await this.generationJobRepository.updateStatus(
        jobId,
        JobStatus.GENERATING,
        10,
        'Starting single-image regeneration',
      );
      await job.updateProgress(10);
      emitProgress(subtaskKey, 'running', 25);

      const buffer = await this.mediaGenerationService.generateSingleImage({
        prompt,
        size: '1024x1024',
        quality: 'medium',
      });
      const newUrl = await this.mediaGenerationService.uploadToMinio(
        buffer,
        `regen-image-${Date.now()}-${imageIndex + 1}.png`,
        'image/png',
        userId,
      );
      emitProgress(subtaskKey, 'succeeded', 80);

      const updated =
        await this.generatedContentRepository.replaceImageUrlAtIndex(
          originalContentId,
          imageIndex,
          newUrl,
        );
      if (!updated) {
        throw new Error('Content not found while persisting regenerated image');
      }

      await this.generationJobRepository.updateWithContent(
        jobId,
        originalContentId,
        JobStatus.READY,
        { message: 'Single image regeneration completed' },
      );
      await job.updateProgress(100);

      this.notificationService.emitImageRegenerated(userId, {
        generationId: jobId,
        contentId: originalContentId,
        imageIndex,
        newImageUrl: newUrl,
      });
      this.notificationService.emitGenerationCompleted(userId, {
        generationId: jobId,
        contentId: originalContentId,
        contentType: 'image',
        regenerated: true,
      });
      emitProgress('done', 'succeeded', 100);

      return {
        success: true,
        jobId,
        contentId: originalContentId,
        imageIndex,
        newImageUrl: newUrl,
        message: 'Single image regeneration completed',
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Single-image regen job ${jobId} failed at index=${imageIndex}: ${err.message}`,
      );
      emitProgress(subtaskKey, 'failed');

      await this.customTopicCreditService.refundAllSlices(
        userId,
        jobId,
        creditSlices,
      );

      await this.notificationService.notifyGenerationFailed(
        userId,
        jobId,
        err.message,
        totalCost,
      );

      await this.generationJobRepository.updateError(jobId, err.message, 0);
      return {
        success: false,
        jobId,
        error: err.message,
        message: 'Single image regeneration failed; credits refunded.',
      };
    }
  }

  /**
   * Regenerate every slide of a carousel from the persisted deck JSON. Emits
   * `generation.carousel_regenerated` on success. Per-slide failures refund
   * only their own slice (granular refund pattern from
   * `customTopicCreditService.refundSlideFail`); total failure refunds all.
   */
  async processFullCarouselRegeneration(job: Job): Promise<any> {
    const {
      jobId,
      userId,
      originalContentId,
      slides,
      carouselVisualStyle,
      carouselNoteDensity,
      carouselDocumentMode,
      carouselDocumentTheme,
      creditSlices,
      totalCost,
    } = job.data as {
      jobId: string;
      userId: string;
      originalContentId: string;
      slides: any[];
      carouselVisualStyle?: string;
      carouselNoteDensity?: string;
      carouselDocumentMode?: string;
      carouselDocumentTheme?: string;
      creditSlices: CreditSlice[];
      totalCost: number;
    };

    this.logger.log(
      `Processing full-carousel regeneration job ${jobId} content=${originalContentId} slides=${slides?.length ?? 0}`,
    );

    const emitProgress = (
      subtaskKey: string,
      status: 'running' | 'succeeded' | 'failed',
      percent?: number,
      meta?: Record<string, unknown>,
    ) => {
      this.notificationService.emitGenerationProgress(userId, {
        generationId: jobId,
        subtaskKey,
        status,
        percent,
        meta,
      });
    };

    try {
      this.mediaGenerationService.setCurrentUserId(userId);
      await this.generationJobRepository.updateStatus(
        jobId,
        JobStatus.GENERATING,
        10,
        'Starting carousel regeneration',
      );
      await job.updateProgress(10);
      emitProgress('regenerating', 'running', 15);

      const usingDocumentDeck =
        (carouselDocumentMode === 'handwritten_notes' ||
          carouselDocumentMode === 'structured_document') &&
        (carouselDocumentTheme === 'notebook' ||
          carouselDocumentTheme === 'clean_document');

      const newUrls: Array<string | null> = new Array(slides.length).fill(null);
      const failedSlideIndices: number[] = [];

      if (usingDocumentDeck) {
        const tocEntries: TocEntry[] = [];
        const meta = {
          coverTitle: slides[0]?.title || 'Study Notes',
          coverSubtitle: undefined,
          author: undefined,
          brand: 'Trndinn',
        };
        const totalPages = slides.length;
        const docResults = await mapWithConcurrency(
          slides as CarouselSlideOutput[],
          CUSTOM_TOPIC_MEDIA_CONCURRENCY,
          async (slide, i) => {
            const subtaskKey = `slide_regen_${i + 1}`;
            emitProgress(
              subtaskKey,
              'running',
              20 + Math.round((i / slides.length) * 60),
            );
            const buffer =
              await this.mediaGenerationService.generateDocumentDeckSlide({
                slide,
                pageNumber: slide.pageNumber ?? i + 1,
                totalPages,
                theme: carouselDocumentTheme as CarouselDocumentTheme,
                meta,
                tocEntries,
              });
            const url = await this.mediaGenerationService.uploadToMinio(
              buffer,
              `regen-doc-slide-${Date.now()}-${i + 1}.jpg`,
              'image/jpeg',
              userId,
            );
            emitProgress(
              subtaskKey,
              'succeeded',
              20 + Math.round(((i + 1) / slides.length) * 60),
            );
            return url;
          },
        );
        for (let i = 0; i < docResults.length; i++) {
          const r = docResults[i];
          if (r.status === 'fulfilled') {
            newUrls[i] = r.value;
          } else {
            this.logger.error(
              `Regen slide ${i + 1} failed: ${r.reason?.message || r.reason}`,
            );
            emitProgress(`slide_regen_${i + 1}`, 'failed');
            failedSlideIndices.push(i + 1);
          }
        }
      } else {
        const visualStyle = (carouselVisualStyle ||
          'handwritten_notebook') as CarouselVisualStyle;
        const slideResults = await mapWithConcurrency(
          slides,
          CUSTOM_TOPIC_MEDIA_CONCURRENCY,
          async (slide: any, i: number) => {
            const subtaskKey = `slide_regen_${i + 1}`;
            emitProgress(
              subtaskKey,
              'running',
              20 + Math.round((i / slides.length) * 60),
              { carouselVisualStyle: visualStyle },
            );
            const { buffer } =
              await this.mediaGenerationService.generateCustomTopicCarouselSlide(
                {
                  title: slide.title || '',
                  body: slide.body || '',
                  bullets: slide.bullets,
                  denseBullets: slide.denseBullets,
                  codeSnippets: slide.codeSnippets,
                  notebookSections: slide.notebookSections,
                  marginNotes: slide.marginNotes,
                  imagePrompt: slide.imagePrompt || slide.title || '',
                },
                {
                  visualStyle,
                  noteDensity: carouselNoteDensity as any,
                  slideIndex: i,
                },
              );
            const url = await this.mediaGenerationService.uploadToMinio(
              buffer,
              `regen-slide-${Date.now()}-${i + 1}.jpg`,
              'image/jpeg',
              userId,
            );
            emitProgress(
              subtaskKey,
              'succeeded',
              20 + Math.round(((i + 1) / slides.length) * 60),
              { carouselVisualStyle: visualStyle },
            );
            return url;
          },
        );
        for (let i = 0; i < slideResults.length; i++) {
          const r = slideResults[i];
          if (r.status === 'fulfilled') {
            newUrls[i] = r.value;
          } else {
            this.logger.error(
              `Regen slide ${i + 1} failed: ${r.reason?.message || r.reason}`,
            );
            emitProgress(`slide_regen_${i + 1}`, 'failed');
            failedSlideIndices.push(i + 1);
          }
        }
      }

      const successfulUrls = newUrls.filter(
        (u): u is string => typeof u === 'string' && u.length > 0,
      );
      if (successfulUrls.length === 0) {
        throw new Error('All slides failed to regenerate');
      }

      // Refund only the failed slide slices — the successful slides commit.
      if (failedSlideIndices.length > 0) {
        for (const idx of failedSlideIndices) {
          const failedSlice = creditSlices.find(
            (s) => s.subtaskKey === `slide_regen_${idx}`,
          );
          if (failedSlice) {
            await this.customTopicCreditService.refundSlice(
              userId,
              jobId,
              failedSlice,
            );
          }
        }
      }

      emitProgress('saving', 'running', 85);

      let pdfUrl: string | undefined;
      try {
        const pdfBuffer =
          await this.mediaGenerationService.createCarouselPdfFromImageUrls(
            successfulUrls,
          );
        pdfUrl = await this.mediaGenerationService.uploadToMinio(
          pdfBuffer,
          `regen-carousel-${Date.now()}.pdf`,
          'application/pdf',
          userId,
        );
      } catch (pdfErr) {
        this.logger.warn(
          `PDF generation failed during regeneration: ${(pdfErr as Error).message}`,
        );
      }

      await this.generatedContentRepository.updateContent(originalContentId, {
        carousel_urls: successfulUrls,
        image_urls: successfulUrls,
        pdf_url: pdfUrl,
      });
      emitProgress('saving', 'succeeded', 95);

      await this.generationJobRepository.updateWithContent(
        jobId,
        originalContentId,
        JobStatus.READY,
        { message: 'Carousel regeneration completed' },
      );
      await job.updateProgress(100);

      this.notificationService.emitCarouselRegenerated(userId, {
        generationId: jobId,
        contentId: originalContentId,
        newImageUrls: successfulUrls,
        newPdfUrl: pdfUrl,
      });
      this.notificationService.emitGenerationCompleted(userId, {
        generationId: jobId,
        contentId: originalContentId,
        contentType: 'carousel',
        regenerated: true,
      });
      emitProgress('done', 'succeeded', 100);

      return {
        success: true,
        jobId,
        contentId: originalContentId,
        newImageUrls: successfulUrls,
        newPdfUrl: pdfUrl,
        failedSlides: failedSlideIndices,
        message: 'Carousel regeneration completed',
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Full-carousel regen job ${jobId} failed: ${err.message}`,
      );
      emitProgress('error', 'failed');

      await this.customTopicCreditService.refundAllSlices(
        userId,
        jobId,
        creditSlices,
      );
      await this.notificationService.notifyGenerationFailed(
        userId,
        jobId,
        err.message,
        totalCost,
      );
      await this.generationJobRepository.updateError(jobId, err.message, 0);
      return {
        success: false,
        jobId,
        error: err.message,
        message: 'Carousel regeneration failed; credits refunded.',
      };
    }
  }
}
