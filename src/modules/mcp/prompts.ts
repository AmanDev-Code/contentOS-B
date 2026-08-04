/**
 * MCP Prompts — five workflow templates that chain Trndinn Blog MCP tool calls.
 *
 * Each prompt is a template that Claude Code (or any MCP client) presents to
 * the user via slash-command. When invoked, the server returns a user-role
 * message containing an instruction block that guides Claude to call the
 * right MCP tools in the right order.
 *
 * These prompts are stateless — they emit the instruction text and let Claude
 * drive the actual tool calls. Argument values are interpolated into the text.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
  // ── /write_blog_post ──────────────────────────────────────────────────
  server.registerPrompt(
    'write_blog_post',
    {
      title: 'Write and publish a blog post',
      description:
        'End-to-end: plan → draft → optimize (AEO+GEO) → schema → publish. Uses ai_generate_article_full then blog_create_post → optimize_apply_* → blog_publish_post.',
      argsSchema: {
        topic: z
          .string()
          .describe('Primary topic or keyword for the new blog post.'),
        target_audience: z
          .string()
          .optional()
          .describe(
            'Optional audience description (defaults to "B2B SaaS marketers").',
          ),
      },
    },
    (args) => {
      const topic = args.topic;
      const audience = args.target_audience?.trim() || 'B2B SaaS marketers';
      const text = [
        `Write and publish a new Trndinn blog post about: **${topic}**`,
        `Target audience: ${audience}`,
        '',
        'Execute this sequence, calling one MCP tool per step:',
        '',
        `1. \`ai_generate_article_full\` with primary_keyword="${topic}" and target_audience="${audience}". Capture the returned { plan, article }.`,
        `2. \`blog_create_post\` with mode="full", title=article.title, slug=article.slug, body=article.body, excerpt=article.excerpt, seo_title, seo_description, seo_keywords, faq_json, tags. Capture the returned post id.`,
        `3. \`optimize_generate_aeo\` for the new post id. Review suggestions.`,
        `4. \`optimize_apply_aeo\` with the AEO-optimized body from step 3 (only if the diff is clearly a win).`,
        `5. \`optimize_generate_geo\` and \`optimize_apply_geo\` following the same pattern.`,
        `6. \`schema_generate\` to attach JSON-LD (Article, FAQPage) to the post.`,
        `7. \`image_plan\` → \`image_generate\` (for each planned image) → \`image_approve\` → \`image_insert\` to attach imagery.`,
        `8. \`blog_publish_post\` to set status=published and stamp published_at.`,
        '',
        'After publishing, offer to run `links_analyze` and `distribution_generate` for LinkedIn/Twitter/Medium.',
      ].join('\n');
      return {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text },
          },
        ],
      };
    },
  );

  // ── /refresh_blog_post ────────────────────────────────────────────────
  server.registerPrompt(
    'refresh_blog_post',
    {
      title: 'Refresh a blog post for 2026 accuracy',
      description:
        'Refresh an existing post: fetch → enhance content → regenerate SEO meta → re-run AEO/GEO → update published_at. Uses blog_get_post → ai_enhance_content → blog_update_post → optimize_*.',
      argsSchema: {
        postId: z.string().describe('UUID of the blog post to refresh.'),
      },
    },
    (args) => {
      const postId = args.postId;
      const text = [
        `Refresh Trndinn blog post ${postId} for 2026 accuracy and freshness.`,
        '',
        'Execute this sequence, calling one MCP tool per step:',
        '',
        `1. \`blog_get_post\` for id=${postId}. Read title, body, seo_*, faq_json, published_at.`,
        `2. \`ai_enhance_content\` with the current body and instructions: "Update outdated stats, references, tool names, and dates to reflect the current year (2026). Preserve structure. Add any new 2026-relevant insight where natural."`,
        `3. \`ai_generate_seo_meta\` with the refreshed title + enhanced body.`,
        `4. \`ai_generate_faq\` with the enhanced body — a refresh often reveals better questions.`,
        `5. \`blog_update_post\` id=${postId} with patch={ body: <enhanced>, seo_title, seo_description, seo_keywords, faq_json, published_at: <now ISO> }.`,
        `6. \`optimize_generate_aeo\` and \`optimize_apply_aeo\` on the refreshed post.`,
        `7. \`optimize_generate_geo\` and \`optimize_apply_geo\`.`,
        `8. \`schema_generate\` to refresh structured_data.`,
        '',
        'Report a short diff summary at the end: what changed, which stats were updated, which FAQ items were replaced.',
      ].join('\n');
      return {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text },
          },
        ],
      };
    },
  );

  // ── /optimize_blog_post ───────────────────────────────────────────────
  server.registerPrompt(
    'optimize_blog_post',
    {
      title: 'Run AEO+GEO+SEO on a post and apply the top wins',
      description:
        'Analyze a post across all three optimization dimensions and apply the highest-impact patches. Uses content_engine_optimize_report → optimize_apply_patches → schema_generate.',
      argsSchema: {
        postId: z.string().describe('UUID of the blog post to optimize.'),
      },
    },
    (args) => {
      const postId = args.postId;
      const text = [
        `Run full AEO+GEO+SEO optimization on Trndinn blog post ${postId} and apply the top wins.`,
        '',
        'Execute this sequence, calling one MCP tool per step:',
        '',
        `1. \`content_engine_scores\` for post_id=${postId} to record the baseline (seo/aeo/geo/eeat/readability/quality).`,
        `2. \`content_engine_optimize_report\` for post_id=${postId}. Read the prioritized suggestions and combined recommendations.`,
        `3. \`optimize_generate_aeo\` for post_id=${postId}. Identify the top 3 AEO patches by expected score lift.`,
        `4. \`optimize_generate_geo\` for post_id=${postId}. Identify the top 3 GEO patches.`,
        `5. \`optimize_apply_patches\` with the combined top patches from steps 3-4. Only apply patches you can justify.`,
        `6. \`schema_generate\` to refresh JSON-LD after body changes.`,
        `7. \`content_engine_scores\` again to compute the score delta.`,
        '',
        'Return: baseline scores, applied patch list, final scores, and net delta per dimension.',
      ].join('\n');
      return {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text },
          },
        ],
      };
    },
  );

  // ── /bulk_seo_pages ───────────────────────────────────────────────────
  server.registerPrompt(
    'bulk_seo_pages',
    {
      title: 'Fill SEO metadata for multiple static routes',
      description:
        'For each route: AI-generate SEO fields, review, then upsert. Uses page_seo_ai_fill → page_seo_upsert in a loop.',
      argsSchema: {
        routes: z
          .string()
          .describe(
            'Comma-separated list of route paths, e.g. "/pricing,/features,/blog".',
          ),
        primaryKeyword: z
          .string()
          .optional()
          .describe(
            'Optional primary keyword to weave into every route. Skip for per-route defaults.',
          ),
      },
    },
    (args) => {
      const routes = args.routes;
      const primary = args.primaryKeyword?.trim() || '';
      const text = [
        `Fill SEO metadata for these Trndinn marketing routes: ${routes}`,
        primary
          ? `Primary keyword hint (apply where relevant): "${primary}"`
          : '',
        '',
        'For EACH route in the list, execute this sequence:',
        '',
        `1. \`page_seo_get\` route_path=<route> to see the current row (if any).`,
        `2. \`page_seo_ai_fill\` route=<route>${primary ? `, primaryKeyword="${primary}"` : ''}. Capture the AI-generated meta_title, meta_description, h1_override, og_title, og_description.`,
        `3. Review the generated fields for character-limit compliance (title ≤ 60, description ≤ 160) and keyword alignment.`,
        `4. \`page_seo_upsert\` with route_path=<route>, seo_title, seo_description, og_title, og_description, h1_override, robots="index,follow".`,
        '',
        'After the loop, run `page_seo_list` and return a compact table of route → seo_title → seo_description length.',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text },
          },
        ],
      };
    },
  );

  // ── /research_and_write ───────────────────────────────────────────────
  server.registerPrompt(
    'research_and_write',
    {
      title: 'Research keyword → plan cluster → draft pillar → publish',
      description:
        'Full research-to-publish flow. Uses seo_list_keywords → keyword_create (as needed) → ai_generate_plan → ai_generate_article → blog_create_post → optimize_* → blog_publish_post.',
      argsSchema: {
        keyword: z
          .string()
          .describe(
            'Primary keyword to research and build a pillar post around.',
          ),
        cluster: z
          .string()
          .optional()
          .describe('Optional cluster slug to group related keywords into.'),
      },
    },
    (args) => {
      const keyword = args.keyword;
      const cluster = args.cluster?.trim() || '';
      const text = [
        `Research the keyword "${keyword}", plan a content cluster, draft a pillar post, and publish it.`,
        cluster ? `Cluster slug: ${cluster}` : '',
        '',
        'Execute this sequence, calling one MCP tool per step:',
        '',
        `1. \`seo_list_keywords\` with q="${keyword}" to see if we already track this or related terms.`,
        `2. If the primary keyword is missing, \`keyword_create\` with keyword="${keyword}", intent="informational"${cluster ? `, cluster="${cluster}"` : ''}, priority=80, status="active".`,
        `3. Identify 5-10 related long-tail supporting keywords. \`keyword_bulk_import\` with those keywords${cluster ? `, cluster="${cluster}"` : ''}.`,
        `4. \`seo_list_clusters\` to see cluster health. Confirm the cluster now has enough terms to justify a pillar.`,
        `5. \`ai_generate_plan\` with primary_keyword="${keyword}", secondary_keywords=<supporting terms>, target_audience="B2B SaaS marketers", search_intent="informational", article_length=2500. Review the plan.`,
        `6. \`ai_generate_article\` with { plan, input } from step 5. Capture the returned article.`,
        `7. \`blog_create_post\` mode="full" with article.title, slug, body, excerpt, seo_*, faq_json, tags. Capture the post id.`,
        `8. \`assignment_bulk_upsert\` target_type="blog_post", target_ref=<new post id>, keyword_ids=[<primary + supporting ids>], primary_keyword_id=<primary id> to attach the cluster to the post.`,
        `9. \`optimize_generate_aeo\` → \`optimize_apply_aeo\`. Same for GEO.`,
        `10. \`schema_generate\` for JSON-LD.`,
        `11. \`image_plan\` → \`image_generate\` → \`image_approve\` → \`image_insert\`.`,
        `12. \`links_analyze\` to find internal linking opportunities into existing posts.`,
        `13. \`blog_publish_post\` to go live.`,
        '',
        'Report: cluster size, article word count, applied optimizations, image count, internal links inserted, and final published URL.',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text },
          },
        ],
      };
    },
  );
}
