import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private minioClient: Minio.Client;
  private readonly bucketName: string;

  constructor(private configService: ConfigService) {
    const endpoint = this.configService.get<string>('minio.endpoint') || 'localhost';
    const port = parseInt(this.configService.get<string>('minio.port') || '9000');
    const accessKey = this.configService.get<string>('minio.accessKey') || 'minioadmin';
    const secretKey = this.configService.get<string>('minio.secretKey') || 'minioadmin';
    this.bucketName = this.configService.get<string>('minio.bucket') || 'contentos-assets';

    this.minioClient = new Minio.Client({
      endPoint: endpoint,
      port: port,
      useSSL: false, // Set to true in production with proper SSL
      accessKey: accessKey,
      secretKey: secretKey,
    });
  }

  async onModuleInit() {
    try {
      // Check if bucket exists, create if not
      const bucketExists = await this.minioClient.bucketExists(this.bucketName);
      if (!bucketExists) {
        await this.minioClient.makeBucket(this.bucketName, 'us-east-1');
        this.logger.log(`Created bucket: ${this.bucketName}`);
      }
      this.logger.log('MinIO service initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize MinIO service', error);
    }
  }

  async uploadImage(
    fileName: string,
    buffer: Buffer,
    contentType: string = 'image/png',
    folder: string = 'images'
  ): Promise<string> {
    try {
      const objectName = `${folder}/${fileName}`;
      
      await this.minioClient.putObject(
        this.bucketName,
        objectName,
        buffer,
        buffer.length,
        {
          'Content-Type': contentType,
          'Cache-Control': 'max-age=31536000', // 1 year cache
        }
      );

      // Generate public URL
      const publicUrl = `http://localhost:9000/${this.bucketName}/${objectName}`;
      
      this.logger.log(`Uploaded image: ${objectName}`);
      return publicUrl;
    } catch (error) {
      this.logger.error(`Failed to upload image: ${fileName}`, error);
      throw error;
    }
  }

  async uploadCarouselSlides(
    contentId: string,
    slides: Buffer[],
    contentType: string = 'image/png'
  ): Promise<string[]> {
    const urls: string[] = [];
    
    for (let i = 0; i < slides.length; i++) {
      const fileName = `${contentId}-slide-${i + 1}.png`;
      const url = await this.uploadImage(fileName, slides[i], contentType, 'carousel');
      urls.push(url);
    }
    
    return urls;
  }

  async deleteImage(objectName: string): Promise<void> {
    try {
      await this.minioClient.removeObject(this.bucketName, objectName);
      this.logger.log(`Deleted image: ${objectName}`);
    } catch (error) {
      this.logger.error(`Failed to delete image: ${objectName}`, error);
      throw error;
    }
  }

  async getImageUrl(objectName: string, expiry: number = 24 * 60 * 60): Promise<string> {
    try {
      return await this.minioClient.presignedGetObject(this.bucketName, objectName, expiry);
    } catch (error) {
      this.logger.error(`Failed to get image URL: ${objectName}`, error);
      throw error;
    }
  }

  getPublicUrl(objectName: string): string {
    return `http://localhost:9000/${this.bucketName}/${objectName}`;
  }
}