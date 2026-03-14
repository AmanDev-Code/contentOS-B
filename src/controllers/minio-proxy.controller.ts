import {
  Controller,
  Get,
  Req,
  Res,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { MinioService } from '../services/minio.service';
import type { FastifyReply, FastifyRequest } from 'fastify';

@Controller('minio')
export class MinioProxyController {
  private readonly logger = new Logger(MinioProxyController.name);

  constructor(private readonly minioService: MinioService) {}

  @Get('*')
  async proxyFile(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    try {
      // Extract the full path from the request URL
      // URL format: /minio/bucket-name/path/to/file.ext
      const fullPath = req.url.replace('/minio/', '');
      const [bucket, ...pathParts] = fullPath.split('/');
      const path = pathParts.join('/');

      this.logger.log(`Proxying MinIO file: bucket=${bucket}, path=${path}`);

      if (!bucket || !path) {
        throw new HttpException('Invalid MinIO path', HttpStatus.BAD_REQUEST);
      }

      const stream = await this.minioService.getFileStream(bucket, path);

      // Set appropriate headers for Fastify
      res.header('Content-Type', this.getContentType(path));
      res.header('Cache-Control', 'public, max-age=31536000');

      // Send the stream
      return res.send(stream);
    } catch (error) {
      this.logger.error(`Failed to proxy file: ${error.message}`, error.stack);
      throw new HttpException(
        `File not found: ${error.message}`,
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private getContentType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      pdf: 'application/pdf',
      svg: 'image/svg+xml',
    };
    return mimeTypes[ext || ''] || 'application/octet-stream';
  }
}
