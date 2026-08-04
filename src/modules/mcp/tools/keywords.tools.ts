/**
 * Pack G — Keywords + assignments tools (8).
 *
 * Wrappers over SeoKeywordsService CRUD, bulk operations, and assignment
 * lifecycle. `assignment_delete` is destructive (hard-deletes the row) and
 * requires `confirm: true`.
 *
 * Method signatures matched exactly against seo-keywords.service.ts:
 *   createKeyword(CreateKeywordDto)
 *   updateKeyword(id, UpdateKeywordDto)
 *   getAllKeywords(KeywordFilters)
 *   bulkImport(rawKeywords, options?, actorId?)
 *   bulkUpdateStatus(ids, status, actorId?)
 *   upsertAssignment(UpsertAssignmentDto)
 *   bulkUpsertAssignments(BulkUpsertAssignmentsDto, actorId?)
 *   deleteAssignment(id)
 */

import { z } from 'zod';
import type { McpToolDefinition } from '../tool-registry';
import { ok, err } from '../tool-registry';
import type {
  BulkUpsertAssignmentsDto,
  CreateKeywordDto,
  UpdateKeywordDto,
  UpsertAssignmentDto,
} from '../../../services/seo-keywords.service';

const IntentEnum = z.enum([
  'informational',
  'commercial',
  'transactional',
  'navigational',
]);
const StatusEnum = z.enum(['active', 'paused', 'archived', 'banned']);
const TargetTypeEnum = z.enum(['route', 'page_type', 'blog_post', 'template']);

export const keywordsTools: readonly McpToolDefinition[] = [
  {
    name: 'keyword_create',
    description:
      'Create a single SEO keyword. Enforces normalized-keyword uniqueness (case-insensitive, whitespace-collapsed). Defaults: intent=informational, priority=50, language=en, status=active.',
    requiredScope: 'seo:write',
    inputSchema: {
      keyword: z
        .string()
        .trim()
        .min(2)
        .max(80)
        .describe('The keyword phrase (2-80 chars).'),
      intent: IntentEnum.optional(),
      cluster: z
        .string()
        .trim()
        .max(100)
        .optional()
        .describe('Cluster slug (lowercase-hyphenated).'),
      priority: z.number().int().min(1).max(100).optional(),
      language: z.string().trim().max(10).optional(),
      status: StatusEnum.optional(),
      notes: z.string().trim().max(2000).optional(),
    },
    handler: async (args, ctx, services) => {
      const dto = args as unknown as CreateKeywordDto;
      const created = await services.seoKeywords.createKeyword({
        ...dto,
        actorId: ctx.user.id,
      });
      return ok(created);
    },
  },

  {
    name: 'keyword_update',
    description:
      'Update an existing SEO keyword. Any subset of updatable fields (keyword, intent, cluster, priority, language, status, notes). Renaming re-normalizes; conflicts return an error.',
    requiredScope: 'seo:write',
    inputSchema: {
      id: z.string().uuid().describe('Keyword UUID.'),
      keyword: z.string().trim().min(2).max(80).optional(),
      intent: IntentEnum.optional(),
      cluster: z.string().trim().max(100).nullable().optional(),
      priority: z.number().int().min(1).max(100).optional(),
      language: z.string().trim().max(10).optional(),
      status: StatusEnum.optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
    },
    handler: async (args, ctx, services) => {
      const { id, ...rest } = args as { id: string } & Record<string, unknown>;
      const dto = rest as unknown as UpdateKeywordDto;
      const updated = await services.seoKeywords.updateKeyword(id, {
        ...dto,
        actorId: ctx.user.id,
      });
      return ok(updated);
    },
  },

  {
    name: 'keyword_list',
    description:
      'List SEO keywords with filters and pagination. Returns { data, total }. Ordered by priority desc, then created_at desc.',
    requiredScope: 'seo:read',
    inputSchema: {
      status: StatusEnum.optional(),
      cluster: z.string().trim().min(1).max(100).optional(),
      intent: IntentEnum.optional(),
      q: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe('Case-insensitive substring search on the keyword field.'),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(200).optional(),
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
    name: 'keyword_bulk_import',
    description:
      'Bulk-import SEO keywords from an array. Each item may be "keyword" or "keyword|cluster-slug". Handles in-batch de-duplication and DB-level unique-constraint conflicts (skipped). Returns { created, skipped, errors }.',
    requiredScope: 'seo:write',
    inputSchema: {
      keywords: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(2000)
        .describe(
          'Array of keyword lines. Each line may be "keyword" or "keyword|cluster-slug".',
        ),
      cluster: z
        .string()
        .trim()
        .max(100)
        .nullable()
        .optional()
        .describe(
          'Default cluster slug applied when a line has no explicit cluster.',
        ),
      intent: IntentEnum.optional(),
      priority: z.number().int().min(1).max(100).optional(),
      language: z.string().trim().max(10).optional(),
      status: StatusEnum.optional(),
    },
    handler: async (args, ctx, services) => {
      const { keywords, cluster, intent, priority, language, status } =
        args as {
          keywords: string[];
          cluster?: string | null;
          intent?: string;
          priority?: number;
          language?: string;
          status?: string;
        };
      const result = await services.seoKeywords.bulkImport(
        keywords,
        { cluster, intent, priority, language, status },
        ctx.user.id,
      );
      return ok(result);
    },
  },

  {
    name: 'keyword_bulk_status',
    description:
      'Bulk-update status on many keywords in one call. Returns the number of rows updated.',
    requiredScope: 'seo:write',
    inputSchema: {
      ids: z
        .array(z.string().uuid())
        .min(1)
        .max(500)
        .describe('Keyword UUIDs to update.'),
      status: StatusEnum.describe(
        'New status for all listed keywords (active, paused, archived, banned).',
      ),
    },
    handler: async (args, ctx, services) => {
      const { ids, status } = args as { ids: string[]; status: string };
      const updated = await services.seoKeywords.bulkUpdateStatus(
        ids,
        status,
        ctx.user.id,
      );
      return ok({ updated });
    },
  },

  {
    name: 'assignment_upsert',
    description:
      'Create or update a single keyword→target assignment (composite unique on keyword_id + target_type + target_ref). Defaults: weight=50, is_primary=false.',
    requiredScope: 'seo:write',
    inputSchema: {
      keyword_id: z.string().uuid(),
      target_type: TargetTypeEnum,
      target_ref: z
        .string()
        .trim()
        .min(1)
        .max(512)
        .describe(
          'Target identifier: route path, page_type slug, blog post UUID, or template key.',
        ),
      weight: z.number().int().min(0).max(100).optional(),
      is_primary: z.boolean().optional(),
    },
    handler: async (args, _ctx, services) => {
      const dto = args as unknown as UpsertAssignmentDto;
      const assignment = await services.seoKeywords.upsertAssignment(dto);
      return ok(assignment);
    },
  },

  {
    name: 'assignment_bulk_upsert',
    description:
      'Bulk-upsert many keyword assignments to a single target. When primary_keyword_id is set, clears other primaries for that target first. Max 500 keywords per call.',
    requiredScope: 'seo:write',
    inputSchema: {
      target_type: TargetTypeEnum,
      target_ref: z.string().trim().min(1).max(512),
      keyword_ids: z.array(z.string().uuid()).min(1).max(500),
      weight: z.number().int().min(0).max(100).optional(),
      primary_keyword_id: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe(
          'Must also appear in keyword_ids. Sets is_primary=true on this row.',
        ),
    },
    handler: async (args, ctx, services) => {
      const dto = args as unknown as BulkUpsertAssignmentsDto;
      const result = await services.seoKeywords.bulkUpsertAssignments(
        dto,
        ctx.user.id,
      );
      return ok(result);
    },
  },

  {
    name: 'assignment_delete',
    description:
      'DESTRUCTIVE: Permanently delete a keyword assignment. This action cannot be undone. You MUST pass confirm=true.',
    requiredScope: 'seo:write',
    inputSchema: {
      id: z.string().uuid().describe('seo_keyword_assignments row UUID.'),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Must be true to execute. Otherwise returns without deleting.',
        ),
    },
    handler: async (args, _ctx, services) => {
      const { id, confirm } = args as { id: string; confirm?: boolean };
      if (confirm !== true) {
        return err(
          `Deletion NOT executed. To permanently delete assignment ${id}, call again with confirm=true.`,
          { assignment_id: id },
        );
      }
      await services.seoKeywords.deleteAssignment(id);
      return ok({ deleted: true, id });
    },
  },
];
