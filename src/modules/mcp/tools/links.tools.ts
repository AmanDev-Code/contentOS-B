/**
 * Pack F — Internal linking tools (5).
 *
 * Wrappers over ContentEngineService internal-link methods. `links_insert` is
 * destructive — it rewrites the post body to embed accepted links. All other
 * tools operate on the internal_link_suggestions table.
 */

import { z } from 'zod';
import type { McpToolDefinition } from '../tool-registry';
import { ok, err } from '../tool-registry';

export const linksTools: readonly McpToolDefinition[] = [
  {
    name: 'links_analyze',
    description:
      'Analyze a blog post for internal linking opportunities. Uses AI to find natural anchor-text matches to other published posts and stores them as suggestions (status=suggested). Consumes AI credits (1 LLM call). Idempotent per (source, target, anchor).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z
        .string()
        .uuid()
        .describe('Source blog post UUID. Must have body content.'),
    },
    handler: async (args, _ctx, services) => {
      const { post_id } = args as { post_id: string };
      const suggestions =
        await services.contentEngine.analyzeLinkOpportunities(post_id);
      return ok({ post_id, suggestions });
    },
  },

  {
    name: 'links_get_suggestions',
    description:
      'List all internal link suggestions where this post is either the source or the target. Ordered by relevance_score descending. Returns status (suggested/accepted/rejected/inserted) per suggestion.',
    requiredScope: 'content-engine:read',
    inputSchema: {
      post_id: z.string().uuid().describe('Blog post UUID (source or target).'),
    },
    handler: async (args, _ctx, services) => {
      const { post_id } = args as { post_id: string };
      const suggestions =
        await services.contentEngine.getInternalLinks(post_id);
      return ok({ post_id, suggestions });
    },
  },

  {
    name: 'links_accept',
    description:
      'Mark an internal link suggestion as accepted. It will be inserted into the post body the next time links_insert runs.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      suggestion_id: z
        .string()
        .uuid()
        .describe('internal_link_suggestions row UUID.'),
    },
    handler: async (args, _ctx, services) => {
      const { suggestion_id } = args as { suggestion_id: string };
      const updated: unknown =
        await services.contentEngine.acceptLinkSuggestion(suggestion_id);
      return ok(updated);
    },
  },

  {
    name: 'links_reject',
    description:
      'Mark an internal link suggestion as rejected. It will be excluded from future links_insert runs.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      suggestion_id: z
        .string()
        .uuid()
        .describe('internal_link_suggestions row UUID.'),
    },
    handler: async (args, _ctx, services) => {
      const { suggestion_id } = args as { suggestion_id: string };
      const updated: unknown =
        await services.contentEngine.rejectLinkSuggestion(suggestion_id);
      return ok(updated);
    },
  },

  {
    name: 'links_insert',
    description:
      'DESTRUCTIVE: Insert all accepted internal-link suggestions into the source post body. Rewrites the body: each anchor_text is replaced with a Markdown link to /blog/{target_slug}. Sets suggestion status to inserted. You MUST pass confirm=true.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z
        .string()
        .uuid()
        .describe(
          'Source blog post UUID whose accepted links will be inlined.',
        ),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Must be true to execute. If omitted, returns a preview count without modifying the body.',
        ),
    },
    handler: async (args, _ctx, services) => {
      const { post_id, confirm } = args as {
        post_id: string;
        confirm?: boolean;
      };
      if (confirm !== true) {
        const suggestions =
          await services.contentEngine.getInternalLinks(post_id);
        const acceptedCount = suggestions.filter(
          (s: { status?: string; source_post_id?: string }) =>
            s.status === 'accepted' && s.source_post_id === post_id,
        ).length;
        return err(
          `Insertion NOT executed. ${acceptedCount} accepted link(s) would be inserted into post ${post_id}. Re-call with confirm=true to modify the post body.`,
          { post_id, accepted_count: acceptedCount },
        );
      }
      const result = await services.contentEngine.insertAcceptedLinks(post_id);
      return ok({ post_id, ...result });
    },
  },
];
