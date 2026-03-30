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
  HttpException,
  HttpStatus,
  Logger,
  Headers,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import {
  MediaGenerationService,
  CarouselGenerationRequest,
} from '../services/media-generation.service';
import { MinioService } from '../services/minio.service';
import { SupabaseService } from '../services/supabase.service';
import { QuotaService } from '../services/quota.service';
import { NotificationService } from '../services/notification.service';
import { IdempotencyService } from '../services/idempotency.service';
import { CacheService } from '../services/cache.service';
import { QUEUE_NAMES } from '../common/constants';
import { CarouselJobData } from '../workers/media-carousel.worker';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
  };
}

@Controller('media')
@UseGuards(AuthGuard, PaywallGuard)
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(
    private readonly mediaGenerationService: MediaGenerationService,
    private readonly minioService: MinioService,
    private readonly supabaseService: SupabaseService,
    private readonly quotaService: QuotaService,
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService,
    private readonly idempotencyService: IdempotencyService,
    private readonly cacheService: CacheService,
    @InjectQueue(QUEUE_NAMES.MEDIA_CAROUSEL)
    private readonly carouselQueue: Queue,
  ) {}

  /** Free-plan watermark only when env WATERMARK_FREE_PLAN_ENABLED is true. */
  private shouldApplyFreePlanWatermark(isFreePlan: boolean): boolean {
    if (!isFreePlan) return false;
    return this.configService.get<boolean>('watermark.freePlanEnabled', false);
  }

  @Post('generate-image')
  async generateImage(
    @Request() req: AuthenticatedRequest,
    @Body() body: { prompt: string; contentId?: string; idempotencyKey?: string },
    @Headers('x-idempotency-key') idemHeader?: string,
  ) {
    try {
      const userId = req.user.id;
      const { prompt, contentId } = body;
      const idempotencyKey = body.idempotencyKey || idemHeader;
      if (idempotencyKey) {
        const existing = await this.idempotencyService.getResult(
          'media-image',
          idempotencyKey,
          userId,
        );
        if (existing?.status === 'completed' && existing.result) {
          return existing.result;
        }
        const locked = await this.idempotencyService.lock(
          'media-image',
          idempotencyKey,
          userId,
        );
        if (!locked) {
          throw new HttpException('Duplicate request in progress', HttpStatus.CONFLICT);
        }
      }

      // Check quota
      const hasQuota = await this.quotaService.checkQuotaAvailable(userId, 1.0);
      if (!hasQuota) {
        throw new HttpException(
          'Insufficient credits',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      // IMMEDIATE CREDIT DEDUCTION for image generation
      const operationId = idempotencyKey || `image:${userId}:${Date.now()}`;
      await this.quotaService.debitOnce({
        userId,
        operationId,
        amount: 1.0,
        description: 'Image generation initiated (1.0 credits)',
        operationType: 'generation',
        contentType: 'image',
        contentId,
      });

      try {
        const quotaInfo = await this.quotaService.getUserQuota(userId);
        const isFreePlan = quotaInfo.planType === 'free';

        // Generate image
        const imageBuffer =
          await this.mediaGenerationService.generateSingleImage({
            prompt,
            size: '1024x1024',
            quality: 'hd',
          });

        const optimizedBuffer = this.shouldApplyFreePlanWatermark(isFreePlan)
          ? await this.mediaGenerationService.optimizeImageWithWatermark(
              imageBuffer,
            )
          : await this.mediaGenerationService.optimizeImage(imageBuffer);

        // Upload to MinIO
        const fileName = `image-${Date.now()}.jpg`;
        const publicUrl = await this.mediaGenerationService.uploadToMinio(
          optimizedBuffer,
          fileName,
          'image/jpeg',
          userId,
        );

        // Save to database
        const { data: mediaFile } = await this.supabaseService
          .getServiceClient()
          .from('media_files')
          .insert({
            user_id: userId,
            content_id: contentId,
            file_name: fileName,
            file_type: 'image',
            file_size: optimizedBuffer.length,
            minio_path: `${userId}/${fileName}`,
            public_url: publicUrl,
          })
          .select()
          .single();

        // Update content if provided
        if (contentId) {
          await this.supabaseService
            .getServiceClient()
            .from('generated_content')
            .update({
              visual_type: 'image',
              visual_url: publicUrl,
            })
            .eq('id', contentId)
            .eq('user_id', userId);
        }

        // Update transaction description to reflect success
        await this.quotaService.logTransaction(
          userId,
          contentId || null,
          'debit',
          0,
          'Image generated successfully (1.0 credits total)',
          'generation',
          'image',
        );

        const result = {
          success: true,
          mediaFile,
          publicUrl,
        };
        if (idempotencyKey) {
          await this.idempotencyService.setResult(
            'media-image',
            idempotencyKey,
            userId,
            result,
          );
        }
        return result;
      } catch (generationError) {
        // REFUND CREDITS if generation fails
        await this.quotaService.refundOnce({
          userId,
          operationId,
          amount: 1.0,
          description: 'Refund for failed image generation (1.0 credits)',
          operationType: 'refund',
          contentType: 'image',
          contentId,
        });

        throw generationError;
      }
    } catch (error) {
      this.logger.error('Failed to generate image:', error.message);
      throw new HttpException(
        error.message || 'Failed to generate image',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('generate-carousel')
  async generateCarousel(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      slides: any[];
      contentId?: string;
      idempotencyKey?: string;
      includePdf?: boolean;
    },
    @Headers('x-idempotency-key') idemHeader?: string,
  ) {
    const userId = req.user.id;
    const { slides, contentId, includePdf = true } = body;
    const idempotencyKey = body.idempotencyKey || idemHeader;
    if (idempotencyKey) {
      const existing = await this.idempotencyService.getResult(
        'media-carousel',
        idempotencyKey,
        userId,
      );
      if (existing?.status === 'completed' && existing.result) {
        return existing.result;
      }
      const locked = await this.idempotencyService.lock(
        'media-carousel',
        idempotencyKey,
        userId,
      );
      if (!locked) {
        throw new HttpException('Duplicate request in progress', HttpStatus.CONFLICT);
      }
    }

    const quotaInfo = await this.quotaService.getUserQuota(userId);
    const isFreePlan = quotaInfo.planType === 'free';

    // Check quota (carousel costs more)
    const quotaCost = slides.length * 1.5;

    try {
      const hasQuota = await this.quotaService.checkQuotaAvailable(
        userId,
        quotaCost,
      );
      if (!hasQuota) {
        throw new HttpException(
          'Insufficient credits',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      // IMMEDIATE CREDIT DEDUCTION for carousel generation
      const operationId = idempotencyKey || `carousel:${userId}:${Date.now()}`;
      await this.quotaService.debitOnce({
        userId,
        operationId,
        amount: quotaCost,
        description: `Carousel generation initiated (${quotaCost} credits)`,
        operationType: 'generation',
        contentType: 'carousel',
        contentId,
      });

      // Generate carousel images (and optional PDF) in a single pass.
      const { imageBuffers, pdfBuffer } =
        await this.mediaGenerationService.generateCarouselBundle({
        slides,
        style: 'professional',
        includePdf,
      });

      let pdfUrl: string | undefined;
      let pdfMediaFile: any | undefined;
      if (includePdf && pdfBuffer) {
        const pdfFileName = `carousel-${Date.now()}.pdf`;
        pdfUrl = await this.mediaGenerationService.uploadToMinio(
          pdfBuffer,
          pdfFileName,
          'application/pdf',
          userId,
        );
        const savedPdf = await this.supabaseService
          .getServiceClient()
          .from('media_files')
          .insert({
            user_id: userId,
            content_id: contentId,
            file_name: pdfFileName,
            file_type: 'pdf',
            file_size: pdfBuffer.length,
            minio_path: `${userId}/${pdfFileName}`,
            public_url: pdfUrl,
          })
          .select()
          .single();
        pdfMediaFile = savedPdf.data;
      }

      const imageUrls: string[] = [];
      const mediaFiles: any[] = [];

      const batchTs = Date.now();
      const imageUploadResults = await Promise.all(
        imageBuffers.map(async (buffer, i) => {
          const optimizedBuffer = this.shouldApplyFreePlanWatermark(isFreePlan)
            ? await this.mediaGenerationService.optimizeImageWithWatermark(buffer)
            : await this.mediaGenerationService.optimizeImage(buffer);
          const imageFileName = `carousel-slide-${batchTs}-${i + 1}.jpg`;
          const imageUrl = await this.mediaGenerationService.uploadToMinio(
            optimizedBuffer,
            imageFileName,
            'image/jpeg',
            userId,
          );
          const { data: mediaFile } = await this.supabaseService
            .getServiceClient()
            .from('media_files')
            .insert({
              user_id: userId,
              content_id: contentId,
              file_name: imageFileName,
              file_type: 'image',
              file_size: optimizedBuffer.length,
              minio_path: `${userId}/${imageFileName}`,
              public_url: imageUrl,
            })
            .select()
            .single();
          return { imageUrl, mediaFile };
        }),
      );
      imageUploadResults.forEach((r) => {
        imageUrls.push(r.imageUrl);
        mediaFiles.push(r.mediaFile);
      });

      // Update content if provided
      if (contentId) {
        await this.supabaseService
          .getServiceClient()
          .from('generated_content')
          .update({
            visual_type: 'carousel',
            carousel_urls: imageUrls,
            ...(pdfUrl ? { pdf_url: pdfUrl } : {}),
          })
          .eq('id', contentId)
          .eq('user_id', userId);
      }

      // Log successful transaction
      await this.quotaService.logTransaction(
        userId,
        contentId || null,
        'debit',
        0,
        `Carousel generated successfully (${quotaCost} credits total)`,
        'generation',
        'carousel',
      );

      const result = {
        success: true,
        ...(pdfUrl ? { pdfUrl } : {}),
        imageUrls,
        mediaFiles: pdfMediaFile ? [...mediaFiles, pdfMediaFile] : mediaFiles,
      };
      if (idempotencyKey) {
        await this.idempotencyService.setResult(
          'media-carousel',
          idempotencyKey,
          userId,
          result,
        );
      }
      return result;
    } catch (error) {
      // REFUND CREDITS for failed carousel generation
      try {
        await this.quotaService.refundOnce({
          userId,
          operationId: idempotencyKey || `carousel:${userId}`,
          amount: quotaCost,
          description: `Refund for failed carousel generation (${quotaCost} credits)`,
          operationType: 'refund',
          contentType: 'carousel',
          contentId: contentId || undefined,
        });
        this.logger.log(
          `Refunded ${quotaCost} credits to user ${userId} for failed carousel generation`,
        );
      } catch (refundError) {
        this.logger.error(
          `Failed to refund credits for user ${userId}: ${refundError.message}`,
        );
      }

      this.logger.error('Failed to generate carousel:', error.message);
      throw new HttpException(
        error.message || 'Failed to generate carousel',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('generate-carousel-async')
  async generateCarouselAsync(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      slides: any[];
      contentId: string;
      idempotencyKey?: string;
      includePdf?: boolean;
      /** e.g. professional | creative | minimal | bold (bold maps to creative) */
      style?: string;
    },
    @Headers('x-idempotency-key') idemHeader?: string,
  ) {
    const userId = req.user.id;
    const { slides, contentId, includePdf = false, style: styleRaw } = body;
    const idempotencyKey = body.idempotencyKey || idemHeader;

    if (idempotencyKey) {
      const existing = await this.idempotencyService.getResult(
        'media-carousel-async',
        idempotencyKey,
        userId,
      );
      if (existing?.status === 'completed' && existing.result) {
        return existing.result;
      }
    }

    const quotaInfo = await this.quotaService.getUserQuota(userId);
    const isFreePlan = quotaInfo.planType === 'free';
    const quotaCost = slides.length * 1.5;

    const hasQuota = await this.quotaService.checkQuotaAvailable(userId, quotaCost);
    if (!hasQuota) {
      throw new HttpException('Insufficient credits', HttpStatus.PAYMENT_REQUIRED);
    }

    const operationId = idempotencyKey || `carousel-async:${userId}:${Date.now()}`;
    await this.quotaService.debitOnce({
      userId,
      operationId,
      amount: quotaCost,
      description: `Carousel generation queued (${quotaCost} credits)`,
      operationType: 'generation',
      contentType: 'carousel',
      contentId,
    });

    await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .update({ status: 'media_generating' })
      .eq('id', contentId)
      .eq('user_id', userId);

    const carouselStyle = ((): CarouselJobData['style'] => {
      const s = (styleRaw || '').toLowerCase().trim();
      if (s === 'bold' || s === 'creative') return 'creative';
      if (s === 'minimal') return 'minimal';
      if (s === 'professional') return 'professional';
      return 'professional';
    })();

    const jobData: CarouselJobData = {
      userId,
      contentId,
      slides,
      style: carouselStyle,
      includePdf,
      isFreePlan,
      operationId,
      quotaCost,
    };

    const job = await this.carouselQueue.add('generate', jobData, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { age: 600 },
      removeOnFail: { age: 1800 },
    });

    const result = {
      success: true,
      async: true,
      jobId: job.id,
      contentId,
    };

    if (idempotencyKey) {
      await this.idempotencyService.setResult(
        'media-carousel-async',
        idempotencyKey,
        userId,
        result,
      );
    }
    return result;
  }

  @Get('carousel-job/:jobId')
  async getCarouselJobStatus(
    @Request() req: AuthenticatedRequest,
    @Param('jobId') jobId: string,
  ) {
    const job = await this.carouselQueue.getJob(jobId);
    if (!job) {
      const cachedResult = await this.cacheService.get(`carousel:job:${jobId}:result`);
      if (cachedResult) {
        return { status: 'completed', progress: 100, result: cachedResult };
      }
      throw new HttpException('Job not found', HttpStatus.NOT_FOUND);
    }

    const state = await job.getState();
    const progress = job.progress ?? 0;

    if (state === 'completed') {
      return { status: 'completed', progress: 100, result: job.returnvalue };
    }
    if (state === 'failed') {
      return {
        status: 'failed',
        progress,
        error: job.failedReason || 'Unknown error',
      };
    }
    return { status: state, progress };
  }

  @Get('files')
  async getMediaFiles(
    @Request() req: AuthenticatedRequest,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('type') type?: string,
  ) {
    try {
      const userId = req.user.id;
      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);
      const offset = (pageNum - 1) * limitNum;

      let query = this.supabaseService
        .getServiceClient()
        .from('media_files')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limitNum - 1);

      if (type) {
        query = query.eq('file_type', type);
      }

      const { data, error, count } = await query;

      if (error) {
        throw new HttpException(
          'Failed to fetch media files',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        files: data || [],
        total: count || 0,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil((count || 0) / limitNum),
      };
    } catch (error) {
      this.logger.error('Failed to get media files:', error.message);
      throw new HttpException(
        error.message || 'Failed to get media files',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('attach-user-assets')
  async attachUserAssets(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      contentId: string;
      postType: 'single' | 'carousel';
      mediaUrls: string[];
    },
  ) {
    const userId = req.user.id;
    const { contentId, postType, mediaUrls } = body;
    if (!contentId || !mediaUrls?.length) {
      throw new HttpException('contentId and mediaUrls are required', HttpStatus.BAD_REQUEST);
    }

    const updates: Record<string, unknown> =
      postType === 'carousel'
        ? {
            visual_type: 'carousel',
            carousel_urls: mediaUrls,
            status: 'media_ready',
          }
        : {
            visual_type: 'image',
            visual_url: mediaUrls[0],
            media_urls: mediaUrls,
            status: 'media_ready',
          };

    const { error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .update(updates)
      .eq('id', contentId)
      .eq('user_id', userId);
    if (error) {
      throw new HttpException('Failed to attach assets', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return { success: true };
  }

  @Delete('files/:id')
  async deleteMediaFile(
    @Request() req: AuthenticatedRequest,
    @Param('id') fileId: string,
  ) {
    try {
      const userId = req.user.id;

      // Get file details
      const { data: mediaFile, error } = await this.supabaseService
        .getServiceClient()
        .from('media_files')
        .select('*')
        .eq('id', fileId)
        .eq('user_id', userId)
        .single();

      if (error || !mediaFile) {
        throw new HttpException('Media file not found', HttpStatus.NOT_FOUND);
      }

      // Delete from MinIO
      await this.minioService.deleteFile(
        'contentos-media',
        mediaFile.minio_path,
      );

      // Delete from database
      await this.supabaseService
        .getServiceClient()
        .from('media_files')
        .delete()
        .eq('id', fileId)
        .eq('user_id', userId);

      return {
        success: true,
        message: 'Media file deleted successfully',
      };
    } catch (error) {
      this.logger.error('Failed to delete media file:', error.message);
      throw new HttpException(
        error.message || 'Failed to delete media file',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('upload')
  @UseGuards(AuthGuard)
  async uploadMedia(
    @Request() req: AuthenticatedRequest,
    @Body() body: { image?: string; filename?: string; file?: any },
  ) {
    try {
      const userId = req.user.id;

      // Check quota
      const hasQuota = await this.quotaService.checkQuotaAvailable(userId, 0.5);
      if (!hasQuota) {
        throw new HttpException(
          'Insufficient credits',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      // Convert base64 to buffer if needed
      let imageBuffer: Buffer;
      if (body.image) {
        if (body.image.startsWith('data:')) {
          const base64Data = body.image.split(',')[1];
          imageBuffer = Buffer.from(base64Data, 'base64');
        } else {
          imageBuffer = Buffer.from(body.image, 'base64');
        }
      } else if (body.file) {
        // Handle file upload (for future implementation)
        imageBuffer = Buffer.from(body.file);
      } else {
        throw new HttpException(
          'No image data provided',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Generate filename and sanitize it
      let filename = body.filename || `user-upload-${Date.now()}.jpg`;
      // Sanitize filename: remove special characters, replace spaces with hyphens
      filename = filename
        .replace(/[^\w\s.-]/g, '') // Remove special chars except word chars, spaces, dots, hyphens
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/--+/g, '-') // Replace multiple hyphens with single
        .toLowerCase();

      // Add timestamp; stored bytes are always JPEG after optimize
      const baseName = filename.includes('.')
        ? filename.slice(0, filename.lastIndexOf('.'))
        : filename;
      filename = `${baseName}-${Date.now()}.jpg`;

      const quotaInfo = await this.quotaService.getUserQuota(userId);
      const isFreePlan = quotaInfo.planType === 'free';

      const uploadBuffer = this.shouldApplyFreePlanWatermark(isFreePlan)
        ? await this.mediaGenerationService.optimizeImageWithWatermark(
            imageBuffer,
          )
        : await this.mediaGenerationService.optimizeImage(imageBuffer);

      const minioPath = `user-uploads/${userId}/${filename}`;

      // Upload to MinIO
      const uploadResult = await this.minioService.uploadFile(
        this.minioService['bucketName'],
        minioPath,
        uploadBuffer,
        'image/jpeg',
      );

      // Get public URL
      const publicUrl = await this.minioService.getPublicUrl(
        this.minioService['bucketName'],
        minioPath,
      );

      // Save to database
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
          content_id: null, // User uploaded, not generated
        })
        .select()
        .single();

      if (error) {
        throw new HttpException(
          'Failed to save media record',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Consume quota
      await this.quotaService.consumeCredits(userId, 0.5);

      return {
        success: true,
        url: publicUrl,
        mediaFile: mediaFile,
      };
    } catch (error) {
      this.logger.error('Media upload failed:', error.message);
      throw new HttpException(
        error.message || 'Media upload failed',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('usage')
  @UseGuards(AuthGuard)
  async getMediaUsage(@Request() req: AuthenticatedRequest) {
    try {
      const userId = req.user.id;

      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('media_files')
        .select('file_type, file_size')
        .eq('user_id', userId);

      if (error) {
        throw new HttpException(
          'Failed to get media usage',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      const usage = {
        totalFiles: data.length,
        totalSizeMB:
          Math.round(
            (data.reduce((sum, file) => sum + (file.file_size || 0), 0) /
              1024 /
              1024) *
              100,
          ) / 100,
        byType: data.reduce(
          (acc, file) => {
            acc[file.file_type] = (acc[file.file_type] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
      };

      return {
        success: true,
        usage,
      };
    } catch (error) {
      this.logger.error('Failed to get media usage:', error.message);
      throw new HttpException(
        error.message || 'Failed to get media usage',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
