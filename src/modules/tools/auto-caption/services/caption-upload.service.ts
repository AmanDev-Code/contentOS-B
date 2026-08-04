/**
 * CaptionUploadService — MinIO presigned uploads + SHA256 dedup.
 *
 * Lightweight: delegates all heavy lifting to MinioService.
 * Handles dedup via Redis (inputHash + styleId → cached result).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';

import { MinioService } from '../../../../services/minio.service';
import { CacheService } from '../../../../services/cache.service';
import { loadAutoCaptionConfig, CAPTION_REDIS } from '../config';

@Injectable()
export class CaptionUploadService {
  private readonly logger = new Logger(CaptionUploadService.name);
  private readonly bucket: string;
  private readonly resultTtl: number;

  constructor(
    private readonly minio: MinioService,
    private readonly cache: CacheService,
  ) {
    const config = loadAutoCaptionConfig();
    this.bucket = config.bucket;
    this.resultTtl = config.resultTtlSec;
  }

  /** Ensure bucket exists on startup */
  async init(): Promise<void> {
    await this.minio.ensureBucketExists(this.bucket);
  }

  /**
   * Upload a buffer directly to MinIO (used by the /upload multipart endpoint).
   */
  async uploadBuffer(buffer: Buffer, objectPath: string, contentType: string): Promise<void> {
    await this.minio.uploadFile(this.bucket, objectPath, buffer, contentType);
  }

  /**
   * Generate presigned PUT URL for client upload.
   * Returns { uploadUrl, objectPath }.
   */
  async getPresignedUpload(filename: string, contentType: string): Promise<{
    uploadUrl: string;
    objectPath: string;
  }> {
    const id = crypto.randomUUID();
    const ext = filename.split('.').pop() || 'mp4';
    const objectPath = `caption-input/${id}.${ext}`;

    // Use presigned GET URL for now (client will PUT via direct MinIO SDK)
    const uploadUrl = await this.minio.generatePresignedUrl(
      this.bucket,
      objectPath,
      15 * 60, // 15 min expiry
    );

    return { uploadUrl, objectPath };
  }

  /**
   * Upload a local file to MinIO (server-side, for output).
   */
  async uploadOutput(localPath: string, outputKey: string): Promise<string> {
    const contentType = outputKey.endsWith('.srt')
      ? 'text/plain'
      : outputKey.endsWith('.vtt')
        ? 'text/vtt'
        : 'video/mp4';

    const buffer = await fs.promises.readFile(localPath);
    await this.minio.uploadFile(this.bucket, outputKey, buffer, contentType);
    return outputKey;
  }

  /**
   * Get presigned download URL for output file.
   */
  async getDownloadUrl(objectPath: string): Promise<string> {
    return this.minio.generatePresignedUrl(
      this.bucket,
      objectPath,
      this.resultTtl,
    );
  }

  /**
   * Download input file from MinIO to local temp path.
   */
  async downloadToLocal(objectPath: string, localPath: string): Promise<void> {
    const stream = await this.minio.getFileStream(this.bucket, objectPath);
    const writeStream = fs.createWriteStream(localPath);
    await new Promise<void>((resolve, reject) => {
      stream.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      stream.on('error', reject);
    });
  }

  /**
   * Compute SHA256 of a local file.
   */
  async computeHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Check dedup cache: has this exact input+style been processed before?
   */
  async getDedupResult(inputHash: string, styleKey: string): Promise<string | null> {
    const key = `${CAPTION_REDIS.DEDUP}:${inputHash}:${styleKey}`;
    return this.cache.get(key);
  }

  /**
   * Store dedup result: map inputHash+style → output path.
   */
  async setDedupResult(inputHash: string, styleKey: string, outputPath: string): Promise<void> {
    const key = `${CAPTION_REDIS.DEDUP}:${inputHash}:${styleKey}`;
    await this.cache.set(key, outputPath, this.resultTtl);
  }

  /**
   * Delete an object from MinIO (cleanup).
   */
  async deleteObject(objectPath: string): Promise<void> {
    try {
      await this.minio.deleteFile(this.bucket, objectPath);
    } catch (e) {
      this.logger.warn(`Failed to delete ${objectPath}: ${e.message}`);
    }
  }

  /**
   * List objects with prefix older than TTL for cleanup.
   */
  async listExpiredObjects(prefix: string, maxAgeMs: number): Promise<string[]> {
    const objects = await this.minio.listFiles(this.bucket, prefix, 1000);
    const now = Date.now();
    return objects
      .filter((obj: any) => {
        const age = now - new Date(obj.lastModified).getTime();
        return age > maxAgeMs;
      })
      .map((obj: any) => obj.name);
  }
}
