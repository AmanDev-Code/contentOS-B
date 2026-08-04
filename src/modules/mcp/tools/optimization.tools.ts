/**
 * Pack D — Optimization tools (6).
 *
 * Wrappers over ContentEngineService AEO/GEO optimization and schema generation
 * methods. These tools modify post content (applying optimizations) or generate
 * AI-powered improvement suggestions.
 *
 * All handlers declare `requiredScope: 'content-engine:write'` — the registry
 * enforces it before calling the handler.
 */

import { z } from 'zod';
import type { McpToolDefinition } from '../tool-registry';
import { ok } from '../tool-registry';

export const optimizationTools: readonly McpToolDefinition[] = [
  {
    name: 'optimize_generate_aeo',
    description:
      'Generate Answer Engine Optimization (AEO) improvement suggestions for a blog post. Analyzes the post and returns prioritized suggestions for featured snippets, direct answers, and AI-citation readiness. Consumes AI credits.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z
        .string()
        .uuid()
        .describe('Blog post UUID to generate AEO improvements for.'),
    },
    handler: async (args, _ctx, services) => {
      const { post_id } = args as { post_id: string };
      const result =
        await services.contentEngine.generateAEOImprovements(post_id);
      return ok(result);
    },
  },

  {
    name: 'optimize_apply_aeo',
    description:
      'DESTRUCTIVE: Apply AEO-optimized body content to a blog post. Overwrites the existing post body with the provided optimized version. Ensure you have reviewed the optimized_body before applying.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z.string().uuid().describe('Blog post UUID to apply AEO to.'),
      optimized_body: z
        .string()
        .trim()
        .min(1)
        .max(200000)
        .describe(
          'Full AEO-optimized Markdown body to replace the current post body.',
        ),
    },
    handler: async (args, _ctx, services) => {
      const { post_id, optimized_body } = args as {
        post_id: string;
        optimized_body: string;
      };
      const result = await services.contentEngine.applyAEOOptimization(
        post_id,
        optimized_body,
      );
      return ok(result);
    },
  },

  {
    name: 'optimize_generate_geo',
    description:
      'Generate Generative Engine Optimization (GEO) improvement suggestions for a blog post. Analyzes for AI-citation signals: statistics, entity coverage, structured data, and topical authority. Consumes AI credits.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z
        .string()
        .uuid()
        .describe('Blog post UUID to generate GEO improvements for.'),
    },
    handler: async (args, _ctx, services) => {
      const { post_id } = args as { post_id: string };
      const result =
        await services.contentEngine.generateGEOImprovements(post_id);
      return ok(result);
    },
  },

  {
    name: 'optimize_apply_geo',
    description:
      'DESTRUCTIVE: Apply GEO-optimized body content to a blog post. Overwrites the existing post body with the provided optimized version. Ensure you have reviewed the optimized_body before applying.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z.string().uuid().describe('Blog post UUID to apply GEO to.'),
      optimized_body: z
        .string()
        .trim()
        .min(1)
        .max(200000)
        .describe(
          'Full GEO-optimized Markdown body to replace the current post body.',
        ),
    },
    handler: async (args, _ctx, services) => {
      const { post_id, optimized_body } = args as {
        post_id: string;
        optimized_body: string;
      };
      const result = await services.contentEngine.applyGEOOptimization(
        post_id,
        optimized_body,
      );
      return ok(result);
    },
  },

  {
    name: 'optimize_apply_patches',
    description:
      'DESTRUCTIVE: Apply selected optimization patches to a blog post body. Each patch specifies a type (e.g., "faq", "tldr", "statistics"), content to insert, and a position (top, bottom, after_intro). Modifies the post body in-place.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z
        .string()
        .uuid()
        .describe('Blog post UUID to apply patches to.'),
      optimizations: z
        .array(
          z.object({
            type: z
              .string()
              .trim()
              .min(1)
              .max(100)
              .describe(
                'Optimization type identifier (e.g., "faq", "tldr", "statistics", "citation_block").',
              ),
            content: z
              .string()
              .trim()
              .min(1)
              .max(50000)
              .describe(
                'Content to insert. For type "faq", this should be JSON stringified array of {question, answer} objects.',
              ),
            position: z
              .enum(['top', 'bottom', 'after_intro'])
              .describe('Where to insert the content in the post body.'),
          }),
        )
        .min(1)
        .max(20)
        .describe('Array of optimization patches to apply.'),
    },
    handler: async (args, _ctx, services) => {
      const { post_id, optimizations } = args as {
        post_id: string;
        optimizations: {
          type: string;
          content: string;
          position: 'top' | 'bottom' | 'after_intro';
        }[];
      };
      const result = await services.contentEngine.applyOptimizations(
        post_id,
        optimizations,
      );
      return ok(result);
    },
  },

  {
    name: 'schema_generate',
    description:
      'Generate JSON-LD structured data schemas (Article, FAQ, BreadcrumbList, etc.) for a blog post. Stores the generated schemas on the post record. Consumes AI credits.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z
        .string()
        .uuid()
        .describe('Blog post UUID to generate schemas for.'),
    },
    handler: async (args, _ctx, services) => {
      const { post_id } = args as { post_id: string };
      const result = await services.contentEngine.generateSchemas(post_id);
      return ok(result);
    },
  },
];
