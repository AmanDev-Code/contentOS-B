import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
// Removed puppeteer - using lighter HTML to image conversion
import { MinioService } from './minio.service';
import { CacheService } from './cache.service';

export interface ImageGenerationRequest {
  prompt: string;
  size?: '1024x1024' | '1792x1024' | '1024x1792';
  quality?: 'standard' | 'hd';
  style?: 'vivid' | 'natural';
}

export interface CarouselSlide {
  headline: string;
  body: string;
  imagePrompt: string;
}

export interface CarouselGenerationRequest {
  slides: CarouselSlide[];
  style?: 'professional' | 'creative' | 'minimal';
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
      this.logger.log(
        `Generating single image with prompt: ${request.prompt.substring(0, 50)}...`,
      );

      const response = await axios.post(
        'https://api.openai.com/v1/images/generations',
        {
          model: 'dall-e-3',
          prompt: request.prompt,
          size: request.size || '1024x1024',
          quality: request.quality || 'hd',
          style: request.style || 'natural',
          response_format: 'b64_json',
          n: 1,
        },
        {
          headers: {
            Authorization: `Bearer ${this.openaiApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000, // 60 seconds
        },
      );

      const base64Image = response.data.data[0].b64_json;
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
      this.logger.log(
        `Generating carousel with ${request.slides.length} slides`,
      );

      const imagePromises = request.slides.map((slide) =>
        this.generateSingleImage({
          prompt: slide.imagePrompt,
          size: '1024x1024',
          quality: 'hd',
          style: 'natural',
        }),
      );

      return await Promise.all(imagePromises);
    } catch (error) {
      this.logger.error('Failed to generate carousel images:', error.message);
      throw new Error(`Carousel generation failed: ${error.message}`);
    }
  }

  async createCarouselSlideHTML(
    slide: CarouselSlide,
    imageBase64: string,
  ): Promise<string> {
    return `
      <div class="slide">
        <img class="bg" src="data:image/png;base64,${imageBase64}" />
        <div class="overlay"></div>
        <div class="content">
          <h1>${this.escapeHtml(slide.headline)}</h1>
          <p>${this.escapeHtml(slide.body)}</p>
        </div>
      </div>
    `;
  }

  async generateCarouselPDF(
    request: CarouselGenerationRequest,
  ): Promise<Buffer> {
    try {
      this.logger.log('Generating carousel PDF using HTML2Image API');

      // Generate all images
      const imageBuffers = await this.generateCarouselImages(request);

      // Convert images to base64
      const imageBase64Array = imageBuffers.map((buffer) =>
        buffer.toString('base64'),
      );

      // Create HTML slides
      const slideHTMLPromises = request.slides.map((slide, index) =>
        this.createCarouselSlideHTML(slide, imageBase64Array[index]),
      );

      const slidesHTML = await Promise.all(slideHTMLPromises);

      // Create complete HTML document
      const fullHTML = `
        <html>
        <head>
          <meta charset="UTF-8" />
          <style>
            html, body {
              margin: 0;
              padding: 0;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              width: 1024px;
              height: ${request.slides.length * 1024}px;
            }
            
            * {
              box-sizing: border-box;
            }
            
            .slide {
              width: 1024px;
              height: 1024px;
              position: relative;
              overflow: hidden;
              display: block;
            }
            
            .bg {
              position: absolute;
              top: 0;
              left: 0;
              width: 1024px;
              height: 1024px;
              object-fit: cover;
            }
            
            .overlay {
              position: absolute;
              top: 0;
              left: 0;
              width: 1024px;
              height: 1024px;
              background: linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.6) 100%);
            }
            
            .content {
              position: absolute;
              bottom: 80px;
              left: 60px;
              right: 60px;
              color: white;
              z-index: 10;
            }
            
            h1 {
              font-size: 48px;
              font-weight: 700;
              margin: 0;
              line-height: 1.1;
              color: white;
              text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
              margin-bottom: 20px;
            }
            
            p {
              font-size: 24px;
              font-weight: 400;
              margin: 0;
              line-height: 1.3;
              color: white;
              text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
            }
          </style>
        </head>
        <body>
          ${slidesHTML.join('')}
        </body>
        </html>
      `;

      // Use HTML2Image API to convert HTML to PDF
      const pdfBuffer = await this.convertHTMLToPDF(fullHTML);

      this.logger.log('Carousel PDF generated successfully');
      return pdfBuffer;
    } catch (error) {
      this.logger.error('Failed to generate carousel PDF:', error.message);
      throw new Error(`Carousel PDF generation failed: ${error.message}`);
    }
  }

  private async convertHTMLToPDF(html: string): Promise<Buffer> {
    try {
      // Use html2image.net API for PDF conversion
      const response = await axios.post(
        'https://www.html2image.net/api/api.php',
        new URLSearchParams({
          key: 'h2i_15af0e0966edd0dfd227cb46dbcf12df', // Free API key
          type: 'pdf',
          width: '1024',
          height: '1024',
          fullpage: 'true',
          zoom: '1',
          margin: '0',
          source: html,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 60000, // 60 seconds
        },
      );

      if (response.data && response.data.Link) {
        // Download the generated PDF
        const pdfResponse = await axios.get(response.data.Link, {
          responseType: 'arraybuffer',
          timeout: 30000,
        });

        return Buffer.from(pdfResponse.data);
      } else {
        throw new Error('Failed to get PDF download link from HTML2Image API');
      }
    } catch (error) {
      this.logger.error('HTML to PDF conversion failed:', error.message);

      // Fallback: create a simple PDF-like image using Sharp
      return await this.createFallbackCarouselImage(html);
    }
  }

  private async createFallbackCarouselImage(html: string): Promise<Buffer> {
    try {
      this.logger.log('Using fallback method to create carousel image');

      // Create a simple image with text overlay as fallback
      const width = 1024;
      const height = 1024;

      // Create a gradient background
      const gradientSvg = `
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#667eea;stop-opacity:1" />
              <stop offset="100%" style="stop-color:#764ba2;stop-opacity:1" />
            </linearGradient>
          </defs>
          <rect width="100%" height="100%" fill="url(#grad)" />
          <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="48" font-weight="bold" 
                text-anchor="middle" dominant-baseline="middle" fill="white">
            Carousel Content
          </text>
          <text x="50%" y="70%" font-family="Arial, sans-serif" font-size="24" 
                text-anchor="middle" dominant-baseline="middle" fill="rgba(255,255,255,0.8)">
            Generated by Trndinn
          </text>
        </svg>
      `;

      return await sharp(Buffer.from(gradientSvg)).png().toBuffer();
    } catch (error) {
      this.logger.error('Fallback carousel generation failed:', error.message);
      throw new Error('All carousel generation methods failed');
    }
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
