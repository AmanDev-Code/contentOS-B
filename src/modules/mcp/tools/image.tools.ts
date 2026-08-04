/**
 * Pack E — Image tools (8).
 *
 * Wrappers over ContentEngineService image engine methods. Several of these
 * tools trigger DALL-E image generation which consumes credits. The `image_upload`
 * tool is a stub — MCP cannot handle binary file uploads directly; use the REST
 * endpoint POST /admin/media/upload instead.
 *
 * All handlers except `image_upload` declare `requiredScope: 'content-engine:write'`.
 * `image_upload` uses `media:write`.
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDefinition } from '../tool-registry';
import { ok, err } from '../tool-registry';

export const imageTools: readonly McpToolDefinition[] = [
  {
    name: 'image_plan',
    description:
      'Generate an AI image plan for a blog post. Analyzes the post content and creates prompts for illustrations, diagrams, and feature images. Consumes AI credits (1 LLM call).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z
        .string()
        .uuid()
        .describe('Blog post UUID to generate an image plan for.'),
    },
    handler: async (args, _ctx, services) => {
      const { post_id } = args as { post_id: string };
      const result = await services.contentEngine.generateImagePlan(post_id);
      return ok(result);
    },
  },

  {
    name: 'image_generate',
    description:
      'Generate a single image from its planned prompt (DALL-E). The image must have been planned first via image_plan. Consumes AI credits (1 DALL-E call).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      image_id: z
        .string()
        .uuid()
        .describe(
          'Image UUID from the image plan (returned by image_plan tool).',
        ),
    },
    handler: async (args, _ctx, services) => {
      const { image_id } = args as { image_id: string };
      const result: unknown =
        await services.contentEngine.generateImage(image_id);
      return ok(result);
    },
  },

  {
    name: 'image_approve',
    description:
      'Approve a generated image, marking it ready for insertion into the post body.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      image_id: z.string().uuid().describe('Image UUID to approve.'),
    },
    handler: async (args, _ctx, services) => {
      const { image_id } = args as { image_id: string };
      const result: unknown =
        await services.contentEngine.approveImage(image_id);
      return ok(result);
    },
  },

  {
    name: 'image_reject',
    description:
      'Reject a generated image. It will not be inserted into the post. You can regenerate a new image for the same slot.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      image_id: z.string().uuid().describe('Image UUID to reject.'),
    },
    handler: async (args, _ctx, services) => {
      const { image_id } = args as { image_id: string };
      const result: unknown =
        await services.contentEngine.rejectImage(image_id);
      return ok(result);
    },
  },

  {
    name: 'image_insert',
    description:
      'DESTRUCTIVE: Insert all approved images into the blog post body at their planned positions. Modifies the post body in-place.',
    requiredScope: 'content-engine:write',
    inputSchema: {
      post_id: z
        .string()
        .uuid()
        .describe(
          'Blog post UUID. All approved images for this post will be inserted.',
        ),
    },
    handler: async (args, _ctx, services) => {
      const { post_id } = args as { post_id: string };
      const result = await services.contentEngine.insertImagesIntoPost(post_id);
      return ok(result);
    },
  },

  {
    name: 'image_upload',
    description:
      'Upload an image file to storage. NOTE: MCP transport does not support binary file uploads. Use the REST endpoint POST /admin/media/upload with multipart/form-data instead. This tool returns instructions for the REST upload.',
    requiredScope: 'media:write',
    inputSchema: {
      filename: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .describe('Desired filename for the upload.'),
      content_type: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe('MIME type (e.g., "image/png", "image/jpeg").'),
    },
    handler: async (args, ctx, services): Promise<CallToolResult> => {
      void ctx;
      void services;
      const { filename, content_type } = args as {
        filename: string;
        content_type?: string;
      };
      await Promise.resolve(); // satisfy require-await
      return err(
        'MCP transport does not support binary file uploads. Use the REST endpoint instead.',
        {
          rest_endpoint: 'POST /admin/media/upload',
          content_type: 'multipart/form-data',
          field_name: 'file',
          suggested_filename: filename,
          suggested_content_type: content_type || 'image/png',
          instructions:
            'Upload via curl: curl -X POST /admin/media/upload -H "Authorization: Bearer <token>" -F "file=@/path/to/file"',
        },
      );
    },
  },

  {
    name: 'image_regenerate_feature',
    description:
      'Regenerate the feature/hero image for a blog post using AI. Replaces the current featured_image_url with a newly generated image. Consumes AI credits (1 DALL-E call).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      slug: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe('Blog post slug (URL path segment, not UUID).'),
    },
    handler: async (args, _ctx, services) => {
      const { slug } = args as { slug: string };
      const result = await services.contentEngine.regenerateFeatureImage(slug);
      return ok(result);
    },
  },

  {
    name: 'image_generate_listing',
    description:
      'AI-outpaint the feature image to 16:10 aspect ratio for the blog listing card. The post must already have a featured_image_url. Consumes AI credits (1 image generation call).',
    requiredScope: 'content-engine:write',
    inputSchema: {
      slug: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe('Blog post slug (URL path segment, not UUID).'),
    },
    handler: async (args, _ctx, services) => {
      const { slug } = args as { slug: string };
      const result = await services.contentEngine.generateListingImage(slug);
      return ok(result);
    },
  },
];
