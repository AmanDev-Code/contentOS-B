/**
 * Pack H — Static page SEO tools (5).
 *
 * Wraps BlogService static_page_seo CRUD and SeoAiFillService for AI-driven
 * meta-field generation. `page_seo_delete` is destructive.
 *
 * Method signatures matched exactly against blog.service.ts:
 *   listStaticPageSeo(): { pages: [...] }
 *   getStaticPageSeo(routePath): row | null
 *   upsertStaticPageSeo(StaticPageSeoInput): row
 *   deleteStaticPageSeo(routePath): { success: true }
 *   SeoAiFillService.generateSeoFields({ route, prompt?, primaryKeyword? })
 */

import { z } from 'zod';
import type { McpToolDefinition } from '../tool-registry';
import { ok, err } from '../tool-registry';
import type { StaticPageSeoInput } from '../../../services/blog.service';

export const pageSeoTools: readonly McpToolDefinition[] = [
  {
    name: 'page_seo_list',
    description:
      'List all static page SEO rows (marketing routes with per-page metadata overrides). Ordered by route_path.',
    requiredScope: 'seo:read',
    inputSchema: {},
    handler: async (_args, _ctx, services) => {
      const result = await services.blog.listStaticPageSeo();
      return ok(result);
    },
  },

  {
    name: 'page_seo_get',
    description:
      'Fetch static page SEO for a single route. Route is normalized (leading slash, no trailing slash). Returns null if no row exists.',
    requiredScope: 'seo:read',
    inputSchema: {
      route_path: z
        .string()
        .trim()
        .min(1)
        .max(512)
        .describe('Route path, e.g. "/pricing" or "/blog".'),
    },
    handler: async (args, _ctx, services) => {
      const { route_path } = args as { route_path: string };
      const row: unknown = await services.blog.getStaticPageSeo(route_path);
      return ok({ route_path, row });
    },
  },

  {
    name: 'page_seo_upsert',
    description:
      'Create or update SEO metadata for a static marketing route. Route path is the unique key. All optional fields default to null; robots defaults to "index,follow" when omitted.',
    requiredScope: 'seo:write',
    inputSchema: {
      route_path: z
        .string()
        .trim()
        .min(1)
        .max(512)
        .describe('Route path, e.g. "/pricing".'),
      seo_title: z.string().trim().max(200).nullable().optional(),
      seo_description: z.string().trim().max(500).nullable().optional(),
      seo_keywords: z.string().trim().max(500).nullable().optional(),
      og_image_url: z.string().trim().max(1024).nullable().optional(),
      og_title: z.string().trim().max(200).nullable().optional(),
      og_description: z.string().trim().max(500).nullable().optional(),
      canonical_url: z.string().trim().max(1024).nullable().optional(),
      robots: z.string().trim().max(100).nullable().optional(),
      structured_data: z
        .record(z.string(), z.unknown())
        .nullable()
        .optional()
        .describe('Arbitrary JSON-LD payload for this route.'),
      h1_override: z.string().trim().max(300).nullable().optional(),
    },
    handler: async (args, _ctx, services) => {
      const input = args as unknown as StaticPageSeoInput;
      const row: unknown = await services.blog.upsertStaticPageSeo(input);
      return ok(row);
    },
  },

  {
    name: 'page_seo_delete',
    description:
      'DESTRUCTIVE: Delete the static page SEO row for a route. This does not delete the page — it only removes the CMS metadata override so defaults apply. You MUST pass confirm=true.',
    requiredScope: 'seo:write',
    inputSchema: {
      route_path: z.string().trim().min(1).max(512),
      confirm: z
        .boolean()
        .optional()
        .describe('Must be true to execute deletion.'),
    },
    handler: async (args, _ctx, services) => {
      const { route_path, confirm } = args as {
        route_path: string;
        confirm?: boolean;
      };
      if (confirm !== true) {
        return err(
          `Deletion NOT executed. To remove the SEO row for "${route_path}", re-call with confirm=true.`,
          { route_path },
        );
      }
      const result = await services.blog.deleteStaticPageSeo(route_path);
      return ok({ route_path, ...result });
    },
  },

  {
    name: 'page_seo_ai_fill',
    description:
      'AI-generate SEO metadata (meta_title, meta_description, h1_override, og_title, og_description) for a marketing route. Does NOT persist — returns the generated fields so you can review then call page_seo_upsert to save. Consumes AI credits (1 LLM call).',
    requiredScope: 'seo:write',
    inputSchema: {
      route: z
        .string()
        .trim()
        .min(1)
        .max(512)
        .describe('Route path to generate SEO for, e.g. "/pricing".'),
      prompt: z
        .string()
        .trim()
        .max(2000)
        .optional()
        .describe('Optional custom prompt describing the page content.'),
      primaryKeyword: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe('Optional primary keyword to weave into the metadata.'),
    },
    handler: async (args, _ctx, services) => {
      const input = args as {
        route: string;
        prompt?: string;
        primaryKeyword?: string;
      };
      const result = await services.seoAiFill.generateSeoFields(input);
      return ok(result);
    },
  },
];
