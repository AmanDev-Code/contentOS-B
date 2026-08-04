import { Injectable, Logger } from '@nestjs/common';
import { getToolBySlug, isToolActive } from '../registry/tool-registry';
import { ToolDefinition } from '../registry/tool.types';

/**
 * Shared orchestrator for the tools module.
 * Provides cross-tool logic: tool lookup, status checks.
 * Individual tool logic lives in its own subfolder module.
 */
@Injectable()
export class ToolsService {
  private readonly logger = new Logger(ToolsService.name);

  /** Get tool metadata by slug. Returns null if not found. */
  getToolDefinition(slug: string): ToolDefinition | null {
    return getToolBySlug(slug) || null;
  }

  /** Check if a tool is currently available for use. */
  isToolAvailable(slug: string): boolean {
    return isToolActive(slug);
  }
}
