import { ToolDefinition } from './tool.types';

/**
 * Master registry of all free tools.
 *
 * Adding a tool here is the single source of truth for:
 * - Route existence
 * - Rate limit category assignment
 * - SEO metadata
 * - Tool status (maintenance mode, etc.)
 */
export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  'instagram-reel-downloader': {
    slug: 'instagram-reel-downloader',
    name: 'Instagram Reel Downloader',
    description:
      'Download Instagram Reels in HD quality. Free, no login required. Paste the reel URL and get the direct video link instantly.',
    category: 'utility',
    status: 'active',
    keywords: [
      'instagram reel downloader',
      'download instagram reels',
      'ig reel download',
      'save instagram reels',
      'instagram video downloader',
    ],
    searchVolume: 110000,
  },
};

/**
 * Look up a tool by slug.
 * Returns undefined if the slug is not registered.
 */
export function getToolBySlug(slug: string): ToolDefinition | undefined {
  return TOOL_REGISTRY[slug];
}

/**
 * Check if a tool slug is registered and active.
 */
export function isToolActive(slug: string): boolean {
  const tool = TOOL_REGISTRY[slug];
  return !!tool && tool.status === 'active';
}
