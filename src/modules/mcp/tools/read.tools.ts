/**
 * Pack A — Read / discovery tools (11).
 *
 * All handlers are thin wrappers over existing services. No business logic
 * lives here. Every tool declares its `requiredScope` — the registry enforces
 * it before calling the handler.
 */

import { z } from 'zod';
import type { McpToolDefinition } from '../tool-registry';
import { ok } from '../tool-registry';

const BlogPostStatusEnum = z
  .enum(['draft', 'scheduled', 'published', 'archived'])
  .describe('Blog post status filter');

const SeoTargetTypeEnum = z
  .enum(['route', 'page_type', 'blog_post', 'template'])
  .describe('SEO keyword assignment target type');

const SeoKeywordStatusEnum = z.enum(['active', 'paused', 'archived', 'banned']);

const SeoKeywordIntentEnum = z.enum([
  'informational',
  'commercial',
  'transactional',
  'navigational',
]);

export const readTools: readonly McpToolDefinition[] = [
  {
    name: 'blog_list_posts',
    description:
      'List all blog posts (any status) for the admin CMS view. Returns id, path, slug, title, status, tags, and SEO/AEO/GEO scores. Use blog_search_posts for full-text search over title/path/id.',
    requiredScope: 'blog:read',
    inputSchema: {
      status: BlogPostStatusEnum.optional().describe(
        'Filter by status: draft, scheduled, published, or archived.',
      ),
      q: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Case-insensitive substring match against title, path, and id.',
        ),
    },
    handler: async (args, _ctx, services) => {
      const { status, q } = args as { status?: string; q?: string };
      const result = await services.blog.listAdminPosts({ status, q });
      return ok(result);
    },
  },

  {
    name: 'blog_get_post',
    description:
      'Fetch a single blog post by id, including all admin fields (body, SEO metadata, structured_data, FAQ, TOC, scheduling settings).',
    requiredScope: 'blog:read',
    inputSchema: {
      id: z.string().uuid().describe('Blog post UUID.'),
    },
    handler: async (args, _ctx, services) => {
      const { id } = args as { id: string };
      const post: unknown = await services.blog.getAdminPost(id);
      return ok(post);
    },
  },

  {
    name: 'blog_search_posts',
    description:
      'Search blog posts (any status) by title, path, or id substring. Optional status filter. Thin wrapper over blog_list_posts with a required query.',
    requiredScope: 'blog:read',
    inputSchema: {
      q: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe('Search query — matches title, path, id (case-insensitive).'),
      status: BlogPostStatusEnum.optional(),
    },
    handler: async (args, _ctx, services) => {
      const { q, status } = args as { q: string; status?: string };
      const result = await services.blog.listAdminPosts({ q, status });
      return ok(result);
    },
  },

  {
    name: 'seo_list_keywords',
    description:
      'List SEO keywords with filters (status, cluster, intent, free-text). Paginated (page/limit).',
    requiredScope: 'seo:read',
    inputSchema: {
      status: SeoKeywordStatusEnum.optional(),
      cluster: z.string().trim().min(1).max(100).optional(),
      intent: SeoKeywordIntentEnum.optional(),
      q: z.string().trim().min(1).max(200).optional(),
      page: z.number().int().min(1).default(1).optional(),
      limit: z.number().int().min(1).max(200).default(50).optional(),
    },
    handler: async (args, _ctx, services) => {
      const filters = args as {
        status?: string;
        cluster?: string;
        intent?: string;
        q?: string;
        page?: number;
        limit?: number;
      };
      const result = await services.seoKeywords.getAllKeywords(filters);
      return ok(result);
    },
  },

  {
    name: 'seo_list_clusters',
    description:
      'List SEO keyword clusters with counts of active/paused/total keywords per cluster.',
    requiredScope: 'seo:read',
    inputSchema: {},
    handler: async (_args, _ctx, services) => {
      const clusters = await services.seoKeywords.getClusters();
      return ok({ clusters });
    },
  },

  {
    name: 'seo_get_assignments',
    description:
      'Get all SEO keyword assignments for a specific target (route, page_type, blog_post, or template). Returns assignments ordered by primary flag then weight.',
    requiredScope: 'seo:read',
    inputSchema: {
      target_type: SeoTargetTypeEnum,
      target_ref: z
        .string()
        .trim()
        .min(1)
        .max(512)
        .describe(
          'Target identifier: route path (e.g. "/pricing"), page_type slug, blog post UUID, or template key.',
        ),
    },
    handler: async (args, _ctx, services) => {
      const { target_type, target_ref } = args as {
        target_type: string;
        target_ref: string;
      };
      const assignments = await services.seoKeywords.getAssignments(
        target_type,
        target_ref,
      );
      return ok({ assignments });
    },
  },

  {
    name: 'content_engine_dashboard',
    description:
      'Fetch Content Engine dashboard stats: total/published/draft/scheduled counts, average SEO score, cluster count, distributed count, and 10 most recently updated posts.',
    requiredScope: 'content-engine:read',
    inputSchema: {},
    handler: async (_args, _ctx, services) => {
      const stats = await services.contentEngine.getDashboardStats();
      return ok(stats);
    },
  },

  {
    name: 'content_engine_scores',
    description:
      'Fetch the SEO/AEO/GEO/E-E-A-T/readability/quality scores for a specific blog post.',
    requiredScope: 'content-engine:read',
    inputSchema: {
      post_id: z.string().uuid(),
    },
    handler: async (args, _ctx, services) => {
      const { post_id } = args as { post_id: string };
      const scores = await services.contentEngine.getScores(post_id);
      return ok(scores);
    },
  },

  {
    name: 'content_engine_optimize_report',
    description:
      'Fetch the full AEO+GEO optimization report for a post: per-criterion scores, prioritised suggestions, and combined recommendations. Uses ContentEngineService.getOptimizationReport.',
    requiredScope: 'content-engine:read',
    inputSchema: {
      post_id: z.string().uuid(),
    },
    handler: async (args, _ctx, services) => {
      const { post_id } = args as { post_id: string };
      const report =
        await services.contentEngine.getOptimizationReport(post_id);
      return ok(report);
    },
  },

  {
    name: 'rankings_overview',
    description:
      'Fetch the keyword-rankings overview: aggregate counts, average position, and per-keyword current rank + delta.',
    requiredScope: 'content-engine:read',
    inputSchema: {},
    handler: async (_args, _ctx, services) => {
      const overview = await services.contentEngine.getRankingOverview();
      return ok(overview);
    },
  },

  {
    name: 'backlinks_stats',
    description:
      'Fetch the backlinks dashboard summary: opportunity counts by status/type, profile counts by tier, and totals.',
    requiredScope: 'content-engine:read',
    inputSchema: {},
    handler: async (_args, _ctx, services) => {
      const stats = await services.contentEngine.getBacklinkStats();
      return ok(stats);
    },
  },
];
