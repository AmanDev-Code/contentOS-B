import { SetMetadata } from '@nestjs/common';
import type { ToolCategory } from '../modules/tools/registry/tool.types';

/**
 * Decorator to set the tool rate-limit category on a route handler.
 * Used by ToolRateLimitGuard to determine which rate limit bucket applies.
 *
 * @example
 * @ToolCategoryMeta('utility')
 * @UseGuards(ToolRateLimitGuard)
 * async myEndpoint() { ... }
 */
export const TOOL_CATEGORY_KEY = 'tool_category';

export const ToolCategoryMeta = (category: ToolCategory) =>
  SetMetadata(TOOL_CATEGORY_KEY, category);
