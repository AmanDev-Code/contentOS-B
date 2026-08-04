/**
 * MCP Controller — `POST /mcp`
 *
 * Handles MCP Streamable HTTP transport. Each request is independently
 * authenticated via `AdminOrApiKeyGuard`, then a per-request `McpServer` is
 * spun up with the caller's scope set and connected to a stateless
 * `StreamableHTTPServerTransport`.
 *
 * Fastify adapter: NestJS wraps Fastify requests, but the MCP SDK transport
 * expects Node.js `IncomingMessage`/`ServerResponse`. We access the raw
 * objects via `req.raw` and `reply.raw`, and hijack the Fastify reply so it
 * doesn't double-send headers.
 */

import { Controller, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AdminOrApiKeyGuard } from '../../guards/admin-or-apikey.guard';
import type { AdminOrApiKeyRequest } from '../../guards/admin-or-apikey.guard';
import type { ApiScope } from '../../services/api-key.service';
import { McpService } from './mcp.service';
import type { McpToolContext } from './tool-registry';

@ApiExcludeController()
@Controller('mcp')
@UseGuards(AdminOrApiKeyGuard)
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(private readonly mcpService: McpService) {}

  @Post()
  async handleMcp(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Build auth context from the guard-populated request
    const authReq = req as unknown as AdminOrApiKeyRequest;
    const user = authReq.user;
    if (!user) {
      // Should never happen (guard would have thrown), but defensive
      reply.status(401).send({ error: 'Unauthenticated' });
      return;
    }

    const scopes = this.resolveScopes(authReq);
    const ctx: McpToolContext = {
      user: { id: user.id, email: user.email },
      scopes,
      authMethod: user.authMethod,
    };

    // Create a per-request MCP server with tools scoped to this user's permissions
    const mcpServer = this.mcpService.createServerForRequest(ctx);

    // Create a stateless transport (no session tracking)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    // Connect transport to server
    await mcpServer.connect(transport);

    try {
      // Hijack Fastify response so it doesn't interfere with Node raw writes
      reply.hijack();

      // Delegate to the MCP transport — it reads from req.raw and writes to reply.raw
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (e) {
      this.logger.error(
        `MCP request failed: ${(e as Error).message}`,
        (e as Error).stack,
      );
      // If headers haven't been sent yet, send a 500
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: 'Internal MCP error' }));
      }
    } finally {
      // Close transport + server to free resources (stateless = no lingering state)
      await transport.close();
      await mcpServer.close();
    }
  }

  /**
   * JWT admins get the full scope set (they bypass scope gates in the guard).
   * API-key admins get exactly the scopes their key carries.
   */
  private resolveScopes(req: AdminOrApiKeyRequest): readonly ApiScope[] {
    if (req.user?.authMethod === 'jwt') {
      return McpService.ALL_SCOPES;
    }
    const apiKey = req.apiKey;
    return (apiKey?.scopes ?? []) as ApiScope[];
  }
}
