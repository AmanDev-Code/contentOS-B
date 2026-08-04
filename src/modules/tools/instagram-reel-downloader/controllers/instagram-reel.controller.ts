import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
  ServiceUnavailableException,
  BadRequestException,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { ToolRateLimitGuard } from '../../../../guards/tool-rate-limit.guard';
import { ToolCategoryMeta } from '../../../../decorators/tool-category.decorator';
import { InstagramReelService, InstagramFetchError } from '../services/instagram-reel.service';
import {
  InstagramReelDownloadSchema,
  InstagramReelDownloadBodyDto,
} from '../dto/instagram-reel.dto';
import { isToolActive } from '../../registry/tool-registry';
import type { ToolResponse } from '../../registry/tool.types';
import type { InstagramReelResult } from '../types';

@ApiTags('Tools')
@Controller('api/tools/instagram-reel-downloader')
export class InstagramReelController {
  private readonly logger = new Logger(InstagramReelController.name);

  constructor(private readonly instagramReelService: InstagramReelService) {}

  @Post('download')
  @HttpCode(HttpStatus.OK)
  @ToolCategoryMeta('utility')
  @UseGuards(ToolRateLimitGuard)
  @ApiOperation({
    summary: 'Download Instagram Reel',
    description:
      'Fetches the direct video URL for an Instagram Reel. No authentication required. Rate limited to 60 requests/hour per IP.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          example: 'https://www.instagram.com/reel/ABC123/',
          description: 'Instagram Reel, Post, or Share URL',
        },
      },
      required: ['url'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Reel video URL retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            videoUrl: { type: 'string' },
            thumbnailUrl: { type: 'string', nullable: true },
            width: { type: 'number', example: 1080 },
            height: { type: 'number', example: 1920 },
            caption: { type: 'string', nullable: true },
            author: { type: 'string', nullable: true },
            duration: { type: 'number', nullable: true },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid Instagram URL' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  @ApiResponse({
    status: 503,
    description: 'Instagram service unavailable or blocking requests',
  })
  async downloadInstagramReel(
    @Body() body: InstagramReelDownloadBodyDto,
  ): Promise<ToolResponse<InstagramReelResult>> {
    // Validate input with Zod
    const parsed = InstagramReelDownloadSchema.safeParse(body);
    if (!parsed.success) {
      const firstError =
        parsed.error.issues?.[0]?.message || 'Invalid request body';
      throw new BadRequestException({
        success: false,
        error: firstError,
      });
    }

    const { url, refresh } = parsed.data;

    // Check tool availability
    if (!isToolActive('instagram-reel-downloader')) {
      throw new ServiceUnavailableException({
        success: false,
        error:
          'Instagram Reel Downloader is temporarily unavailable. Please try again later.',
      });
    }

    try {
      const result = await this.instagramReelService.downloadReel(
        url,
        refresh === true,
      );

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      if (error instanceof InstagramFetchError) {
        this.logger.warn(
          `Instagram reel fetch failed: ${error.message}`,
          { url: this.sanitizeUrl(url) },
        );

        // Determine appropriate status code
        const message = error.message;
        if (message.includes('not a video')) {
          throw new BadRequestException({
            success: false,
            error: message,
          });
        }

        // Rate limiting from Instagram or general fetch failure
        throw new ServiceUnavailableException({
          success: false,
          error: message,
        });
      }

      // Unexpected error — log full details, return generic message
      this.logger.error('Unexpected error in Instagram reel download', {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      throw new ServiceUnavailableException({
        success: false,
        error:
          'An unexpected error occurred while fetching the reel. Please try again.',
      });
    }
  }

  /**
   * Sanitize URL for logging — remove query params that might contain tokens.
   */
  private sanitizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return '[invalid-url]';
    }
  }

  /**
   * Proxy download — streams the video through our server so the browser
   * can save it (Instagram CDN blocks cross-origin fetch from the browser).
   * Uses Fastify's reply API since NestJS is running on the Fastify adapter.
   */
  @Post('proxy-download')
  @HttpCode(HttpStatus.OK)
  @ToolCategoryMeta('utility')
  @UseGuards(ToolRateLimitGuard)
  @ApiOperation({
    summary: 'Proxy download a video file',
    description: 'Streams the video through the server to bypass CDN CORS restrictions.',
  })
  async proxyDownload(
    @Body() body: { videoUrl: string; filename?: string },
    @Res() reply: FastifyReply,
  ) {
    const { videoUrl, filename } = body;

    if (!videoUrl || !videoUrl.startsWith('http')) {
      throw new BadRequestException('Valid videoUrl is required');
    }

    try {
      const upstream = await fetch(videoUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      if (!upstream.ok || !upstream.body) {
        throw new ServiceUnavailableException('Failed to fetch video from source');
      }

      const contentType = upstream.headers.get('content-type') || 'video/mp4';
      const contentLength = upstream.headers.get('content-length');
      const safeName = (filename || 'trndinn-reel.mp4').replace(
        /[^a-zA-Z0-9._-]/g,
        '_',
      );

      // Fastify uses .header() and .send(). Buffer the body then send it —
      // simplest reliable approach and works fine for short reels (usually <50MB).
      const arrayBuf = await upstream.arrayBuffer();
      const buf = Buffer.from(arrayBuf);

      reply.header('Content-Type', contentType);
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
      if (contentLength) reply.header('Content-Length', contentLength);
      reply.header('Cache-Control', 'no-store');

      return reply.send(buf);
    } catch (error) {
      this.logger.error('Proxy download failed', {
        error: (error as Error).message,
      });
      throw new ServiceUnavailableException('Failed to download video. Try again.');
    }
  }
}
