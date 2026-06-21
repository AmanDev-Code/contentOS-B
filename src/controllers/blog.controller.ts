import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BlogService } from '../services/blog.service';
import { AuthGuard } from '../guards/auth.guard';
import type { AuthenticatedRequest } from '../guards/auth.guard';

@ApiTags('blog')
@Controller('blog')
export class BlogController {
  private readonly logger = new Logger(BlogController.name);

  constructor(private readonly blogService: BlogService) {}

  @Get('posts')
  @ApiOperation({ summary: 'List published (or due scheduled) blog posts' })
  async listPosts(
    @Query('post_kind') post_kind?: string,
    @Query('tag') tag?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    try {
      return await this.blogService.listPublishedPosts({
        post_kind,
        tag,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      });
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed to list posts',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('sitemap-paths')
  @ApiOperation({
    summary:
      'All published post paths + timestamps for sitemap generation (no pagination cap)',
  })
  async sitemapPaths() {
    try {
      return await this.blogService.listAllPublishedPathsForSitemap();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed to list sitemap paths',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('post')
  @ApiOperation({
    summary: 'Get a single published post by path (e.g. releases/v2)',
  })
  async getPost(@Query('path') path: string) {
    try {
      if (!path?.trim()) {
        throw new HttpException('path query required', HttpStatus.BAD_REQUEST);
      }
      return await this.blogService.getPublishedPostByPath(path);
    } catch (e: any) {
      if (e.status === 404) throw e;
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed to load post',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('page-seo')
  @ApiOperation({
    summary:
      'Public SEO for a marketing route: CMS overrides (static_page_seo) plus primary keyword assignment',
  })
  async pageSeo(@Query('route') route: string) {
    try {
      if (!route?.trim()) {
        return {};
      }
      return await this.blogService.getPublicPageSeoPayload(route);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed to load SEO',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('my-access')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Whether the signed-in user may manage blog posts' })
  async myAccess(@Req() req: AuthenticatedRequest) {
    const user = req.user!;
    return {
      canManageBlog: await this.blogService.isBlogEditorOrAdmin(user),
      isPlatformAdmin: this.blogService.isPlatformAdminUser(user),
    };
  }
}
