/**
 * Pack J — Rankings, backlinks, and author profile tools (6).
 *
 * Wraps ContentEngineService keyword-ranking and backlink-opportunity methods,
 * plus a lightweight ProfileRepository-backed author profile writer.
 *
 * Method signatures matched exactly against content-engine.service.ts:
 *   trackKeywordRanking(keywordId, position, searchEngine?, country?, postId?)
 *   checkRankings()
 *   createBacklinkOpportunity(body)
 *   updateBacklinkOpportunity(id, body)
 *   suggestBacklinkOpportunities(postId)
 *
 * The `author_profile_save` tool updates the blog-author fields on the actor's
 * profile row (author_bio, author_role, author_avatar_url, author_linkedin_url).
 * These fields are the defaults BlogService picks up when a post has no
 * per-post author override.
 */

import { z } from 'zod';
import type { McpToolDefinition } from '../tool-registry';
import { ok } from '../tool-registry';

const BacklinkOpportunityTypeEnum = z.enum([
  'guest_post',
  'resource_page',
  'broken_link',
  'competitor_backlink',
  'directory',
  'mention',
]);

const BacklinkStatusEnum = z.enum([
  'identified',
  'contacted',
  'outreach_sent',
  'negotiating',
  'acquired',
  'declined',
  'lost',
]);

export const rankingsTools: readonly McpToolDefinition[] = [
  {
    name: 'ranking_track',
    description:
      'Record a manually-observed SERP position for a keyword. Auto-computes delta vs the previous tracked position. Optionally associates the ranking with a blog post.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      keyword_id: z.string().uuid().describe('seo_keywords row UUID.'),
      position: z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe('SERP position (1-100).'),
      search_engine: z
        .string()
        .trim()
        .max(50)
        .optional()
        .describe('Defaults to "google".'),
      country: z
        .string()
        .trim()
        .max(10)
        .optional()
        .describe('ISO country code. Defaults to "US".'),
      post_id: z
        .string()
        .uuid()
        .optional()
        .describe('Optional blog post UUID that ranks for this keyword.'),
    },
    handler: async (args, _ctx, services) => {
      const { keyword_id, position, search_engine, country, post_id } =
        args as {
          keyword_id: string;
          position: number;
          search_engine?: string;
          country?: string;
          post_id?: string;
        };
      const result: unknown = await services.contentEngine.trackKeywordRanking(
        keyword_id,
        position,
        search_engine ?? 'google',
        country ?? 'US',
        post_id,
      );
      return ok(result);
    },
  },

  {
    name: 'ranking_check',
    description:
      'Trigger automatic rank checking across all tracked keywords. Currently returns a not-configured status until Google Search Console / SerpAPI / DataForSEO integration ships. Safe to call — no side effects.',
    requiredScope: 'content-engine:write',
    inputSchema: {},
    handler: async (_args, _ctx, services) => {
      const result: unknown = await services.contentEngine.checkRankings();
      return ok(result);
    },
  },

  {
    name: 'backlink_add_opportunity',
    description:
      'Create a new backlink opportunity row (identified target for outreach). Defaults: status=identified.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      source_domain: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .describe('Root domain of the linking site, e.g. "producthunt.com".'),
      source_url: z
        .string()
        .url()
        .optional()
        .describe('Specific URL on the source domain, if known.'),
      opportunity_type: BacklinkOpportunityTypeEnum.optional(),
      target_post_id: z
        .string()
        .uuid()
        .optional()
        .describe('Blog post UUID this backlink should point to.'),
      status: BacklinkStatusEnum.optional(),
      domain_authority: z.number().int().min(0).max(100).optional(),
      contact_email: z.string().trim().email().max(320).optional(),
      notes: z.string().trim().max(2000).optional(),
    },
    handler: async (args, _ctx, services) => {
      const body = args as {
        source_domain: string;
        source_url?: string;
        opportunity_type?: string;
        target_post_id?: string;
        status?: string;
        domain_authority?: number;
        contact_email?: string;
        notes?: string;
      };
      const result: unknown =
        await services.contentEngine.createBacklinkOpportunity(body);
      return ok(result);
    },
  },

  {
    name: 'backlink_update_status',
    description:
      'Update fields on an existing backlink opportunity, most commonly to advance status (identified → outreach_sent → negotiating → acquired). Auto-stamps outreach_sent_at / acquired_at when status transitions and the corresponding timestamp is not provided.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      id: z.string().uuid().describe('backlink_opportunities row UUID.'),
      status: BacklinkStatusEnum.optional(),
      source_domain: z.string().trim().min(1).max(255).optional(),
      source_url: z.string().url().optional(),
      opportunity_type: BacklinkOpportunityTypeEnum.optional(),
      target_post_id: z.string().uuid().optional(),
      domain_authority: z.number().int().min(0).max(100).optional(),
      contact_email: z.string().trim().email().max(320).optional(),
      notes: z.string().trim().max(2000).optional(),
      outreach_sent_at: z.string().datetime().optional(),
      acquired_at: z.string().datetime().optional(),
    },
    handler: async (args, _ctx, services) => {
      const { id, ...rest } = args as { id: string } & Record<string, unknown>;
      const body = rest as {
        source_domain?: string;
        source_url?: string;
        opportunity_type?: string;
        target_post_id?: string;
        status?: string;
        domain_authority?: number;
        contact_email?: string;
        notes?: string;
        outreach_sent_at?: string;
        acquired_at?: string;
      };
      const result: unknown =
        await services.contentEngine.updateBacklinkOpportunity(id, body);
      return ok(result);
    },
  },

  {
    name: 'backlink_suggest_for_post',
    description:
      'AI-suggest backlink opportunities relevant to a specific blog post. Analyzes topic, tags, and body content and returns 5-10 realistic opportunity suggestions across guest posts, resource pages, broken-link, competitor backlinks, directories, and mentions. Consumes AI credits (1 LLM call). Does NOT persist — returned suggestions can be saved via backlink_add_opportunity.',
    requiredScope: 'content-engine:read',
    inputSchema: {
      post_id: z.string().uuid().describe('Blog post UUID.'),
    },
    handler: async (args, _ctx, services) => {
      const { post_id } = args as { post_id: string };
      const result =
        await services.contentEngine.suggestBacklinkOpportunities(post_id);
      return ok(result);
    },
  },

  {
    name: 'author_profile_save',
    description:
      "Save/update the acting user's blog-author profile defaults (author_bio, author_role, author_avatar_url, author_linkedin_url). These fields populate byline metadata on posts that do not set per-post overrides.",
    requiredScope: 'blog:write',
    inputSchema: {
      author_bio: z
        .string()
        .trim()
        .max(2000)
        .nullable()
        .optional()
        .describe('Short author biography (Markdown allowed).'),
      author_role: z
        .string()
        .trim()
        .max(100)
        .nullable()
        .optional()
        .describe('Job title / role, e.g. "Head of Growth".'),
      author_avatar_url: z
        .string()
        .url()
        .nullable()
        .optional()
        .describe('Public URL to a square avatar image.'),
      author_linkedin_url: z
        .string()
        .url()
        .nullable()
        .optional()
        .describe('Public LinkedIn profile URL.'),
    },
    handler: async (args, ctx, services) => {
      const updates = args as {
        author_bio?: string | null;
        author_role?: string | null;
        author_avatar_url?: string | null;
        author_linkedin_url?: string | null;
      };
      if (Object.keys(updates).length === 0) {
        return ok({ updated: false, reason: 'No fields provided' });
      }
      const profile = await services.profileRepo.updateProfile(
        ctx.user.id,
        updates,
      );
      return ok({
        updated: true,
        profile: {
          id: profile.id,
          author_bio: (profile as unknown as Record<string, unknown>)
            .author_bio,
          author_role: (profile as unknown as Record<string, unknown>)
            .author_role,
          author_avatar_url: (profile as unknown as Record<string, unknown>)
            .author_avatar_url,
          author_linkedin_url: (profile as unknown as Record<string, unknown>)
            .author_linkedin_url,
        },
      });
    },
  },
];
