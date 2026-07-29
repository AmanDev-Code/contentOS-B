/**
 * Shared type definitions for the free tools module.
 */

/** Tool category determines rate limit bucket */
export type ToolCategory = 'text-ai' | 'utility' | 'file-processing';

/** Status of a registered tool */
export type ToolStatus = 'active' | 'maintenance' | 'disabled';

/** Metadata for a registered tool */
export interface ToolDefinition {
  /** URL-safe slug (used in route path) */
  slug: string;
  /** Human-readable name */
  name: string;
  /** Short description for SEO/meta */
  description: string;
  /** Rate limit category */
  category: ToolCategory;
  /** Current status */
  status: ToolStatus;
  /** SEO keywords */
  keywords?: string[];
  /** Monthly search volume (for prioritization) */
  searchVolume?: number;
}

/** Standard tool API response */
export interface ToolResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

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
