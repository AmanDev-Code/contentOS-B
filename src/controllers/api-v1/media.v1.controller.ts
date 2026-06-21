import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../guards/api-key-auth.guard';
import { RequireApiScope } from '../../decorators/api-scope.decorator';
import { MediaGenerationService } from '../../services/media-generation.service';
import { MinioService } from '../../services/minio.service';
import { SupabaseService } from '../../services/supabase.service';
import { QuotaService } from '../../services/quota.service';

interface ApiAuthedRequest {
  user: { id: string };
}

interface UploadMediaBody {
  /** Base64-encoded image bytes (with or without data: URI prefix). */
  image?: string;
  /** Public URL to fetch the image from (alternative to `image`). */
  url?: string;
  filename?: string;
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * Public API v1 — Media upload. Reuses the existing MinIO pipeline
 * (MinioService + sharp optimize). Accepts base64 bytes or a remote URL,
 * stores under the user's upload prefix, and returns a public URL usable as
 * `mediaUrls[]` in POST /api/v1/posts.
 */
@ApiTags('public-api-v1')
@ApiBearerAuth()
@Controller('api/v1/media')
@UseGuards(ApiKeyAuthGuard)
export class MediaV1Controller {
  private readonly logger = new Logger(MediaV1Controller.name);

  constructor(
    private readonly mediaGenerationService: MediaGenerationService,
    private readonly minioService: MinioService,
    private readonly supabaseService: SupabaseService,
    private readonly quotaService: QuotaService,
  ) {}

  @Post()
  @RequireApiScope('media:write')
  @ApiOperation({ summary: 'Upload media (base64 or remote URL)' })
  async upload(
    @Request() req: ApiAuthedRequest,
    @Body() body: UploadMediaBody,
  ) {
    const userId = req.user.id;

    try {
      const hasQuota = await this.quotaService.checkQuotaAvailable(userId, 0.5);
      if (!hasQuota) {
        throw new HttpException(
          'Insufficient credits for media upload.',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      const sourceBuffer = await this.resolveBuffer(body);
      if (sourceBuffer.length > MAX_IMAGE_BYTES) {
        throw new HttpException(
          'Image exceeds the 15MB limit.',
          HttpStatus.PAYLOAD_TOO_LARGE,
        );
      }

      const optimized =
        await this.mediaGenerationService.optimizeImage(sourceBuffer);

      const baseName = (body.filename || `api-upload-${Date.now()}`)
        .replace(/[^\w\s.-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/--+/g, '-')
        .toLowerCase();
      const cleanBase = baseName.includes('.')
        ? baseName.slice(0, baseName.lastIndexOf('.'))
        : baseName;
      const filename = `${cleanBase || 'image'}-${Date.now()}.jpg`;
      const minioPath = `user-uploads/${userId}/${filename}`;

      const bucket = this.minioService['bucketName'];
      await this.minioService.uploadFile(
        bucket,
        minioPath,
        optimized,
        'image/jpeg',
      );
      const publicUrl = await this.minioService.getPublicUrl(bucket, minioPath);

      const { data: mediaFile, error } = await this.supabaseService
        .getServiceClient()
        .from('media_files')
        .insert({
          user_id: userId,
          file_name: filename,
          file_type: 'image',
          file_size: optimized.length,
          minio_path: minioPath,
          public_url: publicUrl,
          content_id: null,
        })
        .select()
        .single();

      if (error) {
        throw new HttpException(
          'Failed to save media record.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      await this.quotaService.consumeCredits(
        userId,
        0.5,
        'API media upload (0.5 credits)',
        'generation',
        'image',
      );

      return {
        success: true,
        id: mediaFile?.id,
        url: publicUrl,
        fileType: 'image',
        fileSize: optimized.length,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `API media upload failed: ${(error as Error)?.message}`,
      );
      throw new HttpException(
        (error as Error)?.message || 'Media upload failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async resolveBuffer(body: UploadMediaBody): Promise<Buffer> {
    if (body.image) {
      const base64 = body.image.startsWith('data:')
        ? body.image.split(',')[1]
        : body.image;
      const buf = Buffer.from(base64, 'base64');
      if (buf.length === 0) {
        throw new HttpException(
          'Invalid base64 image data.',
          HttpStatus.BAD_REQUEST,
        );
      }
      return buf;
    }

    if (body.url) {
      let parsed: URL;
      try {
        parsed = new URL(body.url);
      } catch {
        throw new HttpException('Invalid `url`.', HttpStatus.BAD_REQUEST);
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new HttpException(
          'Only http(s) URLs are supported.',
          HttpStatus.BAD_REQUEST,
        );
      }
      const res = await fetch(parsed.toString());
      if (!res.ok) {
        throw new HttpException(
          `Failed to fetch media from URL (HTTP ${res.status}).`,
          HttpStatus.BAD_REQUEST,
        );
      }
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        throw new HttpException(
          'URL did not return an image.',
          HttpStatus.BAD_REQUEST,
        );
      }
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    }

    throw new HttpException(
      'Provide either `image` (base64) or `url`.',
      HttpStatus.BAD_REQUEST,
    );
  }
}
