import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { GenerationService } from '../services/generation.service';
import { GeneratedContentRepository } from '../repositories/generated-content.repository';
import { mergePerformancePredictionWithRefinementApplied } from '../common/utils/merge-performance-prediction';
import { isViralTopicsN8nPayload } from '../common/utils/viral-topics-detect';
import { CacheService } from '../services/cache.service';
import { PostRefinementService } from '../services/post-refinement.service';
import { MediaPostType } from '../common/dto/media-intent.dto';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { UserRateLimitGuard } from '../guards/user-rate-limit.guard';
import { ModerationGuard } from '../guards/moderation.guard';
import { CreditPreflightGuard, CreditPreflightData } from '../guards/credit-preflight.guard';
import { SocialChannelGuard } from '../guards/social-channel.guard';
import { RequireSocialChannel } from '../decorators/require-social-channel.decorator';

@ApiTags('generation')
@Controller('generation')
@UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
@ApiBearerAuth()
export class GenerationController {
  constructor(
    private generationService: GenerationService,
    private generatedContentRepository: GeneratedContentRepository,
    private cacheService: CacheService,
    private postRefinementService: PostRefinementService,
  ) {}

  @Post('start')
  @UseGuards(SocialChannelGuard)
  @RequireSocialChannel('linkedin')
  @ApiOperation({ summary: 'Start content generation' })
  async startGeneration(
    @Request() req,
    @Body() body: { preferences?: Record<string, any> },
  ) {
    const userId = req.user?.id || 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3';
    return this.generationService.startGeneration(userId, body.preferences);
  }

  @Get('job/:jobId')
  @ApiOperation({ summary: 'Get generation job status' })
  async getJobStatus(@Request() req, @Param('jobId') jobId: string) {
    const userId = req.user?.id || 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3';
    return this.generationService.getJobStatus(jobId, userId);
  }

  @Post('job/:jobId/check-completion')
  @ApiOperation({
    summary: 'Check if job is complete in queue and sync status',
  })
  async checkJobCompletion(@Request() req, @Param('jobId') jobId: string) {
    const userId = req.user?.id || 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3';
    return this.generationService.checkAndSyncJobCompletion(jobId, userId);
  }

  @Get('jobs')
  @ApiOperation({ summary: 'Get user generation jobs' })
  async getUserJobs(@Request() req) {
    const userId = req.user?.id || 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3';
    return this.generationService.getUserJobs(userId);
  }

  @Get('content')
  @ApiOperation({ summary: 'Get user generated content with pagination' })
  async getUserContent(
    @Request() req,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
    @Query('source') source?: string,
  ) {
    const userId = req.user?.id || 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3';
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20)); // Max 50 per page
    const offset = (pageNum - 1) * limitNum;
    const sourceFilter = source === 'viral' || source === 'custom' ? source : undefined;

    const [content, totalCount] = await Promise.all([
      this.generatedContentRepository.findByUserId(userId, limitNum, offset, sourceFilter),
      this.generatedContentRepository.countByUserId(userId, sourceFilter),
    ]);
    const refinedContent = await Promise.all(
      content.map((item) => this.ensureRefinedBeforeReturn(item)),
    );

    const totalPages = Math.ceil(totalCount / limitNum);

    return {
      data: refinedContent,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages,
        hasMore: pageNum < totalPages,
        hasPrev: pageNum > 1,
      },
    };
  }

  @Get('content/:contentId')
  @ApiOperation({ summary: 'Get specific content by ID' })
  async getContent(@Request() req, @Param('contentId') contentId: string) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    const content = await this.generatedContentRepository.findById(contentId);
    if (!content) return null;
    if ((content as any).user_id !== userId) {
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }
    return this.ensureRefinedBeforeReturn(content as any);
  }

  @Get('job/:jobId/content')
  @ApiOperation({ summary: 'Get content by job ID' })
  async getContentByJobId(@Request() req, @Param('jobId') jobId: string) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    const rows = await this.generatedContentRepository.findByJobId(jobId);
    const ownedRows = rows.filter((row) => (row as any).user_id === userId);
    return Promise.all(ownedRows.map((row) => this.ensureRefinedBeforeReturn(row as any)));
  }

  @Post('job/:jobId/retry')
  @ApiOperation({ summary: 'Manually retry a failed job' })
  async retryJob(@Request() req, @Param('jobId') jobId: string) {
    const userId = req.user?.id || 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3';
    return this.generationService.retryJob(jobId, userId);
  }

  @Delete('cache/user')
  @ApiOperation({ summary: 'Clear all cache for current user' })
  async clearUserCache(@Request() req) {
    const userId = req.user?.id || 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3';
    const count = await this.cacheService.invalidateUser(userId);
    return { message: 'User cache cleared successfully', deletedCount: count };
  }

  @Get('cache/stats')
  @ApiOperation({ summary: 'Get cache statistics' })
  async getCacheStats() {
    return this.cacheService.getStats();
  }

  @Get('scheduled')
  @ApiOperation({ summary: 'Get scheduled content with pagination' })
  async getScheduledContent(
    @Request() req,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
  ) {
    const userId = req.user?.id || 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3';
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20));
    const offset = (pageNum - 1) * limitNum;

    const [content, totalCount] = await Promise.all([
      this.generatedContentRepository.findScheduledContent(
        userId,
        limitNum,
        offset,
      ),
      this.generatedContentRepository.countScheduledByUserId(userId),
    ]);
    const refinedContent = await Promise.all(
      content.map((item) => this.ensureRefinedBeforeReturn(item as any)),
    );

    const totalPages = Math.ceil(totalCount / limitNum);

    return {
      data: refinedContent,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages,
        hasMore: pageNum < totalPages,
        hasPrev: pageNum > 1,
      },
    };
  }

  @Delete('job/:jobId/cancel')
  @ApiOperation({ summary: 'Cancel a generation job and refund reserved credits' })
  async cancelJob(@Request() req, @Param('jobId') jobId: string) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    return this.generationService.cancelJob(jobId, userId);
  }

  @Delete('content/:contentId')
  @ApiOperation({ summary: 'Soft-delete generated content' })
  async deleteContent(@Request() req, @Param('contentId') contentId: string) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    const content = await this.generatedContentRepository.findById(contentId);
    if (!content) {
      throw new HttpException('Content not found', HttpStatus.NOT_FOUND);
    }
    if ((content as any).user_id !== userId) {
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }
    await this.generatedContentRepository.softDelete(contentId);
    return { success: true, message: 'Content deleted' };
  }

  @Post('content/:contentId/regenerate')
  @ApiOperation({ summary: 'Regenerate carousel slides or images for existing content' })
  async regenerateMedia(
    @Request() req,
    @Param('contentId') contentId: string,
    @Body() body: { regenerationType: 'carousel' | 'images' },
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    return this.generationService.regenerateMedia(userId, contentId, body.regenerationType);
  }

  /**
   * Regenerate a single AI-generated image at a specific index inside an
   * existing content's `image_urls` array. Costs `IMAGE_PER_UNIT_CREDITS`
   * (currently 3) per call. Returns 402 with code `insufficient_credits` if
   * the user is short on balance — the FE turns that into a tooltip on the
   * disabled button.
   */
  @Post('regenerate/image')
  @ApiOperation({ summary: 'Regenerate a single image inside existing content' })
  async regenerateSingleImage(
    @Request() req,
    @Body()
    body: {
      contentId: string;
      imageIndex: number;
      originalPrompt?: string;
      userOverridePrompt?: string;
    },
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    if (!body?.contentId) {
      throw new HttpException('contentId is required', HttpStatus.BAD_REQUEST);
    }
    if (typeof body.imageIndex !== 'number' || body.imageIndex < 0) {
      throw new HttpException(
        'imageIndex must be a non-negative number',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.generationService.regenerateSingleImage(
      userId,
      body.contentId,
      body.imageIndex,
      body.userOverridePrompt,
    );
  }

  /**
   * Regenerate the entire carousel of an existing content. Costs
   * `SLIDE_PER_UNIT_CREDITS × N` (currently 2.5 × N) where N is the slide
   * count persisted on the original generation. Returns 402 with code
   * `insufficient_credits` if balance is short.
   */
  @Post('regenerate/carousel')
  @ApiOperation({ summary: 'Regenerate every slide of an existing carousel' })
  async regenerateCarousel(
    @Request() req,
    @Body() body: { contentId: string; slideCount?: number },
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    if (!body?.contentId) {
      throw new HttpException('contentId is required', HttpStatus.BAD_REQUEST);
    }
    return this.generationService.regenerateCarouselFromContent(
      userId,
      body.contentId,
      body.slideCount,
    );
  }

  @Post('custom-topic')
  @UseGuards(ModerationGuard, CreditPreflightGuard, SocialChannelGuard)
  @RequireSocialChannel('linkedin')
  @ApiOperation({ summary: 'Start custom topic AI post generation (credit-gated)' })
  async startCustomTopicGeneration(
    @Request() req,
    @Body()
    body: {
      topic: string;
      platform: 'linkedin' | 'instagram' | 'x';
      contentType: 'text' | 'image' | 'carousel' | 'post';
      tonality: string;
      wordLimit: { kind: 'short' | 'medium' | 'long' } | { kind: 'custom'; words: number };
      imageCount?: number;
      slideCount?: number;
      carouselVisualStyle?:
        | 'auto'
        | 'handwritten_notebook'
        | 'handwritten_notebook_dense'
        | 'whiteboard_notes'
        | 'diagram_clean'
        | 'stock_visual';
      carouselNoteDensity?: 'compact' | 'standard' | 'dense';
      carouselSubjectMode?: 'auto' | 'programming' | 'general';
      /** Educational deck preset (cover + TOC + body). Honored when tonality=educational. */
      carouselDocumentMode?:
        | 'auto'
        | 'none'
        | 'handwritten_notes'
        | 'structured_document';
      /** Optional cover author / handle for document-deck presets. */
      carouselDocumentAuthor?: string;
      /** Opt in to internal SaaS dataset capture (does not retrain external providers). */
      trainingDataCaptureOptIn?: boolean;
    },
  ) {
    const userId = req.user?.id;
    const preflight: CreditPreflightData = req.creditPreflight;
    return this.generationService.startCustomTopicGeneration(
      userId,
      body,
      preflight.creditSlices,
      preflight.totalCost,
    );
  }

  /**
   * Create a content record for user-provided content (no AI generation).
   * This is used for the "Your Content" flow where users paste their own content.
   * No credits are charged for creating the record - credits are only charged
   * when the user actually publishes or schedules the post.
   */
  /**
   * Format/improve user content using AI for LinkedIn posting.
   * This is a lightweight operation that costs 0.5 credits.
   */
  @Post('format-content')
  @ApiOperation({ summary: 'Format and improve content using AI for LinkedIn' })
  async formatContent(
    @Request() req,
    @Body() body: { content: string },
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    const { content } = body;
    if (!content || content.trim().length < 20) {
      throw new HttpException(
        'Content must be at least 20 characters',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.generationService.formatContentWithAI(userId, content.trim());
  }

  @Post('content/create-own')
  @ApiOperation({ summary: 'Create content record for user-provided content' })
  async createOwnContent(
    @Request() req,
    @Body()
    body: {
      content: string;
      title?: string;
      hashtags?: string[];
      mediaUrls?: string[];
      pdfUrl?: string;
    },
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    const { content, title, hashtags, mediaUrls, pdfUrl } = body;

    if (!content || content.trim().length === 0) {
      throw new HttpException(
        'Content is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Determine visual type based on what's provided
    let visualType: 'text' | 'image' | 'carousel' = 'text';
    if (pdfUrl) {
      visualType = 'carousel';
    } else if (mediaUrls && mediaUrls.length > 0) {
      visualType = 'image';
    }

    const created = await this.generatedContentRepository.create(
      userId,
      title || 'Your Content',
      content.trim(),
      {
        visualType: visualType as any,
        visualUrl: mediaUrls?.[0] || undefined,
        imageUrls: mediaUrls || undefined,
        pdfUrl: pdfUrl || undefined,
        hashtags: hashtags || [],
        source: 'custom',
        status: 'ready' as any,
        performancePrediction: {
          source: 'user-provided',
          isOwnContent: true,
        },
      },
    );

    return {
      success: true,
      content: created,
    };
  }

  private async ensureRefinedBeforeReturn(item: any): Promise<any> {
    if (!item || !item.id) return item;
    const title = String(item.title || '');
    const body = String(item.content || '');
    if (!title || !body) return item;
    if (isViralTopicsN8nPayload(title, body)) return item;

    const pp = item?.performance_prediction as Record<string, unknown> | undefined;
    const refinementAlreadyApplied =
      (pp?.postRefinement as { applied?: boolean } | undefined)?.applied === true;
    if (refinementAlreadyApplied) return item;

    // n8n often ships **bold** and [text](url). Plain n8n prose (no markdown) still needs refinement
    // when it came from the n8n-post workflow (see n8n-callback-normalize performancePrediction.source).
    const hasN8nStyleMarkdownLink = /\[([^\]]*)\]\((https?:[^)]+)\)/.test(body);
    const hasLegacyWatermark =
      /_My take:_/i.test(body) || /==Read more==:/i.test(body);
    const looksLikeNewsAttribution =
      /read more about\b/i.test(body) &&
      /https?:\/\/[^\s]+/i.test(body) &&
      /\*\*[^*]+\*\*/.test(body);
    const fromN8nPost = pp?.source === 'n8n-post';
    const hasWorkflowPredictionShape =
      pp != null &&
      typeof pp === 'object' &&
      ('postMeta' in pp ||
        'visualType' in pp ||
        'slides' in pp ||
        pp.source === 'n8n-post');
    const tiedToGenerationJob = Boolean(item.job_id);
    const hasOurDeterministicLead = /^[✨🚀⚡]\s/.test(body.trim());
    // Run once for pipeline output: markdown/news cues, n8n metadata, or any row tied to a generation job.
    const eligibleForPipelineRefinement =
      !hasOurDeterministicLead &&
      (fromN8nPost || hasWorkflowPredictionShape || tiedToGenerationJob);
    const needsRefinement =
      hasN8nStyleMarkdownLink ||
      hasLegacyWatermark ||
      looksLikeNewsAttribution ||
      eligibleForPipelineRefinement;
    if (!needsRefinement) return item;

    const postMeta = pp?.postMeta as Record<string, unknown> | undefined;

    const refined = await this.postRefinementService.refine({
      platform: 'linkedin',
      content: {
        title,
        content: body,
        hashtags: Array.isArray(item.hashtags)
          ? item.hashtags.map((h: unknown) => String(h))
          : [],
        postType:
          String(item.visual_type || '').toLowerCase() === 'carousel'
            ? MediaPostType.CAROUSEL
            : MediaPostType.SINGLE,
      },
      sourceUrl:
        (typeof postMeta?.link === 'string' ? postMeta.link : undefined) ||
        (typeof pp?.sourceLink === 'string' ? pp.sourceLink : undefined) ||
        undefined,
    });

    const updated = await this.generatedContentRepository.updateContent(item.id, {
      title: refined.title,
      content: refined.content,
      hashtags: refined.hashtags,
      performance_prediction: mergePerformancePredictionWithRefinementApplied(pp),
    });
    return updated;
  }
}
