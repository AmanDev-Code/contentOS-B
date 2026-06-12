import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../guards/api-key-auth.guard';
import { RequireApiScope } from '../../decorators/api-scope.decorator';
import {
  ApiV1PostsService,
  type ApiPostType,
} from '../../services/api-v1-posts.service';

interface ApiAuthedRequest {
  user: { id: string };
}

interface CreatePostBody {
  type: ApiPostType;
  content: string;
  title?: string;
  hashtags?: string[];
  mediaUrls?: string[];
  carouselUrls?: string[];
  pdfUrl?: string;
  scheduledFor?: string;
  platform?: string;
  actorType?: 'member' | 'organization';
  organizationUrn?: string;
}

/**
 * Public API v1 — Posts. Authenticated via `Authorization: Bearer trnd_*`.
 * Wired to the existing publish pipeline (Sprint 1.4) through ApiV1PostsService.
 */
@ApiTags('public-api-v1')
@ApiBearerAuth()
@Controller('api/v1/posts')
@UseGuards(ApiKeyAuthGuard)
export class PostsV1Controller {
  private readonly logger = new Logger(PostsV1Controller.name);

  constructor(private readonly postsService: ApiV1PostsService) {}

  @Post()
  @RequireApiScope('posts:write')
  @ApiOperation({ summary: 'Create a post (publish now or schedule)' })
  async create(
    @Request() req: ApiAuthedRequest,
    @Body() body: CreatePostBody,
  ) {
    try {
      return await this.postsService.createPost({
        userId: req.user.id,
        type: body.type,
        content: body.content,
        title: body.title,
        hashtags: body.hashtags,
        mediaUrls: body.mediaUrls,
        carouselUrls: body.carouselUrls,
        pdfUrl: body.pdfUrl,
        scheduledFor: body.scheduledFor,
        platform: body.platform,
        actorType: body.actorType,
        organizationUrn: body.organizationUrn,
      });
    } catch (error) {
      throw this.toHttp(error, 'Failed to create post');
    }
  }

  @Get()
  @RequireApiScope('posts:read')
  @ApiOperation({ summary: 'List posts / check status' })
  async list(
    @Request() req: ApiAuthedRequest,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      return await this.postsService.listPosts({
        userId: req.user.id,
        status,
        page: page ? parseInt(page, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
    } catch (error) {
      throw this.toHttp(error, 'Failed to list posts');
    }
  }

  @Delete(':id')
  @RequireApiScope('posts:write')
  @ApiOperation({ summary: 'Cancel a scheduled post' })
  async cancel(@Request() req: ApiAuthedRequest, @Param('id') id: string) {
    try {
      return await this.postsService.cancelPost(req.user.id, id);
    } catch (error) {
      throw this.toHttp(error, 'Failed to cancel post');
    }
  }

  private toHttp(error: unknown, fallback: string): HttpException {
    if (error instanceof HttpException) return error;
    this.logger.error(`${fallback}: ${(error as Error)?.message}`);
    return new HttpException(
      (error as Error)?.message || fallback,
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
