import {
  Controller,
  Get,
  Query,
  Put,
  Body,
  Param,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { UserRateLimitGuard } from '../guards/user-rate-limit.guard';
import { SupabaseService } from '../services/supabase.service';
import { TrendingHashtagEngineService } from '../services/trending-hashtag-engine.service';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
  };
}

@Controller('content')
@UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
export class ContentController {
  private readonly logger = new Logger(ContentController.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly trendingHashtagEngineService: TrendingHashtagEngineService,
  ) {}

  @Get('trending')
  async getTrendingHashtags(
    @Query('tag') tag?: string | string[],
    @Query('limit') limit?: string | string[],
    @Query('offset') offset?: string | string[],
  ) {
    const first = (v: string | string[] | undefined, fallback: string) => {
      if (Array.isArray(v)) return v[0] ?? fallback;
      return v ?? fallback;
    };
    const tagStr = first(tag, '').trim();
    const parsedLimit = Number(first(limit as any, '20'));
    const parsedOffset = Number(first(offset as any, '0'));
    const safeLimit =
      Number.isFinite(parsedLimit) && parsedLimit >= 1
        ? Math.min(Math.floor(parsedLimit), 100)
        : 20;
    const safeOffset =
      Number.isFinite(parsedOffset) && parsedOffset >= 0
        ? Math.min(Math.floor(parsedOffset), 100_000)
        : 0;
    const data = await this.trendingHashtagEngineService.getTrendingPaged(
      tagStr || undefined,
      safeLimit,
      safeOffset,
    );

    return {
      success: true,
      data,
    };
  }

  @Get('trending/debug')
  async getTrendingDebug(
    @Query('tag') tag?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Number(limit || '20');
    const data = await this.trendingHashtagEngineService.getTrendingDebug(
      tag,
      Number.isFinite(parsedLimit) ? parsedLimit : 20,
    );
    return {
      success: true,
      data,
    };
  }

  @Put(':id')
  async updateContent(
    @Request() req: AuthenticatedRequest,
    @Param('id') contentId: string,
    @Body() body: { content?: string; hashtags?: string[] },
  ) {
    try {
      const userId = req.user.id;

      // Verify ownership
      const { data: existingContent, error: fetchError } =
        await this.supabaseService
          .getServiceClient()
          .from('generated_content')
          .select('user_id')
          .eq('id', contentId)
          .single();

      if (fetchError || !existingContent) {
        throw new HttpException('Content not found', HttpStatus.NOT_FOUND);
      }

      if (existingContent.user_id !== userId) {
        throw new HttpException('Unauthorized', HttpStatus.FORBIDDEN);
      }

      // Update content
      const updateData: any = {};
      if (body.content !== undefined) {
        updateData.content = body.content;
      }
      if (body.hashtags !== undefined) {
        updateData.hashtags = body.hashtags;
      }

      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('generated_content')
        .update(updateData)
        .eq('id', contentId)
        .select()
        .single();

      if (error) {
        throw new HttpException(
          'Failed to update content',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        data,
      };
    } catch (error) {
      this.logger.error('Failed to update content:', error.message);
      throw new HttpException(
        error.message || 'Failed to update content',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
