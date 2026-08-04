/**
 * MCP Resources (7).
 *
 * Static and templated resources exposed via the MCP protocol. These give
 * Claude Code (and other MCP clients) browseable state — the equivalent of
 * GET endpoints but in the MCP resource model.
 *
 * Resources use the `trndinn://` URI scheme.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolServices } from './tool-registry';

export function registerResources(
  server: McpServer,
  services: McpToolServices,
): void {
  // 1. trndinn://sitemap — all published paths
  server.registerResource(
    'sitemap',
    'trndinn://sitemap',
    {
      description:
        'All published blog post paths with published_at and updated_at timestamps. Useful for sitemap generation or freshness auditing.',
      mimeType: 'application/json',
    },
    async () => {
      const paths = await services.blog.listAllPublishedPathsForSitemap();
      return {
        contents: [
          {
            uri: 'trndinn://sitemap',
            mimeType: 'application/json',
            text: JSON.stringify(paths, null, 2),
          },
        ],
      };
    },
  );

  // 2. trndinn://posts — post index (all statuses, admin view)
  server.registerResource(
    'posts',
    'trndinn://posts',
    {
      description:
        'Index of all blog posts (any status) showing id, title, status, path, tags, and scores.',
      mimeType: 'application/json',
    },
    async () => {
      const result = await services.blog.listAdminPosts();
      return {
        contents: [
          {
            uri: 'trndinn://posts',
            mimeType: 'application/json',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // 3. trndinn://posts/{id} — single post (template)
  server.registerResource(
    'post',
    new ResourceTemplate('trndinn://posts/{id}', { list: undefined }),
    {
      description:
        'Full blog post data by UUID including body and all metadata.',
      mimeType: 'application/json',
    },
    async (_uri, variables) => {
      const id = variables.id as string;
      const post: unknown = await services.blog.getAdminPost(id);
      return {
        contents: [
          {
            uri: `trndinn://posts/${id}`,
            mimeType: 'application/json',
            text: JSON.stringify(post, null, 2),
          },
        ],
      };
    },
  );

  // 4. trndinn://keywords — keyword universe
  server.registerResource(
    'keywords',
    'trndinn://keywords',
    {
      description:
        'Full SEO keyword list (first 200, ordered by priority desc). Use seo_list_keywords tool for filtered/paginated access.',
      mimeType: 'application/json',
    },
    async () => {
      const result = await services.seoKeywords.getAllKeywords({
        limit: 200,
        page: 1,
      });
      return {
        contents: [
          {
            uri: 'trndinn://keywords',
            mimeType: 'application/json',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // 5. trndinn://clusters — content clusters
  server.registerResource(
    'clusters',
    'trndinn://clusters',
    {
      description:
        'SEO keyword clusters with count of active/paused keywords in each.',
      mimeType: 'application/json',
    },
    async () => {
      const clusters = await services.seoKeywords.getClusters();
      return {
        contents: [
          {
            uri: 'trndinn://clusters',
            mimeType: 'application/json',
            text: JSON.stringify({ clusters }, null, 2),
          },
        ],
      };
    },
  );

  // 6. trndinn://static-page-seo — all static page SEO rows
  server.registerResource(
    'static-page-seo',
    'trndinn://static-page-seo',
    {
      description:
        'All static page SEO metadata rows (route_path, seo_title, seo_description, etc.).',
      mimeType: 'application/json',
    },
    async () => {
      const result = await services.blog.listStaticPageSeo();
      return {
        contents: [
          {
            uri: 'trndinn://static-page-seo',
            mimeType: 'application/json',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // 7. trndinn://schemas/{id} — post JSON-LD structured data
  server.registerResource(
    'schemas',
    new ResourceTemplate('trndinn://schemas/{id}', { list: undefined }),
    {
      description:
        'JSON-LD structured_data field for a blog post (by UUID). Returns the raw structured_data object stored on the post.',
      mimeType: 'application/json',
    },
    async (_uri, variables) => {
      const id = variables.id as string;
      const post: Record<string, unknown> = (await services.blog.getAdminPost(
        id,
      )) as Record<string, unknown>;
      const structured = post.structured_data ?? null;
      return {
        contents: [
          {
            uri: `trndinn://schemas/${id}`,
            mimeType: 'application/json',
            text: JSON.stringify(structured, null, 2),
          },
        ],
      };
    },
  );
}
