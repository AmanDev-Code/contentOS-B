import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';
import { MinioService } from './minio.service';
import { CacheService } from './cache.service';

export interface ImageGenerationRequest {
  prompt: string;
  size?: '1024x1024' | '1792x1024' | '1024x1792' | '1536x1024' | '1024x1536';
  quality?: 'low' | 'medium' | 'high' | 'standard' | 'hd';
  style?: 'vivid' | 'natural';
  model?: 'dall-e-3' | 'gpt-image-1' | 'gpt-image-1-mini';
}

export interface CarouselSlide {
  headline: string;
  body: string;
  imagePrompt: string;
}

export interface CarouselGenerationRequest {
  slides: CarouselSlide[];
  style?: 'professional' | 'creative' | 'minimal';
  includePdf?: boolean;
}

export interface CarouselGenerationBundle {
  imageBuffers: Buffer[];
  pdfBuffer?: Buffer;
}

@Injectable()
export class MediaGenerationService {
  private readonly logger = new Logger(MediaGenerationService.name);
  private readonly openaiApiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly minioService: MinioService,
    private readonly cacheService: CacheService,
  ) {
    this.openaiApiKey = this.configService.get<string>('OPENAI_API_KEY') || '';
  }

  async generateSingleImage(request: ImageGenerationRequest): Promise<Buffer> {
    try {
      const cacheKey = this.buildImageCacheKey(request);
      const cached = await this.cacheService.get(cacheKey);
      if (cached) {
        this.logger.log('Cache HIT for image prompt');
        return Buffer.from(cached, 'base64');
      }

      const model = request.model
        || this.configService.get<string>('MEDIA_IMAGE_MODEL')
        || 'gpt-image-1-mini';

      const optimizedPrompt = this.buildProductionImagePrompt(request.prompt);
      this.logger.log(
        `Generating image [${model}]: ${optimizedPrompt.substring(0, 60)}...`,
      );

      const isGptImage = model.startsWith('gpt-image');

      const body: Record<string, unknown> = {
        model,
        prompt: optimizedPrompt,
        n: 1,
        size: request.size || '1024x1024',
      };

      if (isGptImage) {
        const qMap: Record<string, string> = { hd: 'high', standard: 'medium' };
        body.quality = qMap[request.quality as string] || request.quality || 'medium';
        body.output_format = 'png';
      } else {
        body.quality = request.quality || 'hd';
        body.style = request.style || 'natural';
        body.response_format = 'b64_json';
      }

      const response = await axios.post(
        'https://api.openai.com/v1/images/generations',
        body,
        {
          headers: {
            Authorization: `Bearer ${this.openaiApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 90000,
        },
      );

      const base64Image = response.data.data[0].b64_json;
      await this.cacheService.set(cacheKey, base64Image, 6 * 60 * 60);
      return Buffer.from(base64Image, 'base64');
    } catch (error) {
      this.logger.error('Failed to generate image:', error.message);
      throw new Error(`Image generation failed: ${error.message}`);
    }
  }

  async generateCarouselImages(
    request: CarouselGenerationRequest,
  ): Promise<Buffer[]> {
    try {
      const total = request.slides.length;
      this.logger.log(`Generating carousel with ${total} slides`);

      const maxConcurrency = Number(
        this.configService.get<string>('MEDIA_CAROUSEL_CONCURRENCY') || 4,
      );
      const carouselModel =
        this.configService.get<string>('MEDIA_CAROUSEL_MODEL') ||
        this.configService.get<string>('MEDIA_IMAGE_MODEL') ||
        'gpt-image-1-mini';
      const carouselQuality =
        this.configService.get<string>('MEDIA_CAROUSEL_QUALITY') || 'medium';

      const generated: Buffer[] = [];

      for (let i = 0; i < total; i += maxConcurrency) {
        const batch = request.slides.slice(i, i + maxConcurrency);
        const results = await Promise.all(
          batch.map(async (slide) => {
            const raw = await this.generateSingleImage({
              prompt: slide.imagePrompt,
              size: '1024x1024',
              quality: carouselQuality as ImageGenerationRequest['quality'],
              model: carouselModel as ImageGenerationRequest['model'],
            });
            return this.renderSafeCarouselSlide(slide, raw, request.style);
          }),
        );
        generated.push(...results);
      }

      return generated;
    } catch (error) {
      this.logger.error('Failed to generate carousel images:', error.message);
      throw new Error(`Carousel generation failed: ${error.message}`);
    }
  }

  async generateCarouselPDF(
    request: CarouselGenerationRequest,
  ): Promise<Buffer> {
    try {
      this.logger.log('Generating carousel PDF using local renderer');
      const imageBuffers = await this.generateCarouselImages(request);
      return this.buildPdfFromImages(imageBuffers);
    } catch (error) {
      this.logger.error('Failed to generate carousel PDF:', error.message);
      throw new Error(`Carousel PDF generation failed: ${error.message}`);
    }
  }

  async generateCarouselBundle(
    request: CarouselGenerationRequest,
  ): Promise<CarouselGenerationBundle> {
    const imageBuffers = await this.generateCarouselImages(request);
    const pdfBuffer = request.includePdf === false
      ? undefined
      : await this.buildPdfFromImages(imageBuffers);
    return { imageBuffers, pdfBuffer };
  }

  private async renderSafeCarouselSlide(
    slide: CarouselSlide,
    baseImage: Buffer,
    style: CarouselGenerationRequest['style'] = 'professional',
  ): Promise<Buffer> {
    const headline = this.sanitizeOverlayText(slide.headline || '');
    const body = this.sanitizeOverlayText(slide.body || '');

    const overlayOpacity =
      style === 'creative' ? 0.28 : style === 'minimal' ? 0.2 : 0.35;

    const CANVAS = 1024;
    const PAD_X = 72;
    const TEXT_W = CANVAS - PAD_X * 2;

    const HEAD_FONT = 48;
    const HEAD_LINE_H = 58;
    const BODY_FONT = 28;
    const BODY_LINE_H = 38;

    const headLines = this.wrapSvgText(headline, HEAD_FONT, TEXT_W, 2);
    const bodyLines = this.wrapSvgText(body, BODY_FONT, TEXT_W, 4);

    const GAP = 16;
    const contentH =
      headLines.length * HEAD_LINE_H +
      GAP +
      bodyLines.length * BODY_LINE_H;
    const BOX_PAD_Y = 32;
    const boxH = contentH + BOX_PAD_Y * 2;
    const BOX_BOTTOM_MARGIN = 80;
    const boxY = CANVAS - boxH - BOX_BOTTOM_MARGIN;
    const boxX = 40;
    const boxW = CANVAS - boxX * 2;

    let textY = boxY + BOX_PAD_Y + HEAD_LINE_H * 0.78;

    const tspans: string[] = [];
    for (const line of headLines) {
      tspans.push(
        `<text x="${PAD_X}" y="${Math.round(textY)}" fill="#ffffff" font-size="${HEAD_FONT}" font-weight="800" font-family="DejaVu Sans, Noto Sans, Liberation Sans, Arial, Helvetica, sans-serif">${this.escapeHtml(line)}</text>`,
      );
      textY += HEAD_LINE_H;
    }
    textY += GAP;
    for (const line of bodyLines) {
      tspans.push(
        `<text x="${PAD_X}" y="${Math.round(textY)}" fill="rgba(255,255,255,0.9)" font-size="${BODY_FONT}" font-weight="400" font-family="DejaVu Sans, Noto Sans, Liberation Sans, Arial, Helvetica, sans-serif">${this.escapeHtml(line)}</text>`,
      );
      textY += BODY_LINE_H;
    }

    const svg = `<svg width="${CANVAS}" height="${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" fill="rgba(0,0,0,${overlayOpacity})"/>
  <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="24" fill="rgba(0,0,0,0.68)"/>
  ${tspans.join('\n  ')}
</svg>`;

    return sharp(baseImage)
      .resize(CANVAS, CANVAS, { fit: 'cover' })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .sharpen()
      .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
  }

  private wrapSvgText(
    text: string,
    fontSize: number,
    maxWidth: number,
    maxLines: number,
  ): string[] {
    const avgCharW = fontSize * 0.52;
    const maxChars = Math.floor(maxWidth / avgCharW);
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (test.length > maxChars && current) {
        lines.push(current);
        current = word;
        if (lines.length >= maxLines) break;
      } else {
        current = test;
      }
    }
    if (current && lines.length < maxLines) lines.push(current);
    if (lines.length === maxLines && words.length > 0) {
      const last = lines[maxLines - 1];
      if (last.length > maxChars - 3) {
        lines[maxLines - 1] = last.slice(0, maxChars - 3) + '...';
      }
    }
    return lines.length > 0 ? lines : [''];
  }

  private buildImageCacheKey(request: ImageGenerationRequest): string {
    const hash = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex')
      .slice(0, 24);
    return `media:image:${hash}`;
  }

  private buildProductionImagePrompt(prompt: string): string {
    return [
      'Create a high-quality, photorealistic LinkedIn visual.',
      'CRITICAL: Do NOT include any text, letters, numbers, logos, or watermarks inside the generated image.',
      'Use clean composition, balanced lighting, and professional business aesthetics.',
      'Avoid distorted objects and avoid surreal artifacts.',
      `Scene brief: ${prompt}`,
    ].join(' ');
  }

  private async buildPdfFromImages(images: Buffer[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ autoFirstPage: false, compress: true });
      const chunks: Buffer[] = [];
      const stream = new PassThrough();
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);

      doc.pipe(stream);
      for (const image of images) {
        doc.addPage({ size: [1024, 1024], margin: 0 });
        doc.image(image, 0, 0, { width: 1024, height: 1024 });
      }
      doc.end();
    });
  }

  async optimizeImage(
    imageBuffer: Buffer,
    maxWidth = 1024,
    quality = 90,
  ): Promise<Buffer> {
    try {
      return await sharp(imageBuffer)
        .resize(maxWidth, maxWidth, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality })
        .toBuffer();
    } catch (error) {
      this.logger.error('Failed to optimize image:', error.message);
      throw new Error(`Image optimization failed: ${error.message}`);
    }
  }

  /**
   * Resize + watermark + **one** JPEG encode (free plan). Avoids optimize→watermark
   * double JPEG passes which heavily blurs the overlay.
   */
  async optimizeImageWithWatermark(
    imageBuffer: Buffer,
    maxWidth = 1024,
  ): Promise<Buffer> {
    const logoPath = path.join(
      process.cwd(),
      'assets',
      'brand',
      'logo-full-main.png',
    );
    if (!fs.existsSync(logoPath)) {
      this.logger.warn(
        `Brand watermark skipped: logo not found at ${logoPath}`,
      );
      return this.optimizeImage(imageBuffer, maxWidth);
    }

    const lanczos = sharp.kernel.lanczos3;

    try {
      // PNG intermediate: avoids JPEG→resize→JPEG before composite (double lossy encode on base).
      const { data: resizedBuf, info } = await sharp(imageBuffer)
        .resize(maxWidth, maxWidth, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png({ compressionLevel: 6 })
        .toBuffer({ resolveWithObject: true });

      const width = info.width || 1024;
      const height = info.height || 1024;

      const logoBuffer = fs.readFileSync(logoPath);

      const pct = 0.21;
      const minLogoPx = 168;
      const maxLogoPx = 236;
      const maxCanvasShare = 0.4;

      let targetLogoWidth = Math.round(width * pct);
      targetLogoWidth = Math.min(maxLogoPx, Math.max(minLogoPx, targetLogoWidth));
      targetLogoWidth = Math.min(targetLogoWidth, Math.floor(width * maxCanvasShare));
      targetLogoWidth = Math.max(56, targetLogoWidth);

      const hiW = Math.min(targetLogoWidth * 3, 900);
      const logoHi = await sharp(logoBuffer)
        .resize({
          width: hiW,
          kernel: lanczos,
          withoutEnlargement: false,
        })
        .ensureAlpha()
        .png()
        .toBuffer();

      const logoResized = await sharp(logoHi)
        .resize({
          width: targetLogoWidth,
          kernel: lanczos,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();

      const logoMeta = await sharp(logoResized).metadata();
      const lw = logoMeta.width || 0;
      const lh = logoMeta.height || 0;
      // Tight to bottom-right (avoid large %-based padding that “floats” the mark inward)
      const margin = 4;
      const left = Math.max(0, width - lw - margin);
      const top = Math.max(0, height - lh - margin);

      return await sharp(resizedBuf)
        .composite([{ input: logoResized, left, top }])
        .jpeg({
          quality: 85,
          mozjpeg: true,
          progressive: true,
          chromaSubsampling: '4:4:4',
        })
        .toBuffer();
    } catch (error) {
      this.logger.error('Watermark failed:', (error as Error).message);
      return this.optimizeImage(imageBuffer, maxWidth);
    }
  }

  async uploadToMinio(
    buffer: Buffer,
    fileName: string,
    contentType: string,
    userId: string,
  ): Promise<string> {
    try {
      const bucketName = 'contentos-media';
      const objectName = `${userId}/${Date.now()}-${fileName}`;

      await this.minioService.uploadFile(
        bucketName,
        objectName,
        buffer,
        contentType,
      );

      // Generate public URL
      const publicUrl = await this.minioService.getPublicUrl(
        bucketName,
        objectName,
      );

      return publicUrl;
    } catch (error) {
      this.logger.error('Failed to upload to MinIO:', error.message);
      throw new Error(`File upload failed: ${error.message}`);
    }
  }

  private escapeHtml(text: string): string {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  private sanitizeOverlayText(input: string): string {
    return String(input || '')
      .normalize('NFKD')
      .replace(/[^\x20-\x7E\n]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Rate limiting helper
  async checkRateLimit(userId: string, endpoint: string): Promise<boolean> {
    const key = `rate_limit:${userId}:${endpoint}`;
    const current = await this.cacheService.get(key);

    if (!current) {
      await this.cacheService.set(key, '1', 3600); // 1 hour
      return true;
    }

    const count = parseInt(current, 10);
    const maxRequests = this.getMaxRequestsForEndpoint(endpoint);

    if (count >= maxRequests) {
      return false;
    }

    await this.cacheService.set(key, (count + 1).toString(), 3600);
    return true;
  }

  private getMaxRequestsForEndpoint(endpoint: string): number {
    const limits = {
      'image-generation': 50,
      'carousel-generation': 20,
      'pdf-generation': 30,
    };
    return limits[endpoint] || 100;
  }
}
