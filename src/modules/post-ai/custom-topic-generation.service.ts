import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
  linkedInCommentaryLength,
  LINKEDIN_MAX_TEXT_LENGTH,
} from '../../common/utils/linkedin-publish-text';
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
import {
  AiGatewayService,
  AiGatewayError,
} from '../../services/ai-gateway.service';
import {
  WebResearchService,
  type ResearchPromptContext,
} from '../../services/web-research.service';
import { buildResearchUserMessage } from '../../services/web-research-intent';
import { PromptFormatterService } from './prompt-formatter.service';
import {
  BrandProfilesService,
  type BrandProfile,
} from '../../services/brand-profiles.service';
import { BrandVisionAnalysisService } from '../../services/brand-vision-analysis.service';
import { PostStyleLearningService } from './post-style-learning.service';
import {
  debugLogBrandKitLoaded,
  debugLogBrandKitSkipped,
  debugLogCustomTopicPrompts,
  debugLogGatewayTextCall,
  debugLogGatewayTextResponse,
  isLlmGenerationDebugEnabled,
} from '../../utils/llm-generation-debug';
import { parseJsonFromLlmPayload } from '../../common/utils/parse-json-from-llm';

export interface CustomTopicResult {
  output: TextPostOutput | ImagePostOutput | CarouselPostOutput;
  platform: string;
  contentType: string;
  generationMeta?: {
    textModel?: string;
    webResearch?: {
      query: string;
      sourceCount: number;
      isResearchIntent: boolean;
      responseTimeMs: number;
    };
  };
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
   * Fired when live web research starts/completes (Tavily). Worker maps this to
   * the `researching_web` progress step before `generating_text`.
   */
  onWebResearchStage?: (
    stage: 'running' | 'succeeded' | 'skipped',
    meta?: Record<string, unknown>,
  ) => void;
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
    private readonly aiGateway: AiGatewayService,
    private readonly webResearch: WebResearchService,
    private readonly brandProfiles: BrandProfilesService,
    private readonly brandVision: BrandVisionAnalysisService,
    private readonly postStyleLearning: PostStyleLearningService,
    private readonly promptFormatter: PromptFormatterService,
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

    // STEP 0 — AI Formatter (cheap model): clean grammar/punctuation and
    // structure the raw prompt WITHOUT stripping keywords or changing meaning.
    // The cleaned prompt is used for BOTH generation and the Tavily web search,
    // so search receives the full structured prompt (not stripped keywords).
    // Always best-effort; on any failure the original topic is used unchanged.
    const originalTopic = input.topic;
    const formattedPrompt = await this.promptFormatter.format(originalTopic);
    if (
      formattedPrompt.formatted &&
      formattedPrompt.cleaned !== originalTopic
    ) {
      input.topic = formattedPrompt.cleaned;
      this.logger.log(
        `Prompt formatted: "${originalTopic.slice(0, 60)}..." -> "${formattedPrompt.cleaned.slice(0, 60)}..."`,
      );
    }

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

    // Live web research FIRST: prompt → Tavily search → facts + links → LLM
    let researchBlock: string | undefined;
    let userPrompt: string | undefined;
    let webResearchMeta:
      | {
          query: string;
          sourceCount: number;
          isResearchIntent: boolean;
          responseTimeMs: number;
        }
      | undefined;

    try {
      lifecycle?.onWebResearchStage?.('running');

      if (!input.onlineSearch) {
        // Online search is an explicit user toggle. When off, never hit Tavily —
        // generate purely from the topic + brand voice.
        lifecycle?.onWebResearchStage?.('skipped', { reason: 'toggle_off' });
      } else if (this.webResearch.isEnabled()) {
        // Keep the intent detection (drives prompt framing) but send the FULL
        // formatted prompt to Tavily as the query — never the stripped keywords.
        const detected = this.webResearch.buildPromptContext(
          input.topic,
          input.platform,
        );
        const promptCtx: ResearchPromptContext = {
          isResearchIntent: detected.isResearchIntent,
          searchQuery: input.topic,
          tavilyTopic: formattedPrompt.tavilyTopic ?? detected.tavilyTopic,
          timeRange: formattedPrompt.freshness ?? detected.timeRange,
        };
        const research = await this.webResearch.searchWithContext(
          input.topic,
          promptCtx,
          {
            includeAnswer: true,
            // Highest relevance + freshest sources for the explicit search toggle.
            searchDepth: 'advanced',
          },
        );

        if (research && research.sources.length > 0) {
          researchBlock = this.webResearch.formatForPrompt(
            research,
            input.topic,
            research.promptContext,
          );
          userPrompt = buildResearchUserMessage(
            input.topic,
            research,
            research.promptContext,
          );
          webResearchMeta = {
            query: research.query,
            sourceCount: research.sources.length,
            isResearchIntent: research.promptContext.isResearchIntent,
            responseTimeMs: research.responseTimeMs,
          };
          this.logger.log(
            `Web research injected: query="${research.query}" intent=${research.promptContext.isResearchIntent} sources=${research.sources.length} ${research.responseTimeMs}ms`,
          );
          lifecycle?.onWebResearchStage?.('succeeded', {
            query: research.query,
            sourceCount: research.sources.length,
            isResearchIntent: research.promptContext.isResearchIntent,
            responseTimeMs: research.responseTimeMs,
          });
        } else {
          lifecycle?.onWebResearchStage?.('skipped', { reason: 'no_results' });
        }
      } else {
        lifecycle?.onWebResearchStage?.('skipped', { reason: 'disabled' });
      }
    } catch (e) {
      this.logger.warn(
        `Web research failed (non-blocking): ${(e as Error).message}`,
      );
      try {
        lifecycle?.onWebResearchStage?.('skipped', {
          reason: 'error',
          message: (e as Error).message,
        });
      } catch {
        /* lifecycle must not break pipeline */
      }
    }

    let carouselIntentPlan: CarouselIntentPlan | null = null;
    if (
      input.contentType === 'carousel' &&
      input.slideCount &&
      input.slideCount >= 3
    ) {
      carouselIntentPlan = await this.fetchCarouselIntentPlan(
        userPrompt ?? input.topic,
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

    // Load user's brand kit for TEXT prompt injection.
    // When includeBrandKit is false, only inject do_use / do_not_use vocabulary
    // rules — skip name, tone, audience, voice examples, additional info.
    // Visual identity (colors, logo analysis) is handled in the image stage.
    const includeBrandKit = input.includeBrandKit !== false;
    let brandContextBlock = '';
    try {
      const brand = await this.brandProfiles.getPrimaryForUser(
        this.currentUserId,
      );
      if (brand) {
        brandContextBlock = this.buildBrandContextBlock(brand, includeBrandKit);
        if (includeBrandKit) {
          this.logger.log(
            `Brand voice injected (full): "${brand.name}" tone=${brand.tone ? 'yes' : 'no'} voiceExamples=${brand.voice_examples?.length ?? 0} doUse=${brand.do_use?.length ?? 0} doNotUse=${brand.do_not_use?.length ?? 0}`,
          );
        } else {
          this.logger.log(
            `Brand vocabulary only: doUse=${brand.do_use?.length ?? 0} doNotUse=${brand.do_not_use?.length ?? 0} (brand kit toggle OFF)`,
          );
        }
        debugLogBrandKitLoaded(
          brand,
          brandContextBlock,
          includeBrandKit ? 'full' : 'vocabulary_only',
        );
      } else {
        debugLogBrandKitSkipped('no primary brand profile for user');
      }
    } catch (e) {
      this.logger.warn(`Brand kit load skipped: ${(e as Error).message}`);
      debugLogBrandKitSkipped((e as Error).message);
    }

    // Sprint 1.6 (task #1132): learn from the user's OWN past published posts.
    // Always injected (even when brand kit toggle is OFF). Best-effort.
    let pastPostsStyleBlock = '';
    try {
      pastPostsStyleBlock =
        (await this.postStyleLearning.buildStyleProfileBlock(
          this.currentUserId,
          input.platform,
        )) || '';
      if (pastPostsStyleBlock && !includeBrandKit) {
        pastPostsStyleBlock = pastPostsStyleBlock.replace(
          'When this conflicts with the brand voice block, the brand voice wins.',
          'There is no brand voice block for this run — mirror the style from these examples.',
        );
      }
    } catch (e) {
      this.logger.warn(`Past-post style skipped: ${(e as Error).message}`);
    }

    const { system: baseSystem, user: defaultUser } = buildCustomTopicPrompt(
      input,
      wordLimit,
      tonalityGuide,
      carouselCtx,
    );

    const systemParts = [baseSystem];
    if (brandContextBlock) systemParts.push(brandContextBlock);
    if (pastPostsStyleBlock) systemParts.push(pastPostsStyleBlock);
    if (researchBlock) systemParts.push(researchBlock);
    const system = systemParts.join('\n\n');
    const user = userPrompt ?? defaultUser;

    this.logger.log(
      `Generating custom topic post: platform=${input.platform} type=${input.contentType} tonality=${input.tonality} wordTarget=${wordLimit.target} webResearch=${!!researchBlock} includeBrandKit=${includeBrandKit}`,
    );

    if (isLlmGenerationDebugEnabled()) {
      this.logger.log(
        includeBrandKit
          ? 'AI_GENERATION_DEBUG=on — full brand kit + LLM prompts below (set AI_GENERATION_DEBUG=false to disable)'
          : 'AI_GENERATION_DEBUG=on — brand kit OFF (vocabulary + past posts only) + LLM prompts below',
      );
    }

    debugLogCustomTopicPrompts({
      platform: input.platform,
      contentType: input.contentType,
      textModel,
      hasWebResearch: !!researchBlock,
      webResearchMeta: webResearchMeta ?? undefined,
      researchBlock: researchBlock || undefined,
      system,
      user,
    });

    const { output: parsed, model: usedTextModel } = await this.callAndParse(
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
      input.topic,
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
          output: this.finalizeOutput(retryResult, usedTextModel),
          platform: input.platform,
          contentType: input.contentType,
          generationMeta: this.buildGenerationMeta(
            usedTextModel,
            webResearchMeta,
          ),
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
      output: this.finalizeOutput(formatted, usedTextModel),
      platform: input.platform,
      contentType: input.contentType,
      generationMeta: this.buildGenerationMeta(usedTextModel, webResearchMeta),
      carouselGenerationMeta: carouselMetaPack,
    };
  }

  /**
   * Post-process: normalize excessive line breaks in caption.
   */
  private finalizeOutput<
    T extends TextPostOutput | ImagePostOutput | CarouselPostOutput,
  >(output: T, _usedTextModel?: string): T {
    output.caption = this.normalizeLinkedInSpacing(output.caption);
    return output;
  }

  /**
   * Normalize LinkedIn caption spacing so it reads dense and intentional
   * instead of "one sentence per blank-line block" (which looks hollow).
   *
   * Steps:
   *  1. Trim trailing whitespace and collapse 3+ newlines to a single blank line.
   *  2. Group consecutive SHORT single-sentence paragraphs into 2-3 sentence
   *     blocks, joined with a space (a real paragraph).
   *  3. Keep the opening hook standalone, and keep a trailing question/CTA
   *     standalone — both are intentional LinkedIn patterns.
   */
  private normalizeLinkedInSpacing(caption: string): string {
    const cleaned = caption
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const paras = cleaned
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    // Nothing to regroup for very short posts.
    if (paras.length <= 2) return paras.join('\n\n');

    const wordCount = (p: string) => p.split(/\s+/).filter(Boolean).length;
    const sentenceCount = (p: string) =>
      (p.match(/[.!?]+(\s|$)/g) || []).length || 1;
    // A paragraph is a candidate for merging only if it's a single short line.
    const isShortSingle = (p: string) =>
      !p.includes('\n') && wordCount(p) <= 18;
    const endsWithQuestion = (p: string) => /\?\s*$/.test(p);

    const out: string[] = [];
    let buffer: string[] = [];
    const flush = () => {
      if (buffer.length) {
        out.push(buffer.join(' '));
        buffer = [];
      }
    };

    paras.forEach((p, idx) => {
      const isFirst = idx === 0;
      const isLast = idx === paras.length - 1;

      // Keep the hook (first block) and a closing question/CTA (last block)
      // on their own lines — that contrast is what makes them land.
      if (isFirst || (isLast && endsWithQuestion(p))) {
        flush();
        out.push(p);
        return;
      }

      if (isShortSingle(p)) {
        buffer.push(p);
        const words = wordCount(buffer.join(' '));
        const sentences = buffer.reduce((n, b) => n + sentenceCount(b), 0);
        // Cap merged paragraphs at ~3 sentences / ~32 words for readability.
        if (sentences >= 3 || words >= 32) flush();
      } else {
        flush();
        out.push(p);
      }
    });
    flush();

    return out.join('\n\n');
  }

  /**
   * Build a brand-voice prompt segment for the TEXT LLM.
   *
   * When `full` is true (default): includes name, tone, audience, voice
   * examples, words to use/avoid, and additional info.
   *
   * When `full` is false (brand kit toggle OFF): only includes words to use
   * and words to avoid (minimal vocabulary guardrails). The user's past posts
   * learning is injected separately and is NOT affected by this toggle.
   */
  private buildBrandContextBlock(brand: BrandProfile, full = true): string {
    // Minimal mode: only do_use / do_not_use vocabulary rules
    if (!full) {
      const hasDoUse = brand.do_use?.length > 0;
      const hasDoNotUse = brand.do_not_use?.length > 0;
      if (!hasDoUse && !hasDoNotUse) return '';

      const lines: string[] = ['--- VOCABULARY RULES ---'];
      if (hasDoUse) {
        lines.push(`Words/phrases to USE: ${brand.do_use.join(', ')}`);
      }
      if (hasDoNotUse) {
        lines.push(
          `Words/phrases to AVOID (never use): ${brand.do_not_use.join(', ')}`,
        );
      }
      lines.push('--- END VOCABULARY RULES ---');
      return lines.join('\n');
    }

    // Full brand voice mode
    const lines: string[] = [
      '--- BRAND VOICE ---',
      `Brand name: ${brand.name}`,
    ];

    if (brand.tone) {
      lines.push(`Tone & personality: ${brand.tone}`);
    }
    if (brand.target_audience) {
      lines.push(`Target audience: ${brand.target_audience}`);
    }
    if (brand.voice_examples?.length > 0) {
      lines.push('');
      lines.push('Voice examples (match this writing style):');
      for (const example of brand.voice_examples) {
        lines.push(`  - "${example}"`);
      }
    }
    if (brand.do_use?.length > 0) {
      lines.push('');
      lines.push(`Words/phrases to USE: ${brand.do_use.join(', ')}`);
    }
    if (brand.do_not_use?.length > 0) {
      lines.push(
        `Words/phrases to AVOID (never use): ${brand.do_not_use.join(', ')}`,
      );
    }
    if (brand.additional_information) {
      lines.push('');
      lines.push(`Additional brand context: ${brand.additional_information}`);
    }

    lines.push(
      '',
      'Write the caption in this brand voice and vocabulary.',
      '--- END BRAND VOICE ---',
    );

    return lines.join('\n');
  }

  private buildGenerationMeta(
    usedTextModel?: string,
    webResearch?: {
      query: string;
      sourceCount: number;
      isResearchIntent: boolean;
      responseTimeMs: number;
    },
  ): CustomTopicResult['generationMeta'] {
    return {
      textModel: usedTextModel,
      webResearch,
    };
  }

  private async fetchCarouselIntentPlan(
    topicOrUserPrompt: string,
    slideCount: number,
    _textModel: string,
  ): Promise<CarouselIntentPlan | null> {
    const startTime = Date.now();
    this.logger.log(
      `Queueing carousel intent plan via gateway: slideCount=${slideCount} userId=${this.currentUserId}`,
    );

    try {
      const system = buildCarouselOutlineSystemPrompt(slideCount);
      const user = topicOrUserPrompt.includes('\n')
        ? topicOrUserPrompt
        : `Topic: ${topicOrUserPrompt}`;

      // Bifrost gateway text chain (admin-managed model + automatic fallback).
      const { content, model } = await this.aiGateway.chatCompletionRaw({
        category: 'text',
        temperature: 0.35,
        maxTokens: 1200,
        jsonObject: true,
        timeoutMs: 90_000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      this.logger.log(
        `Carousel intent plan fetched in ${Date.now() - startTime}ms (model=${model})`,
      );

      if (!content) return null;
      const parsed = parseJsonFromLlmPayload(content);
      if (parsed === null) return null;
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
      this.logger.warn(
        `Carousel intent plan error: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async callAndParse(
    system: string,
    user: string,
    contentType: 'text' | 'image' | 'carousel',
    textModel: string,
  ): Promise<{ output: PostOutput; model: string }> {
    const first = await this.callOpenAI(system, user, {
      maxTokens: contentType === 'carousel' ? 8192 : 4096,
      model: textModel,
    });

    const firstResult =
      first.parsed === null
        ? null
        : safeParseCustomTopicPostOutput(first.parsed, contentType);
    if (firstResult?.success) {
      return { output: firstResult.data, model: first.model };
    }

    const failureDetail =
      first.parsed === null
        ? 'Response was not valid JSON (markdown fences or unescaped double quotes inside strings are common causes).'
        : `Schema validation failed: ${firstResult!.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;

    this.logger.warn(`First LLM output rejected: ${failureDetail} Retrying.`);

    const tightenedSystem = [
      system,
      '',
      'IMPORTANT: Your previous response was not valid JSON matching the required schema.',
      'Try again. Return ONLY the JSON object. No markdown fences. No explanation.',
      'Never use unescaped double-quote characters inside JSON string values — use single quotes for emphasis.',
      'Respect the HARD word limit on caption length from the system prompt.',
      failureDetail,
    ].join('\n');

    const retry = await this.callOpenAI(tightenedSystem, user, {
      maxTokens: contentType === 'carousel' ? 8192 : 4096,
      model: textModel,
    });

    if (retry.parsed === null) {
      throw new SchemaValidationError(
        `Response is not valid JSON after retry: ${retry.rawContent.slice(0, 200)}`,
      );
    }

    const retryResult = safeParseCustomTopicPostOutput(
      retry.parsed,
      contentType,
    );

    if (retryResult.success) {
      return { output: retryResult.data, model: retry.model };
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

    const { parsed: rawJson } = await this.callOpenAI(
      compressSystem,
      compressUser,
      {
        maxTokens: contentType === 'carousel' ? 8192 : 4096,
        model: textModel,
      },
    );
    if (rawJson === null) {
      throw new SchemaValidationError(
        'Compression retry returned invalid JSON',
      );
    }
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
  ): Promise<{ parsed: unknown | null; model: string; rawContent: string }> {
    const maxTokens = opts?.maxTokens ?? 4096;
    const startTime = Date.now();

    this.logger.log(
      `Queueing gateway text call: maxTokens=${maxTokens} systemLen=${system.length} userLen=${user.length} userId=${this.currentUserId}`,
    );

    debugLogGatewayTextCall({
      maxTokens,
      model: opts?.model,
      userId: this.currentUserId,
      system,
      user,
    });

    try {
      // Bifrost gateway text chain: admin-managed primary model with automatic
      // fallback to the next configured text model on failure ("never fail").
      const { content, model } = await this.aiGateway.chatCompletionRaw({
        category: 'text',
        temperature: 0.7,
        maxTokens,
        jsonObject: true,
        timeoutMs: 180_000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `Gateway text call completed in ${durationMs}ms (model=${model})`,
      );

      debugLogGatewayTextResponse({
        model,
        durationMs,
        contentPreview: content ?? undefined,
      });

      if (!content) {
        throw new ProviderError('Empty response from AI gateway');
      }
      const parsed = parseJsonFromLlmPayload(content);
      return { parsed, model, rawContent: content };
    } catch (error) {
      if (
        error instanceof OffTopicError ||
        error instanceof SchemaValidationError ||
        error instanceof ContentTooLongError ||
        error instanceof ProviderError ||
        error instanceof CarouselQualityError
      ) {
        throw error;
      }
      const message =
        error instanceof AiGatewayError
          ? `AI gateway text generation failed after ${Date.now() - startTime}ms: ${error.message}`
          : `AI gateway error after ${Date.now() - startTime}ms: ${(error as Error).message}`;
      this.logger.error(message);
      throw new ProviderError(message);
    }
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
      });
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

    const { parsed: rawJson } = await this.callOpenAI(strictSystem, user, {
      maxTokens: 8192,
      model: textModel,
    });
    if (rawJson === null) {
      throw new SchemaValidationError(
        'Carousel quality retry returned invalid JSON',
      );
    }
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
      });
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

    const { parsed: rawJson } = await this.callOpenAI(strictSystem, user, {
      maxTokens: 8192,
      model: textModel,
    });
    if (rawJson === null) {
      throw new SchemaValidationError(
        'Document deck quality retry returned invalid JSON',
      );
    }
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
    const { parsed: rawJson } = await this.callOpenAI(safeSystem, userPrompt, {
      maxTokens: input.contentType === 'carousel' ? 8192 : 4096,
      model: textModel,
    });
    if (rawJson === null) return null;
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
        result.caption = this.formatLinkedIn(
          result.caption,
          result.hashtags ?? [],
        );
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

  private formatLinkedIn(caption: string, hashtags: string[] = []): string {
    let formatted = caption;

    formatted = formatted.replace(/([.!?])\s+(?=[A-Z])/g, (match, punct) => {
      const rand = Math.random();
      return rand < 0.5 ? `${punct}\n\n` : match;
    });

    while (
      linkedInCommentaryLength(formatted, hashtags) >
        LINKEDIN_MAX_TEXT_LENGTH &&
      formatted.length > 0
    ) {
      formatted = formatted.slice(0, -1).trimEnd();
    }

    if (
      linkedInCommentaryLength(formatted, hashtags) > LINKEDIN_MAX_TEXT_LENGTH
    ) {
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

  /**
   * Build a fresh image scene prompt for per-image regeneration using the post
   * topic (formatter-cleaned), caption, brand vocabulary (do_use/do_not_use
   * only), and past-post style analysis — not the stale imagePrompts slot.
   */
  async composeImageRegenerationPrompt(params: {
    userId: string;
    platform: 'linkedin' | 'instagram' | 'x';
    topic: string;
    caption: string;
    variationNonce: string;
  }): Promise<string> {
    const prevUserId = this.currentUserId;
    this.currentUserId = params.userId || 'anonymous';

    try {
      let topic = String(params.topic || '').trim();
      if (topic.length < 3) {
        throw new Error('Topic too short for image regeneration');
      }

      try {
        const formatted = await this.promptFormatter.format(topic);
        if (formatted.formatted && formatted.cleaned.trim().length >= 3) {
          topic = formatted.cleaned.trim();
        }
      } catch (e) {
        this.logger.warn(
          `Image regen topic format skipped: ${(e as Error).message}`,
        );
      }

      const caption = String(params.caption || '')
        .replace(/\n*[—-]\s*Generated by[\s\S]*$/i, '')
        .trim();
      if (caption.length < 20) {
        throw new Error('Caption too short for image regeneration');
      }

      let vocabularyBlock = '';
      try {
        const brand = await this.brandProfiles.getPrimaryForUser(params.userId);
        if (brand) {
          vocabularyBlock = this.buildBrandContextBlock(brand, false);
        }
      } catch (e) {
        this.logger.warn(
          `Image regen vocabulary skipped: ${(e as Error).message}`,
        );
      }

      let pastPostsBlock = '';
      try {
        const raw = await this.postStyleLearning.buildStyleProfileBlock(
          params.userId,
          params.platform,
        );
        if (raw) {
          pastPostsBlock = [
            '--- AUTHOR CONTEXT (from their published posts — mirror themes/mood, do not copy text) ---',
            raw.replace(
              'write the new post so it feels like the same',
              "illustrate a scene that feels like the same author's world",
            ),
            'Use this only to inform visual mood and subject matter for the image.',
            '--- END AUTHOR CONTEXT ---',
          ].join('\n');
        }
      } catch (e) {
        this.logger.warn(
          `Image regen past-post style skipped: ${(e as Error).message}`,
        );
      }

      const system = [
        'You write ONE detailed image-generation scene prompt for a social media post.',
        'Return ONLY valid JSON: {"imagePrompt":"..."}',
        'Rules:',
        '- imagePrompt = concrete visual scene (subjects, setting, lighting, camera angle, mood).',
        '- Must reflect the TOPIC and CAPTION themes.',
        '- Create a FRESH composition — vary setting and metaphor; avoid repeating generic stock desk/monitor scenes unless the caption demands it.',
        '- No readable text overlays, logos, or watermarks in the scene.',
        `- Variation nonce (force uniqueness): ${params.variationNonce}`,
      ].join('\n');

      const userParts = [
        `TOPIC:\n${topic}`,
        `CAPTION:\n${caption.slice(0, 2200)}`,
      ];
      if (vocabularyBlock) userParts.push(vocabularyBlock);
      if (pastPostsBlock) userParts.push(pastPostsBlock);

      const { content, model } = await this.aiGateway.chatCompletionRaw({
        category: 'text',
        temperature: 0.9,
        maxTokens: 900,
        jsonObject: true,
        timeoutMs: 60_000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userParts.join('\n\n') },
        ],
      });

      const parsed = parseJsonFromLlmPayload(content || '');
      const prompt = String(
        (parsed as { imagePrompt?: unknown } | null)?.imagePrompt ?? '',
      ).trim();
      if (!prompt) {
        throw new Error('Image regen LLM returned empty imagePrompt');
      }

      this.logger.log(
        `Composed fresh image regen prompt (${prompt.length} chars, model=${model})`,
      );
      return prompt;
    } finally {
      this.currentUserId = prevUserId;
    }
  }
}
