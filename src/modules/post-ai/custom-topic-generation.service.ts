import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import {
  PostGenerationInput,
  PostGenerationInputSchema,
  PostOutput,
  safeParseCustomTopicPostOutput,
  TextPostOutput,
  ImagePostOutput,
  CarouselPostOutput,
  type CarouselNoteDensityLevel,
} from './custom-topic.schemas';
import { resolveWordLimit, countWords } from './word-limit';
import { getTonalityGuide, TonalityGuide } from './tonality';
import {
  buildCustomTopicPrompt,
  type CustomTopicCarouselPromptContext,
} from './prompt-builder';
import { selectHashtags } from './hashtag-selector';
import {
  analyzeCarouselQuality,
  buildCarouselStrictRetryInstruction,
  meetsMinimumShippableCarousel,
  topicRequestsFilledHandwritingNotes,
  educationalNotebookImageNativeMode,
} from './carousel-quality';
import {
  resolveCarouselVisualStyle,
  type CarouselVisualStyle,
  isNotebookPaperCarouselStyle,
} from './carousel-visual-style';
import { resolveCarouselNoteDensity } from './carousel-note-density';
import { expandSparseCarouselSlides } from './carousel-sparse-expansion';
import { resolveCustomTopicTextModel } from './custom-topic-text-model';
import {
  CarouselIntentPlanSchema,
  buildCarouselOutlineSystemPrompt,
  type CarouselIntentPlan,
} from './carousel-intent-plan';
import { effectiveCarouselProgrammingMode } from './carousel-topic-classifier';
import {
  resolveCarouselDocumentMode,
  documentThemeForMode,
  isDocumentDeckPreset,
} from './carousel-document-mode';
import {
  analyzeDocumentDeckQuality,
  buildDocumentDeckStrictRetryInstruction,
} from './document-deck-quality';
import {
  enrichCarouselDeckRichContent,
  scoreCarouselRichness,
} from './carousel-rich-content-enrichment';
import {
  OffTopicError,
  SchemaValidationError,
  ContentTooLongError,
  ProviderError,
  CarouselQualityError,
} from './errors';
import { TrendingHashtagEngineService } from '../../services/trending-hashtag-engine.service';
import { TrendingTagsService } from '../../services/trending-tags.service';
import { ModerationService } from '../moderation/moderation.service';
import { OpenAIRateLimiterService } from '../../services/openai-rate-limiter.service';

export interface CustomTopicResult {
  output: TextPostOutput | ImagePostOutput | CarouselPostOutput;
  platform: string;
  contentType: string;
  carouselGenerationMeta?: {
    resolvedVisualStyle: CarouselVisualStyle;
    styleSource: 'explicit' | 'inferred';
    noteDensity?: CarouselNoteDensityLevel;
    programmingModeEffective?: boolean;
    carouselIntentPlan?: CarouselIntentPlan | null;
    trainingDataCaptureOptIn?: boolean;
    carouselQualityRecoveryStages?: string[];
    /** Raster carries legible handwriting; compositor skips overlay. */
    nativeHandwritingInImage?: boolean;
    /**
     * Document deck preset (educational decks). When set to one of the deterministic
     * presets, the worker uses the document-deck renderer and skips the LLM image API.
     */
    documentMode?: 'none' | 'handwritten_notes' | 'structured_document';
    documentModeSource?: 'explicit' | 'inferred' | 'default';
    documentTheme?: 'notebook' | 'clean_document';
    documentAuthor?: string;
  };
}

export interface CustomTopicGenerateLifecycle {
  /**
   * Emitted during notebook carousel recovery (deterministic expand + optional model pass).
   * Frontend can show `meta.step` or map `stage` to copy (e.g. improving_slide_density).
   */
  onCarouselRecoveryStage?: (
    stage: string,
    meta?: Record<string, unknown>,
  ) => void;
  /**
   * Fired ONCE after the primary LLM JSON parse succeeds (post off-topic + compression
   * but before quality-gate/sparse-expansion/moderation). The worker uses this to flip
   * the user-visible "Generating text" step to succeeded and start the
   * "Enhancing & expanding" step — otherwise the modal appears stuck for the full
   * 30-120s of recovery work on dense educational decks.
   */
  onTextPrimaryReady?: (meta?: Record<string, unknown>) => void;
  /**
   * Fired ONCE after enrichment + quality gates + moderation finish, just before
   * the service returns. The worker uses this to flip "Enhancing & expanding" to
   * succeeded and (for carousel) start "Planning slides".
   */
  onTextEnhancementComplete?: (meta?: Record<string, unknown>) => void;
}

@Injectable()
export class CustomTopicGenerationService {
  private readonly logger = new Logger(CustomTopicGenerationService.name);
  private readonly openaiApiKey: string;
  /** Default OpenAI model for custom-topic JSON (`CUSTOM_TOPIC_MODEL`, fallback gpt-4o). */
  private readonly customTopicModel: string;
  /**
   * Optional stronger model for heavy handwritten/dense carousels (`CUSTOM_TOPIC_CAROUSEL_MODEL`).
   * Same chat-completions API; does not affect image generation.
   */
  private readonly customTopicCarouselModel: string | undefined;

  /** Current user ID for rate limiting (set per-generation) */
  private currentUserId: string = 'anonymous';

  constructor(
    private readonly configService: ConfigService,
    private readonly trendingHashtagService: TrendingHashtagEngineService,
    private readonly trendingTagsService: TrendingTagsService,
    private readonly moderationService: ModerationService,
    private readonly openaiRateLimiter: OpenAIRateLimiterService,
  ) {
    this.openaiApiKey = this.configService.get<string>('OPENAI_API_KEY') || '';
    this.customTopicModel =
      this.configService.get<string>('CUSTOM_TOPIC_MODEL') || 'gpt-4o';
    const carouselOverride = this.configService.get<string>(
      'CUSTOM_TOPIC_CAROUSEL_MODEL',
    );
    this.customTopicCarouselModel = carouselOverride?.trim() || undefined;
  }

  async generate(
    rawInput: PostGenerationInput,
    lifecycle?: CustomTopicGenerateLifecycle,
    userId?: string,
  ): Promise<CustomTopicResult> {
    const input = PostGenerationInputSchema.parse(rawInput);
    this.currentUserId = userId || 'anonymous';

    const carouselStyleResolution =
      input.contentType === 'carousel'
        ? resolveCarouselVisualStyle(
            input.topic,
            input.carouselVisualStyle ?? 'auto',
          )
        : undefined;

    const wordLimit = resolveWordLimit(input.wordLimit);
    const tonalityGuide = getTonalityGuide(input.tonality);

    const noteDensity: CarouselNoteDensityLevel | undefined =
      input.contentType === 'carousel' && carouselStyleResolution
        ? resolveCarouselNoteDensity({
            explicit: input.carouselNoteDensity ?? undefined,
            resolvedVisualStyle: carouselStyleResolution.resolved,
            wordLimitKind: input.wordLimit.kind,
          })
        : undefined;

    const programmingModeEffective =
      input.contentType === 'carousel'
        ? effectiveCarouselProgrammingMode({
            subjectMode: input.carouselSubjectMode ?? 'auto',
            topicLower: input.topic.toLowerCase(),
          })
        : false;

    const nativeHandwritingInImage =
      input.contentType === 'carousel' && carouselStyleResolution
        ? educationalNotebookImageNativeMode({
            tonality: input.tonality,
            topicLower: input.topic.toLowerCase(),
            visualStyle: carouselStyleResolution.resolved,
          })
        : false;

    const documentModeResolution =
      input.contentType === 'carousel'
        ? resolveCarouselDocumentMode({
            topic: input.topic,
            tonality: input.tonality,
            contentType: input.contentType,
            override: input.carouselDocumentMode,
          })
        : { resolved: 'none' as const, source: 'default' as const };

    const documentModeActive = isDocumentDeckPreset(
      documentModeResolution.resolved,
    );
    const documentTheme =
      documentModeActive &&
      (documentModeResolution.resolved === 'handwritten_notes' ||
        documentModeResolution.resolved === 'structured_document')
        ? documentThemeForMode(documentModeResolution.resolved)
        : undefined;

    const textModel = resolveCustomTopicTextModel({
      contentType: input.contentType,
      noteDensity: noteDensity ?? 'standard',
      resolvedVisualStyle: carouselStyleResolution?.resolved,
      slideCount: input.slideCount,
      customTopicModel: this.customTopicModel,
      customTopicCarouselModel: this.customTopicCarouselModel,
    });

    const carouselQualityRecoveryStages: string[] = [];

    let carouselIntentPlan: CarouselIntentPlan | null = null;
    if (
      input.contentType === 'carousel' &&
      input.slideCount &&
      input.slideCount >= 3
    ) {
      carouselIntentPlan = await this.fetchCarouselIntentPlan(
        input.topic,
        input.slideCount,
        textModel,
      );
    }

    const carouselCtx: CustomTopicCarouselPromptContext | null =
      input.contentType === 'carousel' && carouselStyleResolution
        ? {
            resolvedVisualStyle: carouselStyleResolution.resolved,
            noteDensity: noteDensity ?? 'standard',
            programmingSupplement: programmingModeEffective,
            intentPlan: carouselIntentPlan,
            // For document-deck presets the renderer is deterministic; raster handwriting
            // toggle is irrelevant and would mis-shape imagePrompt instructions.
            nativeHandwritingInImage: documentModeActive
              ? false
              : nativeHandwritingInImage,
            documentMode: documentModeActive
              ? (documentModeResolution.resolved as
                  | 'handwritten_notes'
                  | 'structured_document')
              : undefined,
            documentSlideCount: documentModeActive
              ? (input.slideCount ?? undefined)
              : undefined,
            documentAuthor: documentModeActive
              ? input.carouselDocumentAuthor
              : undefined,
          }
        : null;

    const { system, user } = buildCustomTopicPrompt(
      input,
      wordLimit,
      tonalityGuide,
      carouselCtx,
    );

    this.logger.log(
      `Generating custom topic post: platform=${input.platform} type=${input.contentType} tonality=${input.tonality} wordTarget=${wordLimit.target}`,
    );

    const parsed = await this.callAndParse(
      system,
      user,
      input.contentType,
      textModel,
    );

    if ('error' in parsed && parsed.error === 'off_topic') {
      throw new OffTopicError();
    }

    const postOutput = parsed as
      | TextPostOutput
      | ImagePostOutput
      | CarouselPostOutput;

    // Surface "primary text ready" BEFORE compression / quality gate / moderation
    // so the FE modal can flip Generating-text → succeeded and start the
    // Enhancing-and-expanding row. The remaining recovery + moderation phases can
    // take 30-120s for dense educational decks; without this signal the modal
    // appears stuck on "Generating text" for the entire window.
    try {
      lifecycle?.onTextPrimaryReady?.({
        contentType: input.contentType,
        slideCount:
          input.contentType === 'carousel' && 'slides' in postOutput
            ? postOutput.slides?.length
            : undefined,
      });
    } catch {
      // Lifecycle hooks must never break the generation pipeline.
    }

    const captionWordCount = countWords(postOutput.caption);

    if (captionWordCount > wordLimit.hardCap) {
      this.logger.warn(
        `Caption exceeds hard cap: ${captionWordCount}/${wordLimit.hardCap} words. Requesting compression.`,
      );
      const compressed = await this.compressCaption(
        postOutput,
        wordLimit.hardCap,
        system,
        input.contentType,
        textModel,
      );

      if ('error' in compressed && compressed.error === 'off_topic') {
        throw new OffTopicError();
      }

      const compressedOutput = compressed as
        | TextPostOutput
        | ImagePostOutput
        | CarouselPostOutput;
      const recount = countWords(compressedOutput.caption);

      if (recount > wordLimit.hardCap) {
        throw new ContentTooLongError(recount, wordLimit.hardCap);
      }

      Object.assign(postOutput, compressedOutput);
    }

    if (input.contentType === 'carousel') {
      if (documentModeActive) {
        await this.enforceDocumentDeckQualityGate(
          postOutput as CarouselPostOutput,
          input,
          system,
          user,
          documentModeResolution.resolved as
            | 'handwritten_notes'
            | 'structured_document',
          textModel,
          lifecycle,
          carouselQualityRecoveryStages,
        );
      } else {
        await this.enforceCarouselQualityGate(
          postOutput as CarouselPostOutput,
          input,
          system,
          user,
          carouselStyleResolution!.resolved,
          noteDensity ?? 'standard',
          programmingModeEffective,
          textModel,
          lifecycle,
          carouselQualityRecoveryStages,
        );
      }

      // Deterministic rich-content enrichment: harvest codeSnippet / complexity /
      // diagramSpec / tipBoxes from raw bullet text the model already wrote so
      // every body slide has at least one structural visual element. Idempotent;
      // never overwrites fields the model filled itself.
      try {
        const enrichment = enrichCarouselDeckRichContent(
          postOutput as CarouselPostOutput,
          {
            topicLower: input.topic.toLowerCase(),
            documentMode: documentModeActive
              ? (documentModeResolution.resolved as
                  | 'handwritten_notes'
                  | 'structured_document')
              : undefined,
          },
        );
        if (enrichment.slidesEnriched > 0) {
          this.logger.log(
            `Carousel enrichment: ${enrichment.slidesEnriched} slide(s) gained code=${enrichment.fieldsAdded.codeSnippet} complexity=${enrichment.fieldsAdded.complexity} diagram=${enrichment.fieldsAdded.diagramSpec} tip=${enrichment.fieldsAdded.tipBoxes}`,
          );
          carouselQualityRecoveryStages.push('rich_content_enrichment');
        }
        const richness = scoreCarouselRichness(
          postOutput as CarouselPostOutput,
        );
        this.logger.log(
          `Carousel richness score: avg=${richness.averageRichScore.toFixed(2)} bodySlides=${richness.bodySlides}`,
        );
      } catch (e) {
        this.logger.warn(
          `Carousel enrichment skipped: ${(e as Error).message}`,
        );
      }
    }

    const hashtags = await selectHashtags(
      postOutput.keywords,
      input.platform,
      this.trendingHashtagService,
      this.trendingTagsService,
    );
    postOutput.hashtags = hashtags;

    const formatted = this.applyPlatformFormatting(postOutput, input.platform);

    const carouselMetaPack =
      carouselStyleResolution && input.contentType === 'carousel'
        ? {
            resolvedVisualStyle: carouselStyleResolution.resolved,
            styleSource: carouselStyleResolution.source,
            noteDensity: noteDensity ?? 'standard',
            programmingModeEffective,
            carouselIntentPlan,
            trainingDataCaptureOptIn: Boolean(input.trainingDataCaptureOptIn),
            nativeHandwritingInImage: documentModeActive
              ? false
              : nativeHandwritingInImage,
            carouselQualityRecoveryStages:
              carouselQualityRecoveryStages.length > 0
                ? [...carouselQualityRecoveryStages]
                : undefined,
            documentMode: documentModeResolution.resolved,
            documentModeSource: documentModeResolution.source,
            documentTheme,
            documentAuthor: input.carouselDocumentAuthor,
          }
        : undefined;

    const enhancementCompleteMeta = (): Record<string, unknown> => ({
      contentType: input.contentType,
      recoveryStages: [...carouselQualityRecoveryStages],
      carouselVisualStyle: carouselMetaPack?.resolvedVisualStyle,
      carouselStyleSource: carouselMetaPack?.styleSource,
      carouselNoteDensity: carouselMetaPack?.noteDensity,
      carouselProgrammingSupplement: carouselMetaPack?.programmingModeEffective,
      documentMode: carouselMetaPack?.documentMode,
    });

    const safetyCheck = this.moderationService.checkOutputSafety(
      formatted.caption,
    );
    if (!safetyCheck.safe) {
      this.logger.warn(
        `Output safety check failed (${safetyCheck.matches.join(', ')}). Attempting tightened retry.`,
      );
      const retryResult = await this.retryWithSafetyConstraint(
        formatted,
        safetyCheck.matches,
        input,
        wordLimit,
        tonalityGuide,
        carouselCtx,
        textModel,
      );
      if (retryResult) {
        try {
          lifecycle?.onTextEnhancementComplete?.(enhancementCompleteMeta());
        } catch {
          /* never break pipeline on lifecycle errors */
        }
        return {
          output: retryResult,
          platform: input.platform,
          contentType: input.contentType,
          carouselGenerationMeta: carouselMetaPack,
        };
      }
      throw new ProviderError(
        'Generated content failed safety check after retry.',
      );
    }

    try {
      lifecycle?.onTextEnhancementComplete?.(enhancementCompleteMeta());
    } catch {
      /* never break pipeline on lifecycle errors */
    }

    return {
      output: formatted,
      platform: input.platform,
      contentType: input.contentType,
      carouselGenerationMeta: carouselMetaPack,
    };
  }

  private async fetchCarouselIntentPlan(
    topic: string,
    slideCount: number,
    textModel: string,
  ): Promise<CarouselIntentPlan | null> {
    if (!this.openaiApiKey) return null;

    const timeoutMs = 90_000; // 90 seconds for carousel intent plan

    this.logger.log(
      `Queueing carousel intent plan: model=${textModel} slideCount=${slideCount} userId=${this.currentUserId}`,
    );

    try {
      const system = buildCarouselOutlineSystemPrompt(slideCount);
      const user = `Topic: ${topic}`;

      // Use rate limiter with automatic retry
      const result = await this.openaiRateLimiter.executeWithRetry(
        this.currentUserId,
        async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => {
            controller.abort();
            this.logger.warn(
              `Carousel intent plan request timed out after ${timeoutMs / 1000}s`,
            );
          }, timeoutMs);

          const startTime = Date.now();

          try {
            const raw = await axios.post(
              'https://api.openai.com/v1/chat/completions',
              {
                model: textModel,
                messages: [
                  { role: 'system', content: system },
                  { role: 'user', content: user },
                ],
                temperature: 0.35,
                max_tokens: 1200,
                response_format: { type: 'json_object' },
              },
              {
                headers: {
                  Authorization: `Bearer ${this.openaiApiKey}`,
                  'Content-Type': 'application/json',
                },
                timeout: timeoutMs,
                signal: controller.signal,
              },
            );

            clearTimeout(timeoutId);

            const elapsed = Date.now() - startTime;
            this.logger.log(`Carousel intent plan fetched in ${elapsed}ms`);

            return raw.data;
          } catch (error) {
            clearTimeout(timeoutId);
            throw error;
          }
        },
        `carousel-intent-plan:${textModel}`,
      );

      const content = result?.choices?.[0]?.message?.content;
      if (!content) return null;
      const parsed = JSON.parse(content);
      const z = CarouselIntentPlanSchema.safeParse(parsed);
      if (!z.success) return null;
      if (z.data.slides.length !== slideCount) {
        this.logger.warn(
          `Carousel plan slide count mismatch: want ${slideCount} got ${z.data.slides.length}`,
        );
        return null;
      }
      return z.data;
    } catch (error) {
      if (axios.isCancel(error) || (error as Error).name === 'AbortError') {
        this.logger.warn(
          `Carousel intent plan timed out (limit=${timeoutMs}ms)`,
        );
      } else if (axios.isAxiosError(error)) {
        this.logger.warn(
          `Carousel intent plan failed: ${error.response?.status ?? 'unknown'} — ${error.message}`,
        );
      } else {
        this.logger.warn(
          `Carousel intent plan error: ${(error as Error).message}`,
        );
      }
      return null;
    }
  }

  private async callAndParse(
    system: string,
    user: string,
    contentType: 'text' | 'image' | 'carousel',
    textModel: string,
  ): Promise<PostOutput> {
    const rawJson = await this.callOpenAI(system, user, {
      maxTokens: contentType === 'carousel' ? 8192 : 4096,
      model: textModel,
    });

    const result = safeParseCustomTopicPostOutput(rawJson, contentType);
    if (result.success) {
      return result.data;
    }

    this.logger.warn(
      `First parse failed: ${result.error.message}. Retrying with tightened prompt.`,
    );

    const tightenedSystem = [
      system,
      '',
      'IMPORTANT: Your previous response was not valid JSON matching the required schema.',
      'Try again. Return ONLY the JSON object. No markdown fences. No explanation.',
      `Schema errors: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    ].join('\n');

    const retryJson = await this.callOpenAI(tightenedSystem, user, {
      maxTokens: contentType === 'carousel' ? 8192 : 4096,
      model: textModel,
    });
    const retryResult = safeParseCustomTopicPostOutput(retryJson, contentType);

    if (retryResult.success) {
      return retryResult.data;
    }

    throw new SchemaValidationError(retryResult.error.message);
  }

  private async compressCaption(
    current: TextPostOutput | ImagePostOutput | CarouselPostOutput,
    hardCap: number,
    originalSystem: string,
    contentType: 'text' | 'image' | 'carousel',
    textModel: string,
  ): Promise<PostOutput> {
    const compressSystem = [
      originalSystem,
      '',
      `Your previous output caption was too long. Compress the caption to under ${hardCap} words while keeping the same message, tone, and structure.`,
      'Return the FULL JSON object with the compressed caption and all other fields intact.',
    ].join('\n');

    const compressUser = `Previous output to compress:\n${JSON.stringify(current)}`;

    const rawJson = await this.callOpenAI(compressSystem, compressUser, {
      maxTokens: contentType === 'carousel' ? 8192 : 4096,
      model: textModel,
    });
    const result = safeParseCustomTopicPostOutput(rawJson, contentType);

    if (result.success) {
      return result.data;
    }

    throw new SchemaValidationError(
      `Compression retry failed validation: ${result.error.message}`,
    );
  }

  private async callOpenAI(
    system: string,
    user: string,
    opts?: { maxTokens?: number; model?: string },
  ): Promise<unknown> {
    if (!this.openaiApiKey) {
      throw new ProviderError('OPENAI_API_KEY is not configured');
    }

    const model = opts?.model ?? this.customTopicModel;
    const maxTokens = opts?.maxTokens ?? 4096;
    const timeoutMs = 180_000; // 3 minutes

    this.logger.log(
      `Queueing OpenAI call: model=${model} maxTokens=${maxTokens} systemLen=${system.length} userLen=${user.length} userId=${this.currentUserId}`,
    );

    // Use rate limiter with automatic retry for rate limit errors
    return this.openaiRateLimiter.executeWithRetry(
      this.currentUserId,
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
          this.logger.error(
            `OpenAI call timed out after ${timeoutMs / 1000}s (model=${model}, maxTokens=${maxTokens})`,
          );
        }, timeoutMs);

        const startTime = Date.now();

        try {
          const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
              model,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              temperature: 0.7,
              max_tokens: maxTokens,
              response_format: { type: 'json_object' },
            },
            {
              headers: {
                Authorization: `Bearer ${this.openaiApiKey}`,
                'Content-Type': 'application/json',
              },
              timeout: timeoutMs,
              signal: controller.signal,
            },
          );

          clearTimeout(timeoutId);

          const elapsed = Date.now() - startTime;
          this.logger.log(
            `OpenAI call completed in ${elapsed}ms (model=${model})`,
          );

          const content = response.data?.choices?.[0]?.message?.content;
          if (!content) {
            throw new ProviderError('Empty response from OpenAI');
          }

          try {
            return JSON.parse(content);
          } catch {
            throw new SchemaValidationError(
              `Response is not valid JSON: ${content.slice(0, 200)}`,
            );
          }
        } catch (error) {
          clearTimeout(timeoutId);

          const elapsed = Date.now() - startTime;

          if (
            error instanceof OffTopicError ||
            error instanceof SchemaValidationError ||
            error instanceof ContentTooLongError ||
            error instanceof ProviderError ||
            error instanceof CarouselQualityError
          ) {
            throw error;
          }

          // Handle AbortController timeout
          if (axios.isCancel(error) || (error as Error).name === 'AbortError') {
            const timeoutMsg = `OpenAI API request timed out after ${elapsed}ms (limit=${timeoutMs}ms, model=${model})`;
            this.logger.error(timeoutMsg);
            throw new ProviderError(timeoutMsg);
          }

          // Handle axios timeout (ECONNABORTED)
          if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
            const timeoutMsg = `OpenAI API connection timed out after ${elapsed}ms (limit=${timeoutMs}ms, model=${model})`;
            this.logger.error(timeoutMsg);
            throw new ProviderError(timeoutMsg);
          }

          const message = axios.isAxiosError(error)
            ? `OpenAI API request failed after ${elapsed}ms: ${error.response?.status ?? 'unknown'} — ${error.response?.data?.error?.message ?? error.message}`
            : `OpenAI API error after ${elapsed}ms: ${(error as Error).message}`;

          this.logger.error(message);
          throw new ProviderError(message);
        }
      },
      `chat-completion:${model}`,
    );
  }

  /**
   * Tiered recovery: deterministic expansion → model rewrite → expansion again →
   * optional minimum ship when the deck is thin but usable.
   */
  private async enforceCarouselQualityGate(
    postOutput: CarouselPostOutput,
    input: PostGenerationInput,
    system: string,
    user: string,
    resolvedVisualStyle: CarouselVisualStyle,
    noteDensity: CarouselNoteDensityLevel,
    programmingModeEffective: boolean,
    textModel: string,
    lifecycle: CustomTopicGenerateLifecycle | undefined,
    recoveryStages: string[],
  ): Promise<void> {
    const topicLower = input.topic.toLowerCase();
    let slides = postOutput.slides ?? [];
    const expected =
      input.slideCount != null ? input.slideCount : slides.length;

    const recovery = (stage: string, meta?: Record<string, unknown>) => {
      recoveryStages.push(stage);
      lifecycle?.onCarouselRecoveryStage?.(stage, meta);
    };

    const scaffoldFullNotebookPages =
      isNotebookPaperCarouselStyle(resolvedVisualStyle) &&
      (noteDensity === 'dense' ||
        topicRequestsFilledHandwritingNotes(topicLower));

    const runAnalyze = () =>
      analyzeCarouselQuality({
        slides,
        expectedCount: expected,
        topicLower,
        resolvedVisualStyle,
        noteDensity,
        programmingModeEffective,
      });

    let issues = runAnalyze();
    if (issues.length === 0) {
      return;
    }

    this.logger.warn(
      `Carousel quality gate (${issues.length}): ${issues.map((i) => i.code).join(',')}`,
    );
    recovery('carousel_quality_issues', {
      codes: issues.map((i) => i.code),
    });

    if (scaffoldFullNotebookPages) {
      recovery('improving_slide_density', { step: 'deterministic_expand' });
      slides = expandSparseCarouselSlides(slides, {
        topicLower,
        programmingModeEffective,
        noteDensity,
        scaffoldFullNotebookPages,
      }) as CarouselPostOutput['slides'];
      postOutput.slides = slides;
      issues = runAnalyze();
      if (issues.length === 0) {
        return;
      }
    }

    recovery('improving_slide_density', {
      step: 'model_rewrite',
      codes: issues.map((i) => i.code),
    });

    const strictSystem = [
      system,
      '',
      buildCarouselStrictRetryInstruction(issues, {
        noteDensity,
        programmingModeEffective,
      }),
      '',
      `Reminders: carousel visual mode is "${resolvedVisualStyle}". imagePrompt MUST match notebook/whiteboard stock rules from OUTPUT FORMAT.`,
    ].join('\n');

    const rawJson = await this.callOpenAI(strictSystem, user, {
      maxTokens: 8192,
      model: textModel,
    });
    const retry = safeParseCustomTopicPostOutput(rawJson, 'carousel');

    if (!retry.success) {
      throw new SchemaValidationError(retry.error.message);
    }

    if ('error' in retry.data && retry.data.error === 'off_topic') {
      throw new OffTopicError();
    }

    const rewritten = retry.data as CarouselPostOutput;
    Object.assign(postOutput, rewritten);
    slides = postOutput.slides ?? [];

    if (scaffoldFullNotebookPages) {
      recovery('improving_slide_density', { step: 'post_model_expand' });
      slides = expandSparseCarouselSlides(slides, {
        topicLower,
        programmingModeEffective,
        noteDensity,
        scaffoldFullNotebookPages,
      }) as CarouselPostOutput['slides'];
      postOutput.slides = slides;
    }

    issues = runAnalyze();
    if (issues.length === 0) {
      return;
    }

    if (
      meetsMinimumShippableCarousel({
        slides,
        expectedCount: expected,
        noteDensity,
        programmingModeEffective,
        remainingIssues: issues,
      })
    ) {
      this.logger.warn(
        `Carousel accepted on minimum ship bar after recovery (remaining: ${issues.map((i) => i.code).join(',')})`,
      );
      recovery('carousel_quality_minimum_ship', {
        toleratedCodes: issues.map((i) => i.code),
      });
      return;
    }

    throw new CarouselQualityError(issues);
  }

  /**
   * Enforce structural document-deck quality (cover/TOC/body alignment, page numbers,
   * body bullet density). Gives the model ONE strict-retry attempt. Throws
   * `CarouselQualityError` when checks still fail after retry.
   */
  private async enforceDocumentDeckQualityGate(
    postOutput: CarouselPostOutput,
    input: PostGenerationInput,
    system: string,
    user: string,
    documentMode: 'handwritten_notes' | 'structured_document',
    textModel: string,
    lifecycle: CustomTopicGenerateLifecycle | undefined,
    recoveryStages: string[],
  ): Promise<void> {
    const expected = input.slideCount ?? postOutput.slides?.length ?? 0;

    const recovery = (stage: string, meta?: Record<string, unknown>) => {
      recoveryStages.push(stage);
      lifecycle?.onCarouselRecoveryStage?.(stage, meta);
    };

    const runAnalyze = () =>
      analyzeDocumentDeckQuality({
        output: postOutput,
        expectedSlideCount: expected,
        documentMode,
      });

    let issues = runAnalyze();
    if (issues.length === 0) return;

    this.logger.warn(
      `Document deck quality gate (${issues.length}): ${issues.map((i) => i.code).join(',')}`,
    );
    recovery('document_deck_quality_issues', {
      codes: issues.map((i) => i.code),
    });
    recovery('improving_document_deck', {
      step: 'model_rewrite',
      codes: issues.map((i) => i.code),
    });

    const strictSystem = [
      system,
      '',
      buildDocumentDeckStrictRetryInstruction(issues, documentMode),
    ].join('\n');

    const rawJson = await this.callOpenAI(strictSystem, user, {
      maxTokens: 8192,
      model: textModel,
    });
    const retry = safeParseCustomTopicPostOutput(rawJson, 'carousel');
    if (!retry.success) {
      throw new SchemaValidationError(retry.error.message);
    }
    if ('error' in retry.data && retry.data.error === 'off_topic') {
      throw new OffTopicError();
    }

    const rewritten = retry.data as CarouselPostOutput;
    Object.assign(postOutput, rewritten);

    issues = runAnalyze();
    if (issues.length === 0) return;

    throw new CarouselQualityError(issues);
  }

  private async retryWithSafetyConstraint(
    original: TextPostOutput | ImagePostOutput | CarouselPostOutput,
    flaggedTerms: string[],
    input: PostGenerationInput,
    wordLimit: { target: number; hardCap: number },
    tonalityGuide: TonalityGuide,
    carouselCtx: CustomTopicCarouselPromptContext | null,
    textModel: string,
  ): Promise<(TextPostOutput | ImagePostOutput | CarouselPostOutput) | null> {
    const { system } = buildCustomTopicPrompt(
      input,
      wordLimit,
      tonalityGuide,
      carouselCtx,
    );
    const safeSystem = [
      system,
      '',
      'CRITICAL: Your previous output contained inappropriate language.',
      `Flagged terms: ${flaggedTerms.join(', ')}`,
      'Rewrite the caption to avoid all profanity, slurs, and offensive language.',
      'Keep the same structure, tone, and message. Return the FULL JSON object.',
    ].join('\n');

    const userPrompt = `Previous output to rewrite safely:\n${JSON.stringify(original)}`;
    const rawJson = await this.callOpenAI(safeSystem, userPrompt, {
      maxTokens: input.contentType === 'carousel' ? 8192 : 4096,
      model: textModel,
    });
    const result = safeParseCustomTopicPostOutput(rawJson, input.contentType);
    if (!result.success) return null;
    if ('error' in result.data && result.data.error === 'off_topic')
      return null;

    const rewritten = result.data as
      | TextPostOutput
      | ImagePostOutput
      | CarouselPostOutput;
    const recheck = this.moderationService.checkOutputSafety(rewritten.caption);
    return recheck.safe ? rewritten : null;
  }

  private applyPlatformFormatting<
    T extends TextPostOutput | ImagePostOutput | CarouselPostOutput,
  >(output: T, platform: string): T {
    const result = { ...output };

    switch (platform) {
      case 'linkedin':
        result.caption = this.formatLinkedIn(result.caption);
        break;
      case 'instagram':
        result.caption = this.formatInstagram(result.caption, result.hashtags);
        break;
      case 'x':
        result.caption = this.formatX(result.caption);
        break;
    }

    return result;
  }

  private formatLinkedIn(caption: string): string {
    let formatted = caption;

    formatted = formatted.replace(/([.!?])\s+(?=[A-Z])/g, (match, punct) => {
      const rand = Math.random();
      return rand < 0.5 ? `${punct}\n\n` : match;
    });

    if (formatted.length > 3000) {
      formatted = formatted.slice(0, 2997) + '...';
    }

    return formatted;
  }

  private formatInstagram(caption: string, hashtags: string[]): string {
    let formatted = caption;

    if (formatted.length > 2200) {
      formatted = formatted.slice(0, 2197) + '...';
    }

    if (hashtags.length > 0) {
      const hashtagBlock = hashtags.join(' ');
      const existingHashIndex = formatted.lastIndexOf('#');

      if (
        existingHashIndex === -1 ||
        existingHashIndex < formatted.length - 200
      ) {
        formatted = `${formatted}\n\n.\n.\n.\n${hashtagBlock}`;
      }
    }

    return formatted;
  }

  private formatX(caption: string): string {
    if (caption.length <= 280) {
      return caption;
    }

    const truncated = caption.slice(0, 277);
    const lastSpace = truncated.lastIndexOf(' ');
    return (
      (lastSpace > 200 ? truncated.slice(0, lastSpace) : truncated) + '...'
    );
  }
}
