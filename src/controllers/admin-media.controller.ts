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
  async createFolder(@Body() body: { path?: string; name: string }) {
    const seg = sanitizeSegment((body.name || '').trim());
    if (!seg) {
      throw new HttpException('Folder name required', HttpStatus.BAD_REQUEST);
    }
    const parent = resolveAdminMediaListingPrefix(body.path || '');
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
  @UseGuards(AuthGuard, PaywallGuard, AdminGuard)
  @ApiOperation({
    summary:
      'Upload image into media/cms (same optimization + credits as /media/upload)',
  })
  async upload(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      image?: string;
      filename?: string;
      path?: string;
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

    let imageBuffer: Buffer;
    if (body.image) {
      if (body.image.startsWith('data:')) {
        const base64Data = body.image.split(',')[1];
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        imageBuffer = Buffer.from(body.image, 'base64');
      }
    } else {
      throw new HttpException('No image data provided', HttpStatus.BAD_REQUEST);
    }

    let filename = body.filename || `upload-${Date.now()}.jpg`;
    filename = filename
      .replace(/[^\w\s.-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/--+/g, '-')
      .toLowerCase();
    const baseName = filename.includes('.')
      ? filename.slice(0, filename.lastIndexOf('.'))
      : filename;
    filename = `${baseName}-${Date.now()}.jpg`;

    normalizeCmsRelativePath(body.path || '');

    const quotaInfo = await this.quotaService.getUserQuota(userId);
    const isFreePlan = quotaInfo.planType === 'free';
    const uploadBuffer = this.shouldApplyFreePlanWatermark(isFreePlan)
      ? await this.mediaGenerationService.optimizeImageWithWatermark(
          imageBuffer,
        )
      : await this.mediaGenerationService.optimizeImage(imageBuffer);

    const minioPath = buildAdminCmsObjectKey(body.path || '', filename);
    const bucket = this.minioService.getBucketName();

    await this.minioService.uploadFile(
      bucket,
      minioPath,
      uploadBuffer,
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
}
