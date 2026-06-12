import { Injectable } from '@nestjs/common';
import { MinioService } from '../../services/minio.service';
import type { MediaAttachment } from './types';

// Port for fetching the raw bytes of a media asset so a provider can upload it
// to a platform. Abstracted behind an interface so the LinkedIn publisher can
// be unit-tested with an in-memory fake instead of a live MinIO connection.
export interface MediaByteReader {
  read(asset: MediaAttachment): Promise<Buffer>;
}

export const MEDIA_BYTE_READER = Symbol('MEDIA_BYTE_READER');

// MinIO-backed implementation. `MediaAttachment.storagePath` is the MinIO object
// key; the bucket is the application's configured default bucket
// (`contentos-media`). Media for the social pipeline lives in the SAME bucket as
// the rest of Trndinn's media — there is no parallel store.
@Injectable()
export class MinioMediaByteReader implements MediaByteReader {
  public constructor(private readonly minio: MinioService) {}

  public async read(asset: MediaAttachment): Promise<Buffer> {
    const { bucket, objectKey } = this.resolveLocation(asset.storagePath);
    const stream = await this.minio.getFileStream(bucket, objectKey);
    return streamToBuffer(stream);
  }

  // Accepts either a bare object key ("posts/abc.jpg") or a "bucket/key" form.
  // Bare keys use the default bucket.
  private resolveLocation(storagePath: string): { bucket: string; objectKey: string } {
    const defaultBucket = this.minio.getBucketName();
    const trimmed = storagePath.replace(/^\/+/, '');
    const firstSlash = trimmed.indexOf('/');
    if (firstSlash > 0) {
      const maybeBucket = trimmed.slice(0, firstSlash);
      if (maybeBucket === defaultBucket) {
        return { bucket: defaultBucket, objectKey: trimmed.slice(firstSlash + 1) };
      }
    }
    return { bucket: defaultBucket, objectKey: trimmed };
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}
