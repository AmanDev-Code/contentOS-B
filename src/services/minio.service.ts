import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client as MinioClient } from 'minio';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private minioClient: MinioClient;
  private readonly bucketName = 'contentos-media';

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    try {
      this.minioClient = new MinioClient({
        endPoint: this.configService.get<string>('MINIO_ENDPOINT', 'localhost'),
        port: parseInt(this.configService.get<string>('MINIO_PORT', '9000'), 10),
        useSSL: this.configService.get<string>('MINIO_USE_SSL', 'false') === 'true',
        accessKey: this.configService.get<string>('MINIO_ACCESS_KEY'),
        secretKey: this.configService.get<string>('MINIO_SECRET_KEY'),
      });

      // Ensure bucket exists
      await this.ensureBucketExists(this.bucketName);
      this.logger.log('MinIO service initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize MinIO service:', error.message);
      throw error;
    }
  }

  async ensureBucketExists(bucketName: string): Promise<void> {
    try {
      const exists = await this.minioClient.bucketExists(bucketName);
      if (!exists) {
        await this.minioClient.makeBucket(bucketName, 'us-east-1');
        
        // Set bucket policy for public read access
        const policy = {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${bucketName}/*`],
            },
          ],
        };

        await this.minioClient.setBucketPolicy(bucketName, JSON.stringify(policy));
        this.logger.log(`Created bucket: ${bucketName}`);
      }
    } catch (error) {
      this.logger.error(`Failed to ensure bucket exists: ${error.message}`);
      throw error;
    }
  }

  async uploadFile(
    bucketName: string,
    objectName: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<any> {
    try {
      const metaData = {
        'Content-Type': contentType,
        'Cache-Control': 'max-age=31536000', // 1 year
      };

      const result = await this.minioClient.putObject(
        bucketName,
        objectName,
        buffer,
        buffer.length,
        metaData,
      );

      this.logger.log(`File uploaded successfully: ${objectName}`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to upload file: ${error.message}`);
      throw error;
    }
  }

  async getPublicUrl(bucketName: string, objectName: string): Promise<string> {
    try {
      // Check if a public URL is configured (for ngrok/proxy scenarios)
      const publicUrl = this.configService.get<string>('MINIO_PUBLIC_URL');
      
      if (publicUrl) {
        // Use the configured public URL
        return `${publicUrl}/${bucketName}/${objectName}`;
      }
      
      // Fallback to direct MinIO URL
      const endpoint = this.configService.get<string>('MINIO_ENDPOINT', 'localhost');
      const port = this.configService.get<string>('MINIO_PORT', '9000');
      const useSSL = this.configService.get<string>('MINIO_USE_SSL', 'false') === 'true';
      
      const protocol = useSSL ? 'https' : 'http';
      const portSuffix = (useSSL && port === '443') || (!useSSL && port === '80') ? '' : `:${port}`;
      
      return `${protocol}://${endpoint}${portSuffix}/${bucketName}/${objectName}`;
    } catch (error) {
      this.logger.error(`Failed to generate public URL: ${error.message}`);
      throw error;
    }
  }

  async getFileStream(bucketName: string, objectName: string): Promise<any> {
    try {
      this.logger.log(`Getting file stream: bucket=${bucketName}, object=${objectName}`);
      const stream = await this.minioClient.getObject(bucketName, objectName);
      this.logger.log(`File stream retrieved successfully`);
      return stream;
    } catch (error) {
      this.logger.error(`Failed to get file stream from bucket=${bucketName}, object=${objectName}: ${error.message}`);
      throw error;
    }
  }

  async deleteFile(bucketName: string, objectName: string): Promise<void> {
    try {
      await this.minioClient.removeObject(bucketName, objectName);
      this.logger.log(`File deleted successfully: ${objectName}`);
    } catch (error) {
      this.logger.error(`Failed to delete file: ${error.message}`);
      throw error;
    }
  }

  async listFiles(
    bucketName: string,
    prefix?: string,
    maxKeys = 1000,
  ): Promise<any[]> {
    try {
      const stream = this.minioClient.listObjects(bucketName, prefix, true);
      const objects: any[] = [];

      return new Promise((resolve, reject) => {
        stream.on('data', (obj: any) => {
          if (objects.length < maxKeys) {
            objects.push(obj);
          }
        });

        stream.on('end', () => {
          resolve(objects);
        });

        stream.on('error', (err) => {
          reject(err);
        });
      });
    } catch (error) {
      this.logger.error(`Failed to list files: ${error.message}`);
      throw error;
    }
  }

  async getFileStats(bucketName: string, objectName: string): Promise<any> {
    try {
      return await this.minioClient.statObject(bucketName, objectName);
    } catch (error) {
      this.logger.error(`Failed to get file stats: ${error.message}`);
      throw error;
    }
  }

  async generatePresignedUrl(
    bucketName: string,
    objectName: string,
    expiry = 7 * 24 * 60 * 60, // 7 days
  ): Promise<string> {
    try {
      return await this.minioClient.presignedGetObject(bucketName, objectName, expiry);
    } catch (error) {
      this.logger.error(`Failed to generate presigned URL: ${error.message}`);
      throw error;
    }
  }
}