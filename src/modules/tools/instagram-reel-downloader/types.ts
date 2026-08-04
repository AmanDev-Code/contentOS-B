/**
 * Instagram Reel Downloader — Types
 */

/** Instagram Reel download result */
export interface InstagramReelResult {
  videoUrl: string;
  thumbnailUrl: string | null;
  width: number;
  height: number;
  caption: string | null;
  author: string | null;
  duration: number | null;
}
