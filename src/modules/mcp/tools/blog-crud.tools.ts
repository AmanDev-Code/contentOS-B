/**
 * Pack B — Blog CRUD tools (6).
 *
 * Write-path tools that wrap BlogService mutation methods. The
 * `blog_delete_post` tool is destructive — it requires an explicit
 * `confirm: true` input and surfaces the post title when confirmation is
 * missing so the user knows what they're about to delete.
 */

import { z } from 'zod';
import type { McpToolDefinition } from '../tool-registry';
import { ok, err } from '../tool-registry';

/**
 * Minimal shape of a blog post row returned from BlogService.createPost /
 * updatePost / getAdminPost. BlogService returns untyped Supabase rows — we
 * type-narrow here to the fields we actually read.
 */
interface BlogPostRow {
  id: string;
  path: string;
  slug: string;
  title: string;
  status: string;
  published_at: string | null;
  scheduled_publish_at: string | null;
}

const BlogPostKindEnum = z.enum([
  'article',
  'changelog',
  'release',
  'guide',
  'news',
  'announcement',
]);

const BlogPostStatusEnum = z.enum([
  'draft',
  'scheduled',
  'published',
  'archived',
]);

const HeroStyleEnum = z.enum([
  'default',
  'full',
  'split',
  'minimal',
  'gradient',
]);

/**
 * Full input schema for blog post creation. Mirrors CreateBlogPostInput.
 * In draft mode only title + slug are required; other fields are optional.
 */
const CreatePostInputSchema = {
  mode: z
    .enum(['draft', 'full'])
    .describe(
      'draft: only title+slug required (fill the rest later). full: all fields accepted.',
    ),
  title: z.string().trim().min(1).max(300),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('URL slug. Will be normalised to lowercase-hyphenated form.'),
  parent_id: z.string().uuid().nullable().optional(),
  subtitle: z.string().trim().max(500).nullable().optional(),
  excerpt: z.string().trim().max(1000).nullable().optional(),
  body: z.string().optional().describe('Markdown/HTML body content.'),
  content_category: z.string().trim().max(100).nullable().optional(),
  post_kind: BlogPostKindEnum.optional(),
  status: BlogPostStatusEnum.optional().describe('Defaults to draft.'),
  scheduled_publish_at: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .describe('ISO 8601 datetime for scheduled publishing.'),
  published_at: z.string().datetime().nullable().optional(),
  display_order: z.number().int().min(0).optional(),
  featured_image_url: z.string().url().nullable().optional(),
  featured_image_object_position: z
    .string()
    .max(20)
    .nullable()
    .optional()
    .describe('left, center, right, top, bottom, or "x,y" percentage.'),
  hero_style: HeroStyleEnum.optional(),
  reading_minutes: z.number().int().min(0).nullable().optional(),
  author_display_name: z.string().trim().max(200).nullable().optional(),
  author_bio: z.string().trim().max(2000).nullable().optional(),
  author_avatar_url: z.string().url().nullable().optional(),
  author_role: z.string().trim().max(100).nullable().optional(),
  author_linkedin_url: z.string().url().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  custom_css: z.string().max(10000).nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  seo_title: z.string().trim().max(200).nullable().optional(),
  seo_description: z.string().trim().max(500).nullable().optional(),
  seo_keywords: z.string().trim().max(500).nullable().optional(),
  canonical_url: z.string().url().nullable().optional(),
  og_image_url: z.string().url().nullable().optional(),
  twitter_card: z.string().max(50).nullable().optional(),
  robots: z.string().max(100).nullable().optional(),
  structured_data: z.record(z.string(), z.unknown()).nullable().optional(),
  locale: z.string().max(10).optional().describe('Defaults to "en".'),
  faq_json: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .nullable()
    .optional(),
  listing_image_url: z.string().url().nullable().optional(),
  listing_image_object_position: z.string().max(20).nullable().optional(),
  toc_json: z
    .array(z.object({ label: z.string(), anchor: z.string() }))
    .nullable()
    .optional(),
};

export const blogCrudTools: readonly McpToolDefinition[] = [
  {
    name: 'blog_create_post',
    description:
      'Create a new blog post. mode="draft" requires only title+slug (minimum viable for later enrichment). mode="full" accepts all 40+ fields including body, SEO metadata, FAQ, TOC, and structured data.',
    requiredScope: 'blog:write',
    inputSchema: CreatePostInputSchema,
    handler: async (args, ctx, services) => {
      const { mode, ...input } = args as { mode: string } & Record<
        string,
        unknown
      >;
      // Build the input object, stripping undefined optional fields
      const payload: Record<string, unknown> = {
        title: input.title,
        slug: input.slug,
      };
      if (mode === 'full') {
        Object.entries(input).forEach(([k, v]) => {
          if (v !== undefined && k !== 'title' && k !== 'slug') {
            payload[k] = v;
          }
        });
      } else {
        // Draft mode: still pass through a handful of optional fields if provided
        const draftPassthrough = [
          'parent_id',
          'post_kind',
          'status',
          'tags',
          'content_category',
          'excerpt',
          'subtitle',
        ];
        for (const k of draftPassthrough) {
          if (input[k] !== undefined) payload[k] = input[k];
        }
      }
      const post = (await services.blog.createPost(
        ctx.user.id,
        payload as never,
      )) as BlogPostRow;
      return ok({
        id: post.id,
        path: post.path,
        slug: post.slug,
        status: post.status,
      });
    },
  },

  {
    name: 'blog_update_post',
    description:
      'Partial-update a blog post. Accepts any subset of updatable fields (body, SEO, scheduling, tags, etc.). Returns the full updated post.',
    requiredScope: 'blog:write',
    inputSchema: {
      id: z.string().uuid().describe('Blog post UUID to update.'),
      patch: z
        .record(z.string(), z.unknown())
        .describe(
          'Partial object of fields to update. Forbidden keys (id, path, slug, parent_id, created_by, created_at) are silently stripped.',
        ),
    },
    handler: async (args, _ctx, services) => {
      const { id, patch } = args as {
        id: string;
        patch: Record<string, unknown>;
      };
      const updated: unknown = await services.blog.updatePost(id, { ...patch });
      return ok(updated);
    },
  },

  {
    name: 'blog_publish_post',
    description:
      'Publish a blog post immediately. Sets status=published and stamps published_at to now.',
    requiredScope: 'blog:write',
    inputSchema: {
      id: z.string().uuid().describe('Blog post UUID to publish.'),
    },
    handler: async (args, _ctx, services) => {
      const { id } = args as { id: string };
      const updated = (await services.blog.updatePost(id, {
        status: 'published',
        published_at: new Date().toISOString(),
      })) as BlogPostRow;
      return ok({
        id: updated.id,
        status: updated.status,
        published_at: updated.published_at,
      });
    },
  },

  {
    name: 'blog_schedule_post',
    description:
      'Schedule a blog post for future publication. A BullMQ job will auto-publish at the specified datetime.',
    requiredScope: 'blog:write',
    inputSchema: {
      id: z.string().uuid().describe('Blog post UUID to schedule.'),
      scheduled_publish_at: z
        .string()
        .datetime()
        .describe('ISO 8601 datetime (must be in the future).'),
    },
    handler: async (args, _ctx, services) => {
      const { id, scheduled_publish_at } = args as {
        id: string;
        scheduled_publish_at: string;
      };
      const publishAt = new Date(scheduled_publish_at);
      if (publishAt.getTime() <= Date.now()) {
        return err('scheduled_publish_at must be in the future.');
      }
      const updated = (await services.blog.updatePost(id, {
        status: 'scheduled',
        scheduled_publish_at,
      })) as BlogPostRow;
      return ok({
        id: updated.id,
        status: updated.status,
        scheduled_publish_at: updated.scheduled_publish_at,
      });
    },
  },

  {
    name: 'blog_archive_post',
    description:
      'Archive a blog post. Sets status=archived. The post remains in the database but is no longer publicly visible.',
    requiredScope: 'blog:write',
    inputSchema: {
      id: z.string().uuid().describe('Blog post UUID to archive.'),
    },
    handler: async (args, _ctx, services) => {
      const { id } = args as { id: string };
      const updated = (await services.blog.updatePost(id, {
        status: 'archived',
      })) as BlogPostRow;
      return ok({ id: updated.id, status: updated.status });
    },
  },

  {
    name: 'blog_delete_post',
    description:
      'DESTRUCTIVE: Permanently delete a blog post from the database. This action cannot be undone. You MUST pass confirm=true or the tool will return the post title and ask for confirmation.',
    requiredScope: 'blog:write',
    inputSchema: {
      id: z.string().uuid().describe('Blog post UUID to delete.'),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Must be true to execute deletion. If omitted or false, returns the post title for confirmation.',
        ),
    },
    handler: async (args, _ctx, services) => {
      const { id, confirm } = args as { id: string; confirm?: boolean };
      if (confirm !== true) {
        // Look up the post so we can show the user what they'd be deleting
        try {
          const post = (await services.blog.getAdminPost(id)) as BlogPostRow;
          return err(
            `Deletion NOT executed. To permanently delete "${post.title}" (${id}), call blog_delete_post again with confirm=true.`,
            { post_id: id, post_title: post.title },
          );
        } catch {
          return err(`Post ${id} not found. Cannot confirm deletion.`, {
            post_id: id,
          });
        }
      }
      await services.blog.deletePost(id);
      return ok({ deleted: true, id });
    },
  },
];
