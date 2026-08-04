/**
 * Shared type definitions for the free tools module.
 * Tool-specific types (e.g. InstagramReelResult) live in their own tool folder.
 */

/** Tool category determines rate limit bucket */
export type ToolCategory = 'text-ai' | 'utility' | 'file-processing' | 'file-processing-heavy';

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
