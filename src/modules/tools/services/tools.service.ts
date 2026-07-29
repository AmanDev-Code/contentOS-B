import { Injectable, Logger } from '@nestjs/common';
import { InstagramReelService } from './instagram-reel.service';
import { getToolBySlug, isToolActive } from '../registry/tool-registry';
import { ToolDefinition } from '../registry/tool.types';

/**
 * Orchestrator service for the tools module.
 * Provides shared logic (tool lookup, status checks) and delegates
 * to individual tool services.
 */
@Injectable()
export class ToolsService {
  private readonly logger = new Logger(ToolsService.name);

  constructor(
    private readonly instagramReelService: InstagramReelService,
  ) {}

  /**
   * Get tool metadata by slug. Returns null if not found.
   */
  getToolDefinition(slug: string): ToolDefinition | null {
    return getToolBySlug(slug) || null;
  }

  /**
   * Check if a tool is currently available for use.
   */
  isToolAvailable(slug: string): boolean {
    return isToolActive(slug);
  }

  /**
   * Access the Instagram Reel service for download operations.
   */
  get instagramReel(): InstagramReelService {
    return this.instagramReelService;
  }
}
