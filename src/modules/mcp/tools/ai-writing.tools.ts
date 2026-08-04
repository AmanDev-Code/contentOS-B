/**
 * Pack C — AI Writing tools (8).
 *
 * Thin wrappers over ContentEngineService AI generation methods. These tools
 * consume AI credits (LLM calls). Every tool declares `requiredScope:
 * 'content-engine:write'` — the registry enforces it before calling the handler.
 */

import { z } from 'zod';
import type { McpToolDefinition } from '../tool-registry';
import { ok } from '../tool-registry';

const HeadingStructureSchema = z.array(
  z.object({
    level: z.enum(['h2', 'h3']),
    text: z.string(),
  }),
);

const ContentPlanSchema = z.object({
  suggested_title: z.string(),
  heading_structure: HeadingStructureSchema,
  recommended_word_count: z.number().int().positive(),
  content_angle: z.string(),
  keyword_placement: z.string(),
});

export const aiWritingTools: readonly McpToolDefinition[] = [
  {
    name: 'ai_generate_title',
    description:
      'Generate an SEO-optimized blog post title from a keyword. Consumes AI credits (1 LLM call).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      keyword: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe('Primary keyword or topic to generate a title for.'),
    },
    handler: async (args, _ctx, services) => {
      const { keyword } = args as { keyword: string };
      const result = await services.contentEngine.generateTitle(keyword);
      return ok(result);
    },
  },

  {
    name: 'ai_generate_excerpt',
    description:
      'Generate a concise excerpt/summary from blog post body content. Consumes AI credits (1 LLM call).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      body: z
        .string()
        .trim()
        .min(1)
        .max(50000)
        .describe('Markdown/HTML body content of the blog post.'),
    },
    handler: async (args, _ctx, services) => {
      const { body } = args as { body: string };
      const result = await services.contentEngine.generateExcerpt(body);
      return ok(result);
    },
  },

  {
    name: 'ai_enhance_content',
    description:
      'Enhance/expand blog post body content with AI. Adds depth, examples, and clarity while preserving structure. Consumes AI credits (1 LLM call).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      body: z
        .string()
        .trim()
        .min(1)
        .max(50000)
        .describe('Markdown/HTML body content to enhance.'),
      instructions: z
        .string()
        .trim()
        .max(1000)
        .optional()
        .describe(
          'Optional custom instructions for enhancement. Defaults to general improvement.',
        ),
    },
    handler: async (args, _ctx, services) => {
      const { body, instructions } = args as {
        body: string;
        instructions?: string;
      };
      const result = await services.contentEngine.enhanceContent(
        body,
        instructions,
      );
      return ok(result);
    },
  },

  {
    name: 'ai_generate_faq',
    description:
      'Generate 3-5 FAQ items from blog post body content. Returns structured Q&A pairs suitable for FAQ schema markup. Consumes AI credits (1 LLM call).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      body: z
        .string()
        .trim()
        .min(1)
        .max(50000)
        .describe('Markdown/HTML body content to generate FAQ from.'),
    },
    handler: async (args, _ctx, services) => {
      const { body } = args as { body: string };
      const result = await services.contentEngine.generateFAQ(body);
      return ok(result);
    },
  },

  {
    name: 'ai_generate_seo_meta',
    description:
      'Generate optimized SEO metadata (title, description, keywords) from post title and body. Consumes AI credits (1 LLM call).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      title: z.string().trim().min(1).max(300).describe('Blog post title.'),
      body: z
        .string()
        .trim()
        .min(1)
        .max(50000)
        .describe('Markdown/HTML body content.'),
      keyword: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe('Optional primary keyword to prioritize in metadata.'),
    },
    handler: async (args, _ctx, services) => {
      const { title, body, keyword } = args as {
        title: string;
        body: string;
        keyword?: string;
      };
      const result = await services.contentEngine.generateSEO(
        title,
        body,
        keyword,
      );
      return ok(result);
    },
  },

  {
    name: 'ai_generate_plan',
    description:
      'Generate an AI content plan from keyword research. Returns suggested title, heading structure, word count, content angle, and keyword placement strategy. Consumes AI credits (1 LLM call).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      primary_keyword: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe('Primary keyword/topic for the content plan.'),
      secondary_keywords: z
        .array(z.string().trim().min(1).max(200))
        .max(20)
        .optional()
        .describe('Secondary/related keywords to incorporate.'),
      target_audience: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe(
          'Target audience description (e.g., "marketers at B2B SaaS companies").',
        ),
      business_type: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe('Business type/industry context.'),
      country: z
        .string()
        .trim()
        .max(100)
        .optional()
        .describe('Target country/region (defaults to global).'),
      language: z
        .string()
        .trim()
        .max(50)
        .optional()
        .describe('Content language (defaults to English).'),
      search_intent: z
        .string()
        .trim()
        .max(100)
        .optional()
        .describe(
          'Search intent: informational, commercial, transactional, navigational.',
        ),
      competitors: z
        .array(z.string().trim().min(1).max(500))
        .max(10)
        .optional()
        .describe('Competitor URLs or titles to differentiate from.'),
      article_length: z
        .number()
        .int()
        .min(500)
        .max(10000)
        .optional()
        .describe('Target word count (defaults to 2500).'),
    },
    handler: async (args, _ctx, services) => {
      const input = args as {
        primary_keyword: string;
        secondary_keywords?: string[];
        target_audience: string;
        business_type?: string;
        country?: string;
        language?: string;
        search_intent?: string;
        competitors?: string[];
        article_length?: number;
      };
      const plan = await services.contentEngine.generatePlan(input);
      return ok(plan);
    },
  },

  {
    name: 'ai_generate_article',
    description:
      'Generate a full blog article from an approved content plan. Returns title, slug, body (Markdown), SEO metadata, FAQ, tags, and quality scores. Consumes AI credits (1 LLM call, higher token usage).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      plan: ContentPlanSchema.describe(
        'Content plan object (output of ai_generate_plan).',
      ),
      input: z
        .object({
          primary_keyword: z.string().trim().min(1).max(200),
          secondary_keywords: z
            .array(z.string().trim().min(1).max(200))
            .max(20)
            .optional(),
          target_audience: z.string().trim().min(1).max(500),
          business_type: z.string().trim().max(200).optional(),
          country: z.string().trim().max(100).optional(),
          language: z.string().trim().max(50).optional(),
          search_intent: z.string().trim().max(100).optional(),
          competitors: z
            .array(z.string().trim().min(1).max(500))
            .max(10)
            .optional(),
          article_length: z.number().int().min(500).max(10000).optional(),
        })
        .describe(
          'Original input parameters (same as passed to ai_generate_plan).',
        ),
    },
    handler: async (args, _ctx, services) => {
      const { plan, input } = args as {
        plan: {
          suggested_title: string;
          heading_structure: { level: 'h2' | 'h3'; text: string }[];
          recommended_word_count: number;
          content_angle: string;
          keyword_placement: string;
        };
        input: {
          primary_keyword: string;
          secondary_keywords?: string[];
          target_audience: string;
          business_type?: string;
          country?: string;
          language?: string;
          search_intent?: string;
          competitors?: string[];
          article_length?: number;
        };
      };
      const article = await services.contentEngine.generateArticle(plan, input);
      return ok(article);
    },
  },

  {
    name: 'ai_generate_article_full',
    description:
      'Generate a content plan AND full article in one call. Equivalent to calling ai_generate_plan then ai_generate_article sequentially. Consumes AI credits (2 LLM calls). Returns both the plan and the generated article.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      primary_keyword: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe('Primary keyword/topic.'),
      secondary_keywords: z
        .array(z.string().trim().min(1).max(200))
        .max(20)
        .optional()
        .describe('Secondary/related keywords.'),
      target_audience: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe('Target audience description.'),
      business_type: z.string().trim().max(200).optional(),
      country: z.string().trim().max(100).optional(),
      language: z.string().trim().max(50).optional(),
      search_intent: z.string().trim().max(100).optional(),
      competitors: z
        .array(z.string().trim().min(1).max(500))
        .max(10)
        .optional(),
      article_length: z.number().int().min(500).max(10000).optional(),
    },
    handler: async (args, _ctx, services) => {
      const input = args as {
        primary_keyword: string;
        secondary_keywords?: string[];
        target_audience: string;
        business_type?: string;
        country?: string;
        language?: string;
        search_intent?: string;
        competitors?: string[];
        article_length?: number;
      };

      // Step 1: Generate plan
      const plan = await services.contentEngine.generatePlan(input);

      // Step 2: Generate article from plan
      const article = await services.contentEngine.generateArticle(plan, input);

      return ok({ plan, article });
    },
  },
];
