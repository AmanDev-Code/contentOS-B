import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { ContentEngineService } from '../services/content-engine.service';

@ApiTags('content-engine')
@Controller('admin/content-engine')
@ApiBearerAuth()
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
export class ContentEngineController {
  private readonly logger = new Logger(ContentEngineController.name);

  constructor(private readonly contentEngine: ContentEngineService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Content Engine dashboard stats' })
  async dashboard() {
    try {
      return await this.contentEngine.getDashboardStats();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('generate-plan')
  @ApiOperation({ summary: 'Generate AI content plan from keyword research' })
  async generatePlan(@Body() body: Record<string, any>) {
    try {
      return await this.contentEngine.generatePlan(body as any);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('generate-article')
  @ApiOperation({ summary: 'Generate full article from approved plan' })
  async generateArticle(@Body() body: Record<string, any>) {
    try {
      return await this.contentEngine.generateArticle(body.plan, body.input);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('generate-distribution')
  @ApiOperation({ summary: 'Generate platform-adapted content for a post' })
  async generateDistribution(
    @Body() body: { post_id: string; platform: string },
  ) {
    try {
      return await this.contentEngine.generateDistribution(
        body.post_id,
        body.platform,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- Clusters ---

  @Get('clusters')
  @ApiOperation({ summary: 'List content clusters' })
  async listClusters() {
    try {
      return await this.contentEngine.listClusters();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('clusters')
  @ApiOperation({ summary: 'Create content cluster' })
  async createCluster(
    @Body()
    body: {
      name: string;
      pillar_keyword: string;
      description?: string;
    },
  ) {
    try {
      return await this.contentEngine.createCluster(body);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('clusters/:id')
  @ApiOperation({ summary: 'Get cluster with articles' })
  async getCluster(@Param('id') id: string) {
    try {
      return await this.contentEngine.getCluster(id);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('clusters/:id/generate')
  @ApiOperation({ summary: 'AI generate cluster article suggestions' })
  async generateClusterSuggestions(@Param('id') id: string) {
    try {
      return await this.contentEngine.generateClusterSuggestions(id);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- Distributions ---

  @Get('distributions/:postId')
  @ApiOperation({ summary: 'Get distributions for a post' })
  async getDistributions(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.getDistributions(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('distributions/:postId/:platform')
  @ApiOperation({ summary: 'Generate/update distribution for a platform' })
  async generatePlatformDistribution(
    @Param('postId') postId: string,
    @Param('platform') platform: string,
  ) {
    try {
      return await this.contentEngine.generateDistribution(postId, platform);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- Scores ---

  @Get('scores/:postId')
  @ApiOperation({ summary: 'Get quality scores for a post' })
  async getScores(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.getScores(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('scores/:postId/calculate')
  @ApiOperation({ summary: 'Recalculate quality scores for a post' })
  async calculateScores(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.calculateScores(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- Platform Accounts ---

  @Get('platform-accounts/linkedin-status')
  @ApiOperation({
    summary: 'LinkedIn OAuth status for Content Engine distribution',
  })
  async getLinkedInOAuthStatus(@Request() req: { user?: { id: string } }) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('User ID not found', HttpStatus.UNAUTHORIZED);
    }
    try {
      return await this.contentEngine.getLinkedInOAuthStatus(userId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('platform-accounts/linkedin/enable')
  @ApiOperation({
    summary: 'Enable Content Engine LinkedIn distribution via Trndinn OAuth',
  })
  async enableLinkedInOAuthDistribution(
    @Request() req: { user?: { id: string } },
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('User ID not found', HttpStatus.UNAUTHORIZED);
    }
    try {
      return await this.contentEngine.enableLinkedInOAuthDistribution(userId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('platform-accounts')
  @ApiOperation({ summary: 'List all platform accounts' })
  async listPlatformAccounts() {
    try {
      return await this.contentEngine.listPlatformAccounts();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('platform-accounts')
  @ApiOperation({ summary: 'Create or update a platform account' })
  async upsertPlatformAccount(
    @Request() req: { user?: { id: string } },
    @Body() body: Record<string, any>,
  ) {
    try {
      return await this.contentEngine.upsertPlatformAccount(
        body.platform,
        {
          account_name: body.account_name,
          credentials: body.credentials,
          notes: body.notes,
        },
        req.user?.id,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('platform-accounts/:platform/test')
  @ApiOperation({ summary: 'Test platform connection' })
  async testPlatformConnection(@Param('platform') platform: string) {
    try {
      return await this.contentEngine.testPlatformConnection(platform);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete('platform-accounts/:platform')
  @ApiOperation({ summary: 'Remove a platform account' })
  async deletePlatformAccount(@Param('platform') platform: string) {
    try {
      return await this.contentEngine.deletePlatformAccount(platform);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- Enhanced Distributions ---

  @Post('distributions/:postId/generate-all')
  @ApiOperation({ summary: 'Generate content for all connected platforms' })
  async generateAllDistributions(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.generateAllPlatformContent(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('distributions/:postId/:platform/generate')
  @ApiOperation({ summary: 'Generate content for a specific platform' })
  async generateSingleDistribution(
    @Param('postId') postId: string,
    @Param('platform') platform: string,
  ) {
    try {
      return await this.contentEngine.generateDistribution(postId, platform);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('distributions/:postId/:platform/publish')
  @ApiOperation({ summary: 'Auto-publish content to platform' })
  async publishDistribution(
    @Param('postId') postId: string,
    @Param('platform') platform: string,
  ) {
    try {
      return await this.contentEngine.publishToPlatform(postId, platform);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch('distributions/:postId/:platform')
  @ApiOperation({
    summary: 'Update distribution (mark published, edit content)',
  })
  async updateDistribution(
    @Param('postId') postId: string,
    @Param('platform') platform: string,
    @Body() body: Record<string, any>,
  ) {
    try {
      if (body.published_url && body.status === 'published') {
        return await this.contentEngine.markAsPublished(
          postId,
          platform,
          body.published_url,
        );
      }
      return await this.contentEngine.updateDistribution(
        postId,
        platform,
        body,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- Internal Links ---

  @Get('internal-links/stats')
  @ApiOperation({ summary: 'Get internal link stats for dashboard' })
  async getInternalLinkStats() {
    try {
      return await this.contentEngine.getPostLinkStats();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('internal-links/:postId/analyze')
  @ApiOperation({
    summary: 'Analyze and generate internal link suggestions for a post',
  })
  async analyzeLinkOpportunities(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.analyzeLinkOpportunities(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('internal-links/:postId')
  @ApiOperation({ summary: 'Get internal link suggestions for a post' })
  async getInternalLinks(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.getInternalLinks(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch('internal-links/:id/accept')
  @ApiOperation({ summary: 'Accept an internal link suggestion' })
  async acceptLinkSuggestion(@Param('id') id: string) {
    try {
      return await this.contentEngine.acceptLinkSuggestion(id);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch('internal-links/:id/reject')
  @ApiOperation({ summary: 'Reject an internal link suggestion' })
  async rejectLinkSuggestion(@Param('id') id: string) {
    try {
      return await this.contentEngine.rejectLinkSuggestion(id);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('internal-links/:postId/insert')
  @ApiOperation({ summary: 'Insert all accepted links into post body' })
  async insertAcceptedLinks(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.insertAcceptedLinks(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- Image Engine ---

  @Post('images/:postId/plan')
  @ApiOperation({ summary: 'Generate image plan for a post' })
  async generateImagePlan(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.generateImagePlan(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('images/:postId')
  @ApiOperation({ summary: 'Get image plan for a post' })
  async getImagePlan(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.getImagePlan(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('images/:imageId/generate')
  @ApiOperation({ summary: 'Generate a single image from its prompt' })
  async generateImage(@Param('imageId') imageId: string) {
    try {
      return await this.contentEngine.generateImage(imageId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch('images/:imageId/approve')
  @ApiOperation({ summary: 'Approve a generated image' })
  async approveImage(@Param('imageId') imageId: string) {
    try {
      return await this.contentEngine.approveImage(imageId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch('images/:imageId/reject')
  @ApiOperation({ summary: 'Reject a generated image' })
  async rejectImage(@Param('imageId') imageId: string) {
    try {
      return await this.contentEngine.rejectImage(imageId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('images/:postId/insert')
  @ApiOperation({ summary: 'Insert approved images into post body' })
  async insertImagesIntoPost(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.insertImagesIntoPost(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- Schema Engine ---

  @Post('schemas/:postId/generate')
  @ApiOperation({ summary: 'Generate JSON-LD schemas for a post' })
  async generateSchemas(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.generateSchemas(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('schemas/:postId')
  @ApiOperation({ summary: 'Get generated schemas for a post' })
  async getSchemas(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.getSchemas(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- AEO & GEO Optimization ---

  @Get('optimize/:postId/aeo')
  @ApiOperation({ summary: 'Analyze post for Answer Engine Optimization' })
  async analyzeAEO(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.analyzeAEO(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('optimize/:postId/geo')
  @ApiOperation({ summary: 'Analyze post for Generative Engine Optimization' })
  async analyzeGEO(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.analyzeGEO(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('optimize/:postId/report')
  @ApiOperation({ summary: 'Get combined AEO + GEO optimization report' })
  async getOptimizationReport(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.getOptimizationReport(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('optimize/:postId/aeo/generate')
  @ApiOperation({ summary: 'Generate AEO improvement suggestions' })
  async generateAEOImprovements(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.generateAEOImprovements(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('optimize/:postId/geo/generate')
  @ApiOperation({ summary: 'Generate GEO improvement suggestions' })
  async generateGEOImprovements(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.generateGEOImprovements(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('optimize/:postId/aeo/apply')
  @ApiOperation({ summary: 'Apply full AEO optimization to post body' })
  async applyAEOOptimization(
    @Param('postId') postId: string,
    @Body() body: { optimized_body: string },
  ) {
    try {
      return await this.contentEngine.applyAEOOptimization(
        postId,
        body.optimized_body,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('optimize/:postId/geo/apply')
  @ApiOperation({ summary: 'Apply full GEO optimization to post body' })
  async applyGEOOptimization(
    @Param('postId') postId: string,
    @Body() body: { optimized_body: string },
  ) {
    try {
      return await this.contentEngine.applyGEOOptimization(
        postId,
        body.optimized_body,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('optimize/:postId/apply')
  @ApiOperation({ summary: 'Apply selected optimizations to post' })
  async applyOptimizations(
    @Param('postId') postId: string,
    @Body()
    body: {
      optimizations: {
        type: string;
        content: string;
        position: 'top' | 'bottom' | 'after_intro';
      }[];
    },
  ) {
    try {
      return await this.contentEngine.applyOptimizations(
        postId,
        body.optimizations,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('optimize/:postId/seo')
  @ApiOperation({ summary: 'Analyze post for Search Engine Optimization' })
  async analyzeSEO(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.analyzeSEO(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('optimize/:postId/generate-versions')
  @ApiOperation({ summary: 'Generate 2 optimized full-article variants' })
  async generateOptimizedVersions(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.generateOptimizedVersions(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('optimize/:postId/apply-version')
  @ApiOperation({ summary: 'Apply selected optimized version to post' })
  async applyOptimizedVersion(
    @Param('postId') postId: string,
    @Body() body: { content: string },
  ) {
    try {
      return await this.contentEngine.applyOptimizedVersion(
        postId,
        body.content,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- Rank Tracking ---

  @Post('rankings/track')
  @ApiOperation({ summary: 'Record a keyword ranking' })
  async trackKeywordRanking(
    @Body()
    body: {
      keyword_id: string;
      position: number;
      search_engine?: string;
      country?: string;
      post_id?: string;
    },
  ) {
    try {
      return await this.contentEngine.trackKeywordRanking(
        body.keyword_id,
        body.position,
        body.search_engine,
        body.country,
        body.post_id,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('rankings/:keywordId')
  @ApiOperation({ summary: 'Get ranking history for a keyword' })
  async getKeywordRankings(@Param('keywordId') keywordId: string) {
    try {
      return await this.contentEngine.getKeywordRankings(keywordId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('rankings/overview')
  @ApiOperation({ summary: 'Get ranking overview stats' })
  async getRankingOverview() {
    try {
      return await this.contentEngine.getRankingOverview();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('rankings/movers')
  @ApiOperation({ summary: 'Get top ranking movers (gainers and losers)' })
  async getTopMovers() {
    try {
      return await this.contentEngine.getTopMovers();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('rankings/check')
  @ApiOperation({ summary: 'Check rankings (placeholder for API integration)' })
  async checkRankings() {
    try {
      return await this.contentEngine.checkRankings();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- Backlink Profiles ---

  @Get('backlinks/profiles')
  @ApiOperation({ summary: 'List all backlink profiles' })
  async listBacklinkProfiles() {
    try {
      return await this.contentEngine.listBacklinkProfiles();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('backlinks/profiles')
  @ApiOperation({ summary: 'Create a backlink profile' })
  async createBacklinkProfile(
    @Body()
    body: {
      platform: string;
      profile_url?: string;
      status?: string;
      domain_authority?: number;
      notes?: string;
    },
  ) {
    try {
      return await this.contentEngine.createBacklinkProfile(body);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch('backlinks/profiles/:id')
  @ApiOperation({ summary: 'Update a backlink profile' })
  async updateBacklinkProfile(
    @Param('id') id: string,
    @Body()
    body: {
      platform?: string;
      profile_url?: string;
      status?: string;
      domain_authority?: number;
      notes?: string;
    },
  ) {
    try {
      return await this.contentEngine.updateBacklinkProfile(id, body);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- Backlink Opportunities ---

  @Get('backlinks/opportunities')
  @ApiOperation({ summary: 'List backlink opportunities' })
  async listBacklinkOpportunities(
    @Query('status') status?: string,
    @Query('opportunity_type') opportunityType?: string,
  ) {
    try {
      return await this.contentEngine.listBacklinkOpportunities({
        status,
        opportunity_type: opportunityType,
      });
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('backlinks/opportunities')
  @ApiOperation({ summary: 'Create a backlink opportunity' })
  async createBacklinkOpportunity(
    @Body()
    body: {
      source_domain: string;
      source_url?: string;
      opportunity_type?: string;
      target_post_id?: string;
      status?: string;
      domain_authority?: number;
      contact_email?: string;
      notes?: string;
    },
  ) {
    try {
      return await this.contentEngine.createBacklinkOpportunity(body);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch('backlinks/opportunities/:id')
  @ApiOperation({ summary: 'Update a backlink opportunity' })
  async updateBacklinkOpportunity(
    @Param('id') id: string,
    @Body()
    body: {
      source_domain?: string;
      source_url?: string;
      opportunity_type?: string;
      target_post_id?: string;
      status?: string;
      domain_authority?: number;
      contact_email?: string;
      notes?: string;
      outreach_sent_at?: string;
      acquired_at?: string;
    },
  ) {
    try {
      return await this.contentEngine.updateBacklinkOpportunity(id, body);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('backlinks/stats')
  @ApiOperation({ summary: 'Get backlink stats' })
  async getBacklinkStats() {
    try {
      return await this.contentEngine.getBacklinkStats();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('backlinks/suggest/:postId')
  @ApiOperation({ summary: 'AI suggest backlink opportunities for a post' })
  async suggestBacklinkOpportunities(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.suggestBacklinkOpportunities(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // --- Blog AI Helpers ---

  @Post('generate-title')
  @ApiOperation({ summary: 'Generate blog title from keyword' })
  async generateTitle(@Body() body: { keyword: string }) {
    try {
      return await this.contentEngine.generateTitle(body.keyword);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('generate-excerpt')
  @ApiOperation({ summary: 'Generate excerpt from body content' })
  async generateExcerpt(@Body() body: { body: string }) {
    try {
      return await this.contentEngine.generateExcerpt(body.body);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('enhance-content')
  @ApiOperation({ summary: 'Enhance body content with AI' })
  async enhanceContent(@Body() body: { body: string; instructions?: string }) {
    try {
      return await this.contentEngine.enhanceContent(
        body.body,
        body.instructions,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('generate-faq')
  @ApiOperation({ summary: 'Generate FAQ from body content' })
  async generateFAQ(@Body() body: { body: string }) {
    try {
      return await this.contentEngine.generateFAQ(body.body);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('generate-seo')
  @ApiOperation({ summary: 'Generate SEO metadata from title and body' })
  async generateSEO(
    @Body() body: { title: string; body: string; keyword?: string },
  ) {
    try {
      return await this.contentEngine.generateSEO(
        body.title,
        body.body,
        body.keyword,
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('optimize/:postId/generate-seo-meta')
  @ApiOperation({
    summary:
      'Generate optimized SEO metadata with OG image for a blog post',
  })
  async generateSEOMetaWithOG(@Param('postId') postId: string) {
    try {
      return await this.contentEngine.generateSEOMetadataWithOG(postId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
