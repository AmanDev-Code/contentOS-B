import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Zod schema for Instagram Reel download request.
 * Validates that the URL is a legitimate Instagram reel/post/share URL.
 */
export const InstagramReelDownloadSchema = z.object({
  url: z
    .string()
    .min(1, 'Instagram URL is required')
    .url('Must be a valid URL')
    .refine(
      (url) => {
        try {
          const parsed = new URL(url);
          return (
            parsed.hostname === 'www.instagram.com' ||
            parsed.hostname === 'instagram.com'
          );
        } catch {
          return false;
        }
      },
      { message: 'URL must be from instagram.com' },
    )
    .refine(
      (url) => {
        const patterns = [
          /instagram\.com\/p\/[a-zA-Z0-9_-]+/,
          /instagram\.com\/reels?\/[a-zA-Z0-9_-]+/,
          /instagram\.com\/share\/[a-zA-Z0-9_-]+/,
        ];
        return patterns.some((p) => p.test(url));
      },
      {
        message:
          'URL must be an Instagram Reel, Post, or Share link (e.g. instagram.com/reel/ABC123)',
      },
    ),
  // Optional: force a fresh extraction, bypassing the cache. Used by the
  // frontend when a previously-returned CDN URL has expired.
  refresh: z.boolean().optional(),
});

export type InstagramReelDownloadDto = z.infer<
  typeof InstagramReelDownloadSchema
>;

/**
 * NestJS-compatible DTO class for the request body.
 * Actual validation is done via Zod in the controller.
 */
export class InstagramReelDownloadBodyDto {
  @ApiProperty({
    description: 'Instagram Reel, Post, or Share URL',
    example: 'https://www.instagram.com/reel/ABC123/',
  })
  @IsString()
  @IsNotEmpty()
  url: string;
}
