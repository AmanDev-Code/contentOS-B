/**
 * Trndinn Blog MCP — tool registry.
 *
 * Central registry of tool definitions with a scope-check wrapper. Each pack
 * (read.tools.ts, blog-crud.tools.ts, …) exports an array of `McpToolDefinition`
 * that gets registered on the `McpServer` at request time.
 *
 * Defense-in-depth: `AdminOrApiKeyGuard` already gates the /mcp endpoint and
 * validates the caller is a platform admin. The per-tool scope check here
 * additionally enforces that the specific API key carries the required scope
 * (JWT admins get the full scope set — see mcp.controller.ts).
 */

import type { ZodRawShape } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiScope } from '../../services/api-key.service';
import type { BlogService } from '../../services/blog.service';
import type { ContentEngineService } from '../../services/content-engine.service';
import type { SeoKeywordsService } from '../../services/seo-keywords.service';
import type { SeoAiFillService } from '../../services/seo-ai-fill.service';
import type { ProfileRepository } from '../../repositories/profile.repository';

/** Services available to every tool handler. Injected once at module init. */
export interface McpToolServices {
  blog: BlogService;
  contentEngine: ContentEngineService;
  seoKeywords: SeoKeywordsService;
  seoAiFill: SeoAiFillService;
  profileRepo: ProfileRepository;
}

/**
 * Per-request auth context. Populated in `mcp.controller.ts` from
 * `request.user` and `request.apiKey.scopes` (or the full scope list for JWT
 * admins).
 */
export interface McpToolContext {
  user: { id: string; email: string };
  scopes: readonly ApiScope[];
  authMethod: 'jwt' | 'apikey';
}

export interface McpToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  requiredScope: ApiScope;
  inputSchema: Shape;
  /** Handler receives the parsed args + request-scoped context + services. */
  handler: (
    args: Record<string, unknown>,
    ctx: McpToolContext,
    services: McpToolServices,
  ) => Promise<CallToolResult>;
}

/**
 * Standardised success result. Serialises `data` as JSON in a text content
 * block AND mirrors it into `structuredContent` for MCP 2025-06-18 clients
 * that prefer typed data.
 */
export function ok(data: unknown): CallToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const structured: Record<string, unknown> =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

/** Standardised error result. Never throws — the transport surfaces `isError`. */
export function err(
  message: string,
  extra?: Record<string, unknown>,
): CallToolResult {
  const payload: Record<string, unknown> = { error: message, ...(extra ?? {}) };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

/**
 * Wrap a handler with (a) scope check and (b) try/catch that converts any
 * thrown exception into a CallToolResult with `isError: true`. Exceptions must
 * NOT bubble to the transport — they become opaque protocol errors on the
 * client side.
 */
function guardHandler(
  def: McpToolDefinition,
  ctx: McpToolContext,
  services: McpToolServices,
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  return async (args: Record<string, unknown>) => {
    if (!ctx.scopes.includes(def.requiredScope)) {
      return err(
        `Tool "${def.name}" requires scope "${def.requiredScope}". ` +
          `Your API key does not have this scope.`,
        { required_scope: def.requiredScope, granted_scopes: [...ctx.scopes] },
      );
    }
    try {
      return await def.handler(args, ctx, services);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'Unknown error executing tool';
      return err(`Tool "${def.name}" failed: ${message}`);
    }
  };
}

/** Register all tools from a pack onto the given `McpServer`. */
export function registerToolPack(
  server: McpServer,
  pack: readonly McpToolDefinition[],
  ctx: McpToolContext,
  services: McpToolServices,
): void {
  for (const def of pack) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
      },
      guardHandler(def, ctx, services),
    );
  }
}
