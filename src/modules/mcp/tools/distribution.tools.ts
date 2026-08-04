/**
 * Pack I — Distributions tools (4).
 *
 * Wraps ContentEngineService cross-platform distribution methods. Distributions
 * are per (post, platform) rows in blog_distributions holding adapted content,
 * cover images, and publish status.
 *
 * Method signatures matched exactly against content-engine.service.ts:
 *   getDistributions(postId)
 *   generateDistribution(postId, platform)
 *   publishToPlatform(postId, platform)
 *   markAsPublished(postId, platform, publishedUrl)
 */

import { z } from 'zod';
import type { McpToolDefinition } from '../tool-registry';
import { ok } from '../tool-registry';

const PlatformEnum = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .describe(
    'Platform slug: linkedin, linkedin_article, twitter, medium, devto, hashnode, reddit, mastodon, threads, bluesky, etc.',
  );

export const distributionTools: readonly McpToolDefinition[] = [
  {
    name: 'distribution_list',
    description:
      'List all cross-platform distributions for a blog post. Returns adapted content, hashtags, cover image URL, character count, engagement/SEO scores, status (draft/ready/published/failed), and publish metadata per platform.',
    requiredScope: 'content-engine:read',
    inputSchema: {
      post_id: z.string().uuid().describe('Blog post UUID.'),
    },
    handler: async (args, _ctx, services) => {
      const { post_id } = args as { post_id: string };
      const distributions =
        await services.contentEngine.getDistributions(post_id);
      return ok({ post_id, distributions });
    },
  },

  {
    name: 'distribution_generate',
    description:
      'Generate (or regenerate) platform-adapted content for one platform. Adapts tone, length, hashtags, and cover imagery to the platform. Upserts one blog_distributions row. Consumes AI credits (LLM + optional DALL-E for cover images).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z.string().uuid().describe('Blog post UUID.'),
      platform: PlatformEnum,
    },
    handler: async (args, _ctx, services) => {
      const { post_id, platform } = args as {
        post_id: string;
        platform: string;
      };
      const result: unknown = await services.contentEngine.generateDistribution(
        post_id,
        platform,
      );
      return ok(result);
    },
  },

  {
    name: 'distribution_publish',
    description:
      'Publish an already-generated distribution to a connected platform account. Requires a connected platform_accounts row with valid credentials. Sets status=published on success, or status=failed with last_error on failure.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z.string().uuid().describe('Blog post UUID.'),
      platform: PlatformEnum,
    },
    handler: async (args, _ctx, services) => {
      const { post_id, platform } = args as {
        post_id: string;
        platform: string;
      };
      const result: unknown = await services.contentEngine.publishToPlatform(
        post_id,
        platform,
      );
      return ok(result);
    },
  },

  {
    name: 'distribution_mark_published',
    description:
      'Manually mark a distribution as published (for platforms that must be posted manually, e.g. Reddit or Threads). Records the published_url and stamps published_at.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z.string().uuid().describe('Blog post UUID.'),
      platform: PlatformEnum,
      published_url: z
        .string()
        .url()
        .describe('The canonical URL of the manually-published post.'),
    },
    handler: async (args, _ctx, services) => {
      const { post_id, platform, published_url } = args as {
        post_id: string;
        platform: string;
        published_url: string;
      };
      const result: unknown = await services.contentEngine.markAsPublished(
        post_id,
        platform,
        published_url,
      );
      return ok(result);
    },
  },
];
