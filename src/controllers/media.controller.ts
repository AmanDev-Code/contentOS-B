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
} from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { MediaGenerationService, CarouselGenerationRequest } from '../services/media-generation.service';
import { MinioService } from '../services/minio.service';
import { SupabaseService } from '../services/supabase.service';
import { QuotaService } from '../services/quota.service';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
  };
}

@Controller('media')
@UseGuards(AuthGuard)
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(
    private readonly mediaGenerationService: MediaGenerationService,
    private readonly minioService: MinioService,
    private readonly supabaseService: SupabaseService,
    private readonly quotaService: QuotaService,
  ) {}

  @Post('generate-image')
  async generateImage(
    @Request() req: AuthenticatedRequest,
    @Body() body: { prompt: string; contentId?: string },
  ) {
    try {
      const userId = req.user.id;
      const { prompt, contentId } = body;

      // Check quota
      const hasQuota = await this.quotaService.checkQuotaAvailable(userId, 1.0);
      if (!hasQuota) {
        throw new HttpException('Insufficient credits', HttpStatus.PAYMENT_REQUIRED);
      }

      // IMMEDIATE CREDIT DEDUCTION for image generation
      await this.quotaService.consumeCredits(
        userId,
        1.0,
        'Image generation initiated (1.0 credits)',
        'generation',
        'image',
        contentId
      );

      try {
        // Generate image
        const imageBuffer = await this.mediaGenerationService.generateSingleImage({
          prompt,
          size: '1024x1024',
          quality: 'hd',
        });

        // Optimize image
        const optimizedBuffer = await this.mediaGenerationService.optimizeImage(imageBuffer);

        // Upload to MinIO
        const fileName = `image-${Date.now()}.jpg`;
        const publicUrl = await this.mediaGenerationService.uploadToMinio(
          optimizedBuffer,
          fileName,
          'image/jpeg',
          userId,
        );

        // Save to database
        const { data: mediaFile } = await this.supabaseService.getServiceClient()
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
          await this.supabaseService.getServiceClient()
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
          'image'
        );

        return {
          success: true,
          mediaFile,
          publicUrl,
        };
      } catch (generationError) {
        // REFUND CREDITS if generation fails
        await this.quotaService.consumeCredits(
          userId,
          -1.0,
          'Refund for failed image generation (1.0 credits)',
          'refund',
          'image',
          contentId
        );
        
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
    @Body() body: { slides: any[]; contentId?: string },
  ) {
    try {
      const userId = req.user.id;
      const { slides, contentId } = body;

      // Check quota (carousel costs more)
      const quotaCost = slides.length * 1.5;
      const hasQuota = await this.quotaService.checkQuotaAvailable(userId, quotaCost);
      if (!hasQuota) {
        throw new HttpException('Insufficient credits', HttpStatus.PAYMENT_REQUIRED);
      }

      // Generate carousel PDF
      const pdfBuffer = await this.mediaGenerationService.generateCarouselPDF({
        slides,
        style: 'professional',
      });

      // Upload PDF to MinIO
      const pdfFileName = `carousel-${Date.now()}.pdf`;
      const pdfUrl = await this.mediaGenerationService.uploadToMinio(
        pdfBuffer,
        pdfFileName,
        'application/pdf',
        userId,
      );

      // Generate individual images for preview
      const imageBuffers = await this.mediaGenerationService.generateCarouselImages({
        slides,
        style: 'professional',
      });

      const imageUrls: string[] = [];
      const mediaFiles: any[] = [];

      // Upload individual images
      for (let i = 0; i < imageBuffers.length; i++) {
        const optimizedBuffer = await this.mediaGenerationService.optimizeImage(imageBuffers[i]);
        const imageFileName = `carousel-slide-${Date.now()}-${i + 1}.jpg`;
        const imageUrl = await this.mediaGenerationService.uploadToMinio(
          optimizedBuffer,
          imageFileName,
          'image/jpeg',
          userId,
        );

        imageUrls.push(imageUrl);

        // Save image to database
        const { data: mediaFile } = await this.supabaseService.getServiceClient()
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

        mediaFiles.push(mediaFile);
      }

      // Save PDF to database
      const { data: pdfMediaFile } = await this.supabaseService.getServiceClient()
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

      // Update content if provided
      if (contentId) {
        await this.supabaseService.getServiceClient()
          .from('generated_content')
          .update({
            visual_type: 'carousel',
            carousel_urls: imageUrls,
            pdf_url: pdfUrl,
          })
          .eq('id', contentId)
          .eq('user_id', userId);
      }

      // Consume quota
      await this.quotaService.consumeCredits(userId, quotaCost);

      return {
        success: true,
        pdfUrl,
        imageUrls,
        mediaFiles: [...mediaFiles, pdfMediaFile],
      };
    } catch (error) {
      this.logger.error('Failed to generate carousel:', error.message);
      throw new HttpException(
        error.message || 'Failed to generate carousel',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
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

      let query = this.supabaseService.getServiceClient()
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
        throw new HttpException('Failed to fetch media files', HttpStatus.INTERNAL_SERVER_ERROR);
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

  @Delete('files/:id')
  async deleteMediaFile(
    @Request() req: AuthenticatedRequest,
    @Param('id') fileId: string,
  ) {
    try {
      const userId = req.user.id;

      // Get file details
      const { data: mediaFile, error } = await this.supabaseService.getServiceClient()
        .from('media_files')
        .select('*')
        .eq('id', fileId)
        .eq('user_id', userId)
        .single();

      if (error || !mediaFile) {
        throw new HttpException('Media file not found', HttpStatus.NOT_FOUND);
      }

      // Delete from MinIO
      await this.minioService.deleteFile('contentos-media', mediaFile.minio_path);

      // Delete from database
      await this.supabaseService.getServiceClient()
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
  async uploadMedia(@Request() req: AuthenticatedRequest, @Body() body: { image?: string; filename?: string; file?: any }) {
    try {
      const userId = req.user.id;

      // Check quota
      const hasQuota = await this.quotaService.checkQuotaAvailable(userId, 0.5);
      if (!hasQuota) {
        throw new HttpException('Insufficient credits', HttpStatus.PAYMENT_REQUIRED);
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
        throw new HttpException('No image data provided', HttpStatus.BAD_REQUEST);
      }

      // Generate filename and sanitize it
      let filename = body.filename || `user-upload-${Date.now()}.jpg`;
      // Sanitize filename: remove special characters, replace spaces with hyphens
      filename = filename
        .replace(/[^\w\s.-]/g, '') // Remove special chars except word chars, spaces, dots, hyphens
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/--+/g, '-') // Replace multiple hyphens with single
        .toLowerCase();
      
      // Add timestamp to ensure uniqueness
      const ext = filename.split('.').pop();
      const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));
      filename = `${nameWithoutExt}-${Date.now()}.${ext}`;
      
      const minioPath = `user-uploads/${userId}/${filename}`;

      // Upload to MinIO
      const uploadResult = await this.minioService.uploadFile(
        this.minioService['bucketName'],
        minioPath,
        imageBuffer,
        'image/jpeg'
      );

      // Get public URL
      const publicUrl = await this.minioService.getPublicUrl(
        this.minioService['bucketName'],
        minioPath
      );

      // Save to database
      const { data: mediaFile, error } = await this.supabaseService.getServiceClient()
        .from('media_files')
        .insert({
          user_id: userId,
          file_name: filename,
          file_type: 'image',
          file_size: imageBuffer.length,
          minio_path: minioPath,
          public_url: publicUrl,
          content_id: null, // User uploaded, not generated
        })
        .select()
        .single();

      if (error) {
        throw new HttpException('Failed to save media record', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      // Consume quota
      await this.quotaService.consumeCredits(userId, 0.5);

      return {
        success: true,
        url: publicUrl,
        mediaFile: mediaFile
      };
    } catch (error) {
      this.logger.error('Media upload failed:', error.message);
      throw new HttpException(
        error.message || 'Media upload failed',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get('usage')
  @UseGuards(AuthGuard)
  async getMediaUsage(@Request() req: AuthenticatedRequest) {
    try {
      const userId = req.user.id;

      const { data, error } = await this.supabaseService.getServiceClient()
        .from('media_files')
        .select('file_type, file_size')
        .eq('user_id', userId);

      if (error) {
        throw new HttpException('Failed to get media usage', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      const usage = {
        totalFiles: data.length,
        totalSizeMB: Math.round(data.reduce((sum, file) => sum + (file.file_size || 0), 0) / 1024 / 1024 * 100) / 100,
        byType: data.reduce((acc, file) => {
          acc[file.file_type] = (acc[file.file_type] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
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