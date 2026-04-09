import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../common/constants';
import {
  MediaGenerationService,
  CarouselGenerationRequest,
} from '../services/media-generation.service';
import { MinioService } from '../services/minio.service';
import { SupabaseService } from '../services/supabase.service';
import { QuotaService } from '../services/quota.service';
import { CacheService } from '../services/cache.service';

export interface CarouselJobData {
  userId: string;
  contentId: string;
  slides: CarouselGenerationRequest['slides'];
  style?: CarouselGenerationRequest['style'];
  includePdf: boolean;
  isFreePlan: boolean;
  operationId: string;
  quotaCost: number;
}

export interface CarouselJobResult {
  imageUrls: string[];
  pdfUrl?: string;
}

@Processor(QUEUE_NAMES.MEDIA_CAROUSEL, {
  concurrency: 2,
})
export class MediaCarouselWorker extends WorkerHost {
  private readonly logger = new Logger(MediaCarouselWorker.name);

  constructor(
    private readonly mediaGenService: MediaGenerationService,
    private readonly minioService: MinioService,
    private readonly supabaseService: SupabaseService,
    private readonly quotaService: QuotaService,
    private readonly cacheService: CacheService,
  ) {
    super();
  }

  async process(job: Job<CarouselJobData>): Promise<CarouselJobResult> {
    const {
      userId,
      contentId,
      slides,
      style,
      includePdf,
      isFreePlan,
      operationId,
      quotaCost,
    } = job.data;
    this.logger.log(
      `[MediaCarouselWorker] Processing job ${job.id} — ${slides.length} slides for content ${contentId}`,
    );

    try {
      await job.updateProgress(10);

      const { imageBuffers, pdfBuffer } =
        await this.mediaGenService.generateCarouselBundle({
          slides,
          style: style || 'professional',
          includePdf,
        });

      await job.updateProgress(70);

      const batchTs = Date.now();
      const imageUploadResults = await Promise.all(
        imageBuffers.map(async (buffer, i) => {
          const optimized = isFreePlan
            ? await this.mediaGenService.optimizeImageWithWatermark(buffer)
            : await this.mediaGenService.optimizeImage(buffer);
          const fileName = `carousel-slide-${batchTs}-${i + 1}.jpg`;
          const url = await this.mediaGenService.uploadToMinio(
            optimized,
            fileName,
            'image/jpeg',
            userId,
          );
          await this.supabaseService
            .getServiceClient()
            .from('media_files')
            .insert({
              user_id: userId,
              content_id: contentId,
              file_name: fileName,
              file_type: 'image',
              file_size: optimized.length,
              minio_path: `${userId}/${fileName}`,
              public_url: url,
            });
          return url;
        }),
      );

      await job.updateProgress(85);

      let pdfUrl: string | undefined;
      if (includePdf && pdfBuffer) {
        const pdfFileName = `carousel-${batchTs}.pdf`;
        pdfUrl = await this.mediaGenService.uploadToMinio(
          pdfBuffer,
          pdfFileName,
          'application/pdf',
          userId,
        );
        await this.supabaseService
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
          });
      }

      await this.supabaseService
        .getServiceClient()
        .from('generated_content')
        .update({
          visual_type: 'carousel',
          carousel_urls: imageUploadResults,
          ...(pdfUrl ? { pdf_url: pdfUrl } : {}),
          status: 'media_ready',
        })
        .eq('id', contentId)
        .eq('user_id', userId);

      await this.quotaService.logTransaction(
        userId,
        contentId,
        'debit',
        0,
        `Carousel generated (${quotaCost} credits)`,
        'generation',
        'carousel',
      );

      await job.updateProgress(100);

      const result: CarouselJobResult = {
        imageUrls: imageUploadResults,
        pdfUrl,
      };

      await this.cacheService.set(`carousel:job:${job.id}:result`, result, 600);

      this.logger.log(
        `[MediaCarouselWorker] Job ${job.id} complete — ${imageUploadResults.length} slides uploaded`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `[MediaCarouselWorker] Job ${job.id} failed: ${error.message}`,
      );

      try {
        await this.quotaService.refundOnce({
          userId,
          operationId,
          amount: quotaCost,
          description: `Refund for failed carousel generation (${quotaCost} credits)`,
          operationType: 'refund',
          contentType: 'carousel',
          contentId,
        });
      } catch (refundErr) {
        this.logger.error(`Refund failed: ${refundErr.message}`);
      }

      await this.supabaseService
        .getServiceClient()
        .from('generated_content')
        .update({ status: 'failed' })
        .eq('id', contentId)
        .eq('user_id', userId);

      throw error;
    }
  }
}
