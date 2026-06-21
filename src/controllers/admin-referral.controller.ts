import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Multer } from 'multer';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiQuery,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { AdminGuard } from '../guards/admin.guard';
import {
  ReferralService,
  ReferralSettings,
  ReferralBanner,
} from '../services/referral.service';
import { MinioService } from '../services/minio.service';

@ApiTags('admin-referral')
@Controller('admin/referral')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
@ApiBearerAuth()
export class AdminReferralController {
  constructor(
    private readonly referralService: ReferralService,
    private readonly minioService: MinioService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('settings')
  @ApiOperation({ summary: 'Get current referral program settings' })
  async getSettings() {
    try {
      const settings = await this.referralService.getSettings();
      return { success: true, data: settings };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to fetch settings',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Put('settings')
  @ApiOperation({ summary: 'Update referral program settings' })
  async updateSettings(
    @Body() body: Partial<Omit<ReferralSettings, 'id' | 'updated_at'>>,
  ) {
    // Validate inputs
    if (body.credits_per_referral !== undefined) {
      if (
        !Number.isInteger(body.credits_per_referral) ||
        body.credits_per_referral < 0
      ) {
        throw new HttpException(
          'credits_per_referral must be a non-negative integer',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    if (body.min_actions_to_complete !== undefined) {
      if (
        !Number.isInteger(body.min_actions_to_complete) ||
        body.min_actions_to_complete < 1
      ) {
        throw new HttpException(
          'min_actions_to_complete must be a positive integer',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    try {
      const settings = await this.referralService.updateSettings(body);
      return { success: true, data: settings };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to update settings',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BANNERS
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('banners')
  @ApiOperation({ summary: 'List all referral banners' })
  async listBanners() {
    try {
      const banners = await this.referralService.getAllBanners();
      return { success: true, data: banners };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to fetch banners',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('banners')
  @ApiOperation({ summary: 'Create a new referral banner' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        link_url: { type: 'string' },
        is_active: { type: 'boolean' },
        display_order: { type: 'number' },
        image: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(FileInterceptor('image'))
  async createBanner(
    @UploadedFile() file: Multer.File,
    @Body()
    body: {
      title: string;
      link_url?: string;
      is_active?: string;
      display_order?: string;
    },
  ) {
    if (!body.title?.trim()) {
      throw new HttpException('title is required', HttpStatus.BAD_REQUEST);
    }

    let imageUrl: string;

    if (file) {
      // Upload image to MinIO
      try {
        const fileName = `referral-banners/${Date.now()}-${file.originalname}`;
        await this.minioService.uploadFile(
          'contentos-media',
          fileName,
          file.buffer,
          file.mimetype,
        );
        imageUrl = await this.minioService.getPublicUrl(
          'contentos-media',
          fileName,
        );
      } catch (error) {
        throw new HttpException(
          'Failed to upload image',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    } else if ((body as any).image_url) {
      imageUrl = (body as any).image_url;
    } else {
      throw new HttpException('image is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const banner = await this.referralService.createBanner({
        title: body.title.trim(),
        image_url: imageUrl,
        link_url: body.link_url?.trim() || null,
        is_active: body.is_active === 'true' || body.is_active === undefined,
        display_order: body.display_order
          ? parseInt(body.display_order, 10)
          : 0,
      });
      return { success: true, data: banner };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to create banner',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Put('banners/:id')
  @ApiOperation({ summary: 'Update a referral banner' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image'))
  async updateBanner(
    @Param('id') id: string,
    @UploadedFile() file: Multer.File,
    @Body()
    body: Partial<{
      title: string;
      link_url: string;
      is_active: string;
      display_order: string;
      image_url: string;
    }>,
  ) {
    const updates: Partial<
      Omit<ReferralBanner, 'id' | 'created_at' | 'updated_at'>
    > = {};

    if (body.title !== undefined) {
      updates.title = body.title.trim();
    }

    if (body.link_url !== undefined) {
      updates.link_url = body.link_url.trim() || null;
    }

    if (body.is_active !== undefined) {
      updates.is_active = body.is_active === 'true';
    }

    if (body.display_order !== undefined) {
      updates.display_order = parseInt(body.display_order, 10);
    }

    if (file) {
      try {
        const fileName = `referral-banners/${Date.now()}-${file.originalname}`;
        await this.minioService.uploadFile(
          'contentos-media',
          fileName,
          file.buffer,
          file.mimetype,
        );
        updates.image_url = await this.minioService.getPublicUrl(
          'contentos-media',
          fileName,
        );
      } catch (error) {
        throw new HttpException(
          'Failed to upload image',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    } else if (body.image_url) {
      updates.image_url = body.image_url;
    }

    try {
      const banner = await this.referralService.updateBanner(id, updates);
      return { success: true, data: banner };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to update banner',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('banners/:id')
  @ApiOperation({ summary: 'Delete a referral banner' })
  async deleteBanner(@Param('id') id: string) {
    try {
      await this.referralService.deleteBanner(id);
      return { success: true };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to delete banner',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('banners/reorder')
  @ApiOperation({ summary: 'Reorder banners' })
  async reorderBanners(
    @Body() body: { orders: { id: string; display_order: number }[] },
  ) {
    if (!Array.isArray(body.orders) || body.orders.length === 0) {
      throw new HttpException(
        'orders must be a non-empty array',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      await this.referralService.reorderBanners(body.orders);
      const banners = await this.referralService.getAllBanners();
      return { success: true, data: banners };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to reorder banners',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('stats')
  @ApiOperation({ summary: 'Get overall referral program stats' })
  async getStats() {
    try {
      const analytics = await this.referralService.getAdminAnalytics();
      return { success: true, data: analytics };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to fetch stats',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('top-referrers')
  @ApiOperation({ summary: 'Get top referrers leaderboard' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getTopReferrers(@Query('limit') limit?: string) {
    try {
      const topReferrers = await this.referralService.getTopReferrers(
        limit ? parseInt(limit, 10) : 10,
      );
      return { success: true, data: topReferrers };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to fetch top referrers',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get referral info for a specific user' })
  async getUserReferralInfo(@Param('userId') userId: string) {
    try {
      const info = await this.referralService.getUserReferralInfo(userId);
      return { success: true, data: info };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to fetch user referral info',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CODES MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('codes')
  @ApiOperation({ summary: 'List all referral codes with pagination' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['active', 'inactive', 'all'],
  })
  async listCodes(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: 'active' | 'inactive' | 'all',
  ) {
    try {
      const result = await this.referralService.getAllCodes({
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 20,
        search,
        status,
      });
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to fetch codes',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Patch('codes/:id')
  @ApiOperation({ summary: 'Update a referral code (toggle active status)' })
  async updateCode(
    @Param('id') id: string,
    @Body() body: { is_active?: boolean },
  ) {
    try {
      const code = await this.referralService.updateCode(id, body);
      return { success: true, data: code };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to update code',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('codes/:id')
  @ApiOperation({ summary: 'Delete a referral code' })
  async deleteCode(@Param('id') id: string) {
    try {
      await this.referralService.deleteCode(id);
      return { success: true };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to delete code',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('codes')
  @ApiOperation({ summary: 'Create a referral code for a specific user' })
  async createCode(@Body() body: { user_id: string }) {
    if (!body.user_id) {
      throw new HttpException('user_id is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const code = await this.referralService.createCodeForUser(body.user_id);
      return { success: true, data: code };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to create code',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
