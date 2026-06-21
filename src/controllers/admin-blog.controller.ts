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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { BlogManagementGuard } from '../guards/blog-management.guard';
import { BlogService } from '../services/blog.service';
import type { AuthenticatedRequest } from '../guards/auth.guard';

@ApiTags('admin-blog')
@Controller('admin/blog')
@ApiBearerAuth()
export class AdminBlogController {
  private readonly logger = new Logger(AdminBlogController.name);

  constructor(private readonly blogService: BlogService) {}

  @Get('posts')
  @UseGuards(AuthGuard, PaywallGuard, BlogManagementGuard)
  @ApiOperation({ summary: 'List posts (all statuses) for CMS' })
  async list(@Query('status') status?: string, @Query('q') q?: string) {
    try {
      return await this.blogService.listAdminPosts({ status, q });
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed to list',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('posts/:id')
  @UseGuards(AuthGuard, PaywallGuard, BlogManagementGuard)
  @ApiOperation({ summary: 'Get one post for editing' })
  async one(@Param('id') id: string) {
    try {
      return await this.blogService.getAdminPost(id);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Not found',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('posts')
  @UseGuards(AuthGuard, PaywallGuard, BlogManagementGuard)
  @ApiOperation({
    summary: 'Create post (path = parent.path/slug when parent_id set)',
  })
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      return await this.blogService.createPost(req.user!.id, body as any);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Create failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch('posts/:id')
  @UseGuards(AuthGuard, PaywallGuard, BlogManagementGuard)
  @ApiOperation({ summary: 'Update post (slug/parent immutable after create)' })
  async patch(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    try {
      return await this.blogService.updatePost(id, body);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Update failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete('posts/:id')
  @UseGuards(AuthGuard, PaywallGuard, BlogManagementGuard)
  @ApiOperation({ summary: 'Delete post (cascades to child posts)' })
  async remove(@Param('id') id: string) {
    try {
      return await this.blogService.deletePost(id);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Delete failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('editors')
  @UseGuards(AuthGuard, PaywallGuard, AdminGuard)
  @ApiOperation({ summary: 'List blog editor grants (platform admin only)' })
  async editors() {
    try {
      return await this.blogService.listEditors();
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('editors')
  @UseGuards(AuthGuard, PaywallGuard, AdminGuard)
  @ApiOperation({ summary: 'Grant blog editor role to a user id' })
  async grant(
    @Req() req: AuthenticatedRequest,
    @Body() body: { user_id?: string },
  ) {
    try {
      if (!body.user_id?.trim()) {
        throw new HttpException('user_id required', HttpStatus.BAD_REQUEST);
      }
      return await this.blogService.grantEditor(
        req.user!.id,
        body.user_id.trim(),
      );
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Grant failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete('editors/:userId')
  @UseGuards(AuthGuard, PaywallGuard, AdminGuard)
  @ApiOperation({ summary: 'Revoke blog editor' })
  async revoke(@Param('userId') userId: string) {
    try {
      return await this.blogService.revokeEditor(userId);
    } catch (e: any) {
      this.logger.error(e?.message);
      throw new HttpException(
        e.message || 'Revoke failed',
        e.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
