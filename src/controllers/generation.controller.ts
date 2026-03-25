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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { GenerationService } from '../services/generation.service';
import { GeneratedContentRepository } from '../repositories/generated-content.repository';
import { CacheService } from '../services/cache.service';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';

@ApiTags('generation')
@Controller('generation')
@UseGuards(AuthGuard, PaywallGuard)
@ApiBearerAuth()
export class GenerationController {
  constructor(
    private generationService: GenerationService,
    private generatedContentRepository: GeneratedContentRepository,
    private cacheService: CacheService,
  ) {}

  @Post('start')
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
  ) {
    const userId = req.user?.id || 'c9327732-05cd-41dc-9d4f-e0c17b7fbea3';
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20)); // Max 50 per page
    const offset = (pageNum - 1) * limitNum;

    const [content, totalCount] = await Promise.all([
      this.generatedContentRepository.findByUserId(userId, limitNum, offset),
      this.generatedContentRepository.countByUserId(userId),
    ]);

    const totalPages = Math.ceil(totalCount / limitNum);

    return {
      data: content,
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
  async getContent(@Param('contentId') contentId: string) {
    return this.generatedContentRepository.findById(contentId);
  }

  @Get('job/:jobId/content')
  @ApiOperation({ summary: 'Get content by job ID' })
  async getContentByJobId(@Param('jobId') jobId: string) {
    return this.generatedContentRepository.findByJobId(jobId);
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

    const totalPages = Math.ceil(totalCount / limitNum);

    return {
      data: content,
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
}
