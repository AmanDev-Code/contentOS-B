/**
 * McpService — creates per-request McpServer instances with tools + resources
 * pre-registered for the authenticated caller's scope set.
 *
 * Uses ModuleRef to grab the singleton service instances that live in AppModule
 * (BlogService, ContentEngineService, SeoKeywordsService) without re-providing
 * or double-instantiating them.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiScope } from '../../services/api-key.service';
import { BlogService } from '../../services/blog.service';
import { ContentEngineService } from '../../services/content-engine.service';
import { SeoKeywordsService } from '../../services/seo-keywords.service';
import { SeoAiFillService } from '../../services/seo-ai-fill.service';
import { ProfileRepository } from '../../repositories/profile.repository';
import {
  registerToolPack,
  type McpToolContext,
  type McpToolServices,
} from './tool-registry';
import { readTools } from './tools/read.tools';
import { blogCrudTools } from './tools/blog-crud.tools';
import { aiWritingTools } from './tools/ai-writing.tools';
import { optimizationTools } from './tools/optimization.tools';
import { imageTools } from './tools/image.tools';
import { linksTools } from './tools/links.tools';
import { keywordsTools } from './tools/keywords.tools';
import { pageSeoTools } from './tools/page-seo.tools';
import { distributionTools } from './tools/distribution.tools';
import { rankingsTools } from './tools/rankings.tools';
import { registerResources } from './resources';
import { registerPrompts } from './prompts';

@Injectable()
export class McpService implements OnModuleInit {
  private readonly logger = new Logger(McpService.name);
  private services!: McpToolServices;

  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit() {
    // Resolve singletons from root module context (strict: false = search all modules)
    this.services = {
      blog: this.moduleRef.get(BlogService, { strict: false }),
      contentEngine: this.moduleRef.get(ContentEngineService, {
        strict: false,
      }),
      seoKeywords: this.moduleRef.get(SeoKeywordsService, { strict: false }),
      seoAiFill: this.moduleRef.get(SeoAiFillService, { strict: false }),
      profileRepo: this.moduleRef.get(ProfileRepository, { strict: false }),
    };
    this.logger.log(
      'McpService initialised — services resolved from module context',
    );
  }

  /**
   * Create a fresh McpServer for this request, pre-registered with only the
   * tools/resources that the caller's scopes grant access to. The server is
   * stateless (no sessions) — it processes one JSON-RPC batch and is discarded.
   */
  createServerForRequest(ctx: McpToolContext): McpServer {
    const server = new McpServer(
      { name: 'trndinn-blog-mcp', version: '1.0.0' },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      },
    );

    // Register tool packs
    registerToolPack(server, readTools, ctx, this.services);
    registerToolPack(server, blogCrudTools, ctx, this.services);
    registerToolPack(server, aiWritingTools, ctx, this.services);
    registerToolPack(server, optimizationTools, ctx, this.services);
    registerToolPack(server, imageTools, ctx, this.services);
    registerToolPack(server, linksTools, ctx, this.services);
    registerToolPack(server, keywordsTools, ctx, this.services);
    registerToolPack(server, pageSeoTools, ctx, this.services);
    registerToolPack(server, distributionTools, ctx, this.services);
    registerToolPack(server, rankingsTools, ctx, this.services);

    // Register resources (resources are read-only; access is gated at the
    // transport/guard level, not per-resource)
    registerResources(server, this.services);

    // Register workflow prompts (guide Claude through multi-tool chains)
    registerPrompts(server);

    return server;
  }

  /**
   * Full scope list for JWT-authenticated platform admins. They bypass
   * per-tool scope checks (mirrors AdminOrApiKeyGuard semantics).
   */
  static readonly ALL_SCOPES: readonly ApiScope[] = [
    'blog:read',
    'blog:write',
    'content-engine:read',
    'content-engine:write',
    'seo:read',
    'seo:write',
    'media:write',
    'posts:read',
    'posts:write',
    'accounts:read',
    'accounts:write',
  ];
}
