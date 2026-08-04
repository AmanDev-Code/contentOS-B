import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { AdminOrApiKeyGuard } from '../guards/admin-or-apikey.guard';
import { RequireApiScope } from '../decorators/api-scope.decorator';
import { MinioService } from '../services/minio.service';
import { MediaGenerationService } from '../services/media-generation.service';
import { SupabaseService } from '../services/supabase.service';
import { QuotaService } from '../services/quota.service';
import type { AuthenticatedRequest } from '../guards/auth.guard';
import {
  assertValidAdminDeletableObjectKey,
  browseListingPrefixToRelativePath,
  buildAdminCmsObjectKey,
  normalizeCmsRelativePath,
  parseAdminMediaBrowseScope,
  resolveAdminMediaListingPrefix,
  resolveBrowseListingPrefix,
  sanitizeSegment,
} from '../common/admin-media-storage';

@ApiTags('admin-media')
@Controller('admin/media')
@ApiBearerAuth()
export class AdminMediaController {
  private readonly logger = new Logger(AdminMediaController.name);

  constructor(
    private readonly minioService: MinioService,
    private readonly mediaGenerationService: MediaGenerationService,
    private readonly supabaseService: SupabaseService,
    private readonly quotaService: QuotaService,
    private readonly configService: ConfigService,
  ) {}

  private shouldApplyFreePlanWatermark(isFreePlan: boolean): boolean {
    if (!isFreePlan) return false;
    return this.configService.get<boolean>('watermark.freePlanEnabled', false);
  }

  @Get('browse')
  @UseGuards(AuthGuard, PaywallGuard, AdminGuard)
  @ApiOperation({
    summary:
      'List one level under MinIO bucket (scope=bucket, default) or under media/cms (scope=cms)',
  })
  async browse(
    @Query('path') path?: string,
    @Query('scope') scope?: string,
    @Query('root') root?: string,
  ) {
    try {
      const forceBucketRoot =
        root === 'true' ||
        root === '1' ||
        String(root || '').toLowerCase() === 'yes';
      const browseScope = forceBucketRoot
        ? parseAdminMediaBrowseScope('bucket')
        : parseAdminMediaBrowseScope(scope);
      const listingPrefix = resolveBrowseListingPrefix(
        browseScope,
        forceBucketRoot ? '' : path || '',
      );
      const bucket = this.minioService.getBucketName();
      const { prefixes, objects } = await this.minioService.listOneLevel(
        bucket,
        listingPrefix,
      );

      const folders = prefixes.map((p) => {
        const trimmed = p.replace(/\/+$/, '');
        const name = trimmed.split('/').pop() || trimmed;
        return {
          name,
          prefix: p.endsWith('/') ? p : `${p}/`,
        };
      });

      const outObjects: Array<{
        key: string;
        name: string;
        size: number;
        lastModified: string | null;
        contentType: string | null;
        url: string;
      }> = [];

      for (const o of objects) {
        let contentType: string | null = null;
        try {
          const st = await this.minioService.getFileStats(bucket, o.name);
          const meta = st.metaData as Record<string, string> | undefined;
          contentType =
            meta?.['content-type'] || meta?.['Content-Type'] || null;
        } catch {
          /* ignore stat failures for odd keys */
        }
        const url = await this.minioService.getPublicUrl(bucket, o.name);
        const shortName = o.name.replace(/\/$/, '').split('/').pop() || o.name;
        outObjects.push({
          key: o.name,
          name: shortName,
          size: o.size,
          lastModified: o.lastModified ? o.lastModified.toISOString() : null,
          contentType,
          url,
        });
      }

      return {
        scope: browseScope,
        bucket,
        path: browseListingPrefixToRelativePath(browseScope, listingPrefix),
        listingPrefix,
        folders,
        objects: outObjects,
      };
    } catch (e: any) {
      this.logger.error('admin media browse failed', e?.message);
      if (e.status) throw e;
      throw new HttpException(
        e.message || 'Browse failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('folder')
  @UseGuards(AuthGuard, PaywallGuard, AdminGuard)
  @ApiOperation({ summary: 'Create folder (prefix marker)' })
  async createFolder(
    @Body() body: { path?: string; name: string; fullPath?: boolean },
  ) {
    const seg = sanitizeSegment((body.name || '').trim());
    if (!seg) {
      throw new HttpException('Folder name required', HttpStatus.BAD_REQUEST);
    }
    let parent: string;
    if (body.fullPath) {
      const rawPath = (body.path || '').replace(/\/+$/, '');
      parent = rawPath ? `${rawPath}/` : '';
    } else {
      parent = resolveAdminMediaListingPrefix(body.path || '');
    }
    const folderKey = `${parent}${seg}/`;
    const bucket = this.minioService.getBucketName();
    await this.minioService.uploadFile(
      bucket,
      folderKey,
      Buffer.alloc(0),
      'application/x-directory',
    );
    return {
      success: true,
      key: folderKey,
    };
  }

  @Delete('object')
  @UseGuards(AuthGuard, PaywallGuard, AdminGuard)
  @ApiOperation({ summary: 'Delete a single object under admin media root' })
  async deleteObject(@Body() body: { key: string }) {
    assertValidAdminDeletableObjectKey(body.key);
    const bucket = this.minioService.getBucketName();
    await this.minioService.deleteFile(bucket, body.key);

    await this.supabaseService
      .getServiceClient()
      .from('media_files')
      .delete()
      .eq('minio_path', body.key);

    return { success: true };
  }

  @Post('upload')
  @UseGuards(AdminOrApiKeyGuard)
  @RequireApiScope('media:write')
  @ApiOperation({
    summary:
      'Upload any file into media/cms (images are optimized, other files stored as-is)',
  })
  async upload(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      image?: string;
      filename?: string;
      path?: string;
      fullPath?: boolean;
      skipOptimization?: boolean;
      contentType?: string;
    },
  ) {
    const user = req.user;
    if (!user?.id) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    const userId = user.id;

    const hasQuota = await this.quotaService.checkQuotaAvailable(userId, 0.5);
    if (!hasQuota) {
      throw new HttpException(
        'Insufficient credits',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    let fileBuffer: Buffer;
    if (body.image) {
      if (body.image.startsWith('data:')) {
        const base64Data = body.image.split(',')[1];
        fileBuffer = Buffer.from(base64Data, 'base64');
      } else {
        fileBuffer = Buffer.from(body.image, 'base64');
      }
    } else {
      throw new HttpException('No file data provided', HttpStatus.BAD_REQUEST);
    }

    let filename = body.filename || `upload-${Date.now()}`;
    const originalExt = filename.includes('.')
      ? filename.slice(filename.lastIndexOf('.'))
      : '';
    const baseName = filename.includes('.')
      ? filename.slice(0, filename.lastIndexOf('.'))
      : filename;
    const sanitizedBase = baseName
      .replace(/[^\w\s.-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/--+/g, '-')
      .toLowerCase();

    const isOptimizableImage =
      !body.skipOptimization &&
      /\.(jpe?g|png|gif|webp)$/i.test(originalExt);

    let uploadBuffer: Buffer;
    let finalExt: string;
    let finalContentType: string;

    if (isOptimizableImage) {
      const quotaInfo = await this.quotaService.getUserQuota(userId);
      const isFreePlan = quotaInfo.planType === 'free';
      uploadBuffer = this.shouldApplyFreePlanWatermark(isFreePlan)
        ? await this.mediaGenerationService.optimizeImageWithWatermark(
            fileBuffer,
          )
        : await this.mediaGenerationService.optimizeImage(fileBuffer);
      finalExt = '.jpg';
      finalContentType = 'image/jpeg';
    } else {
      uploadBuffer = fileBuffer;
      finalExt = originalExt || '';
      finalContentType =
        body.contentType || this.guessContentType(originalExt) || 'application/octet-stream';
    }

    filename = `${sanitizedBase}-${Date.now()}${finalExt}`;

    let minioPath: string;
    if (body.fullPath) {
      const rawPath = (body.path || '').replace(/\/+$/, '');
      minioPath = rawPath ? `${rawPath}/${filename}` : filename;
    } else {
      normalizeCmsRelativePath(body.path || '');
      minioPath = buildAdminCmsObjectKey(body.path || '', filename);
    }
    const bucket = this.minioService.getBucketName();

    await this.minioService.uploadFile(
      bucket,
      minioPath,
      uploadBuffer,
      finalContentType,
    );
    const publicUrl = await this.minioService.getPublicUrl(bucket, minioPath);

    const fileType = this.categorizeFileType(finalContentType, finalExt);

    const { data: mediaFile, error } = await this.supabaseService
      .getServiceClient()
      .from('media_files')
      .insert({
        user_id: userId,
        file_name: filename,
        file_type: fileType,
        file_size: uploadBuffer.length,
        minio_path: minioPath,
        public_url: publicUrl,
        content_id: null,
      })
      .select()
      .single();

    if (error) {
      throw new HttpException(
        'Failed to save media record',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    await this.quotaService.consumeCredits(userId, 0.5);

    return {
      success: true,
      url: publicUrl,
      key: minioPath,
      mediaFile,
    };
  }

  private guessContentType(ext: string): string | null {
    const map: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.flv': 'video/x-flv',
      '.wmv': 'video/x-ms-wmv',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx':
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.zip': 'application/zip',
      '.rar': 'application/vnd.rar',
      '.7z': 'application/x-7z-compressed',
      '.tar': 'application/x-tar',
      '.gz': 'application/gzip',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
    };
    return map[ext.toLowerCase()] || null;
  }

  private categorizeFileType(
    contentType: string,
    ext: string,
  ): 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other' {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('audio/')) return 'audio';
    if (
      contentType.startsWith('application/pdf') ||
      contentType.includes('document') ||
      contentType.includes('spreadsheet') ||
      contentType.includes('presentation') ||
      contentType.startsWith('text/') ||
      /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|rtf|odt|ods|odp)$/i.test(ext)
    ) {
      return 'document';
    }
    if (
      contentType.includes('zip') ||
      contentType.includes('rar') ||
      contentType.includes('7z') ||
      contentType.includes('tar') ||
      contentType.includes('gzip') ||
      /\.(zip|rar|7z|tar|gz|bz2)$/i.test(ext)
    ) {
      return 'archive';
    }
    return 'other';
  }
}
