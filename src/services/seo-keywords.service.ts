import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';

export interface SeoKeyword {
  id: string;
  keyword: string;
  normalized_keyword: string;
  intent: 'informational' | 'commercial' | 'transactional' | 'navigational';
  cluster: string | null;
  priority: number;
  language: string;
  status: 'active' | 'paused' | 'archived' | 'banned';
  notes: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SeoKeywordAssignment {
  id: string;
  keyword_id: string;
  target_type: 'route' | 'page_type' | 'blog_post' | 'template';
  target_ref: string;
  weight: number;
  is_primary: boolean;
  created_at: string;
  keyword?: Pick<
    SeoKeyword,
    'id' | 'keyword' | 'normalized_keyword' | 'intent' | 'cluster' | 'status'
  >;
}

export interface CreateKeywordDto {
  keyword: string;
  intent?: SeoKeyword['intent'];
  cluster?: string;
  priority?: number;
  language?: string;
  status?: SeoKeyword['status'];
  notes?: string;
  actorId?: string;
}

export interface UpdateKeywordDto {
  keyword?: string;
  intent?: SeoKeyword['intent'];
  cluster?: string | null;
  priority?: number;
  language?: string;
  status?: SeoKeyword['status'];
  notes?: string | null;
  actorId?: string;
}

export interface UpsertAssignmentDto {
  keyword_id: string;
  target_type: SeoKeywordAssignment['target_type'];
  target_ref: string;
  weight?: number;
  is_primary?: boolean;
}

export interface BulkUpsertAssignmentsDto {
  target_type: UpsertAssignmentDto['target_type'];
  target_ref: string;
  keyword_ids: string[];
  weight?: number;
  /** If set, clears other primaries for this target then marks this keyword primary. Must be included in keyword_ids. */
  primary_keyword_id?: string | null;
}

export interface KeywordFilters {
  status?: string;
  cluster?: string;
  intent?: string;
  q?: string;
  page?: number;
  limit?: number;
}

function normalizeKeyword(kw: string): string {
  return kw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Trims, strips nested surrounding square brackets, collapses spaces, strips surrounding double quotes. */
export function cleanKeywordText(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ');
  let prev = '';
  while (prev !== s) {
    prev = s;
    while (s.startsWith('[') && s.endsWith(']') && s.length >= 2) {
      s = s.slice(1, -1).trim().replace(/\s+/g, ' ');
    }
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
      s = s.slice(1, -1).trim().replace(/\s+/g, ' ');
    }
  }
  return s;
}

const INTENT_VALUES: SeoKeyword['intent'][] = [
  'informational',
  'commercial',
  'transactional',
  'navigational',
];
const STATUS_VALUES: SeoKeyword['status'][] = [
  'active',
  'paused',
  'archived',
  'banned',
];

function parseBulkIntent(v: unknown): SeoKeyword['intent'] {
  if (v === undefined || v === null || v === '') return 'informational';
  const s = String(v);
  if (!INTENT_VALUES.includes(s as SeoKeyword['intent'])) {
    throw new BadRequestException(`Invalid intent: ${s}`);
  }
  return s as SeoKeyword['intent'];
}

function parseBulkStatus(v: unknown): SeoKeyword['status'] {
  if (v === undefined || v === null || v === '') return 'active';
  const s = String(v);
  if (!STATUS_VALUES.includes(s as SeoKeyword['status'])) {
    throw new BadRequestException(`Invalid status: ${s}`);
  }
  return s as SeoKeyword['status'];
}

/** Cluster slug: lowercase letters, digits, hyphens only; empty after cleanup → null. */
function sanitizeClusterSlug(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

function validateKeyword(kw: string): void {
  if (!kw || kw.length < 2 || kw.length > 80) {
    throw new BadRequestException('Keyword must be 2–80 characters');
  }
}

@Injectable()
export class SeoKeywordsService {
  private readonly logger = new Logger(SeoKeywordsService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  private get client() {
    return this.supabaseService.getServiceClient();
  }

  async getAllKeywords(
    filters: KeywordFilters = {},
  ): Promise<{ data: SeoKeyword[]; total: number }> {
    const { status, cluster, intent, q, page = 1, limit = 50 } = filters;
    const offset = (page - 1) * limit;

    let query = this.client
      .from('seo_keywords')
      .select('*', { count: 'exact' })
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (cluster) query = query.eq('cluster', cluster);
    if (intent) query = query.eq('intent', intent);
    if (q) query = query.ilike('keyword', `%${q}%`);

    const { data, error, count } = await query;
    if (error) throw new BadRequestException(error.message);

    return { data: data ?? [], total: count ?? 0 };
  }

  async createKeyword(dto: CreateKeywordDto): Promise<SeoKeyword> {
    const cleanedKeyword = cleanKeywordText(dto.keyword);
    validateKeyword(cleanedKeyword);
    const normalized = normalizeKeyword(cleanedKeyword);

    const { data, error } = await this.client
      .from('seo_keywords')
      .insert({
        keyword: cleanedKeyword,
        normalized_keyword: normalized,
        intent: dto.intent ?? 'informational',
        cluster: dto.cluster?.trim() || null,
        priority: dto.priority ?? 50,
        language: dto.language ?? 'en',
        status: dto.status ?? 'active',
        notes: dto.notes?.trim() || null,
        created_by: dto.actorId ?? null,
        updated_by: dto.actorId ?? null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new BadRequestException(
          `Keyword already exists: "${normalized}"`,
        );
      }
      throw new BadRequestException(error.message);
    }

    await this.logChange(
      'create',
      { keyword_id: data.id, keyword: data.keyword },
      dto.actorId,
    );
    return data;
  }

  async updateKeyword(id: string, dto: UpdateKeywordDto): Promise<SeoKeyword> {
    const update: Record<string, unknown> = { updated_by: dto.actorId ?? null };

    if (dto.keyword !== undefined) {
      const cleaned = cleanKeywordText(dto.keyword);
      validateKeyword(cleaned);
      update['keyword'] = cleaned;
      update['normalized_keyword'] = normalizeKeyword(cleaned);
    }
    if (dto.intent !== undefined) update['intent'] = dto.intent;
    if (dto.cluster !== undefined)
      update['cluster'] = dto.cluster?.trim() || null;
    if (dto.priority !== undefined) update['priority'] = dto.priority;
    if (dto.language !== undefined) update['language'] = dto.language;
    if (dto.status !== undefined) update['status'] = dto.status;
    if (dto.notes !== undefined) update['notes'] = dto.notes?.trim() || null;

    const { data, error } = await this.client
      .from('seo_keywords')
      .update(update)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === '23505')
        throw new BadRequestException('Keyword already exists');
      if (error.code === 'PGRST116')
        throw new NotFoundException('Keyword not found');
      throw new BadRequestException(error.message);
    }

    await this.logChange(
      'update',
      { keyword_id: id, changes: dto },
      dto.actorId,
    );
    return data;
  }

  async deleteKeyword(id: string, actorId?: string): Promise<void> {
    const { error } = await this.client
      .from('seo_keywords')
      .update({ status: 'archived', updated_by: actorId ?? null })
      .eq('id', id);

    if (error) throw new BadRequestException(error.message);
    await this.logChange('archive', { keyword_id: id }, actorId);
  }

  async bulkImport(
    rawKeywords: string[],
    options?: {
      cluster?: string | null;
      intent?: unknown;
      priority?: number;
      language?: unknown;
      status?: unknown;
    },
    actorId?: string,
  ): Promise<{ created: number; skipped: number; errors: string[] }> {
    const defaultCluster = sanitizeClusterSlug(options?.cluster ?? null);
    const intent = parseBulkIntent(options?.intent);
    const status = parseBulkStatus(options?.status);
    let priority =
      typeof options?.priority === 'number' && Number.isFinite(options.priority)
        ? Math.round(options.priority)
        : 50;
    if (priority < 1) priority = 1;
    if (priority > 100) priority = 100;
    const language =
      typeof options?.language === 'string' &&
      options.language.trim().length > 0
        ? options.language.trim()
        : 'en';

    const segments = rawKeywords.flatMap((line) =>
      line
        .split(/[\n,]+/)
        .map((seg) => seg.trim())
        .filter((seg) => seg.length > 0),
    );

    const resolved: {
      display: string;
      normalized: string;
      cluster: string | null;
    }[] = [];
    const seenNorm = new Set<string>();
    const errorsOut: string[] = [];
    let skippedInBatchDupes = 0;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const pipeIdx = segment.indexOf('|');
      let keywordSide: string;
      let clusterSide: string | undefined;

      if (pipeIdx >= 0) {
        keywordSide = segment.slice(0, pipeIdx).trim();
        clusterSide = segment.slice(pipeIdx + 1).trim();
      } else {
        keywordSide = segment;
        clusterSide = undefined;
      }

      let cluster: string | null;
      const lineSlug =
        clusterSide !== undefined && clusterSide.length > 0
          ? sanitizeClusterSlug(clusterSide)
          : null;
      if (lineSlug) {
        cluster = lineSlug;
      } else {
        cluster = defaultCluster ?? null;
      }

      const cleaned = cleanKeywordText(keywordSide);
      if (!cleaned || cleaned.length < 2 || cleaned.length > 80) {
        errorsOut.push(
          `Entry ${i + 1}: Invalid keyword length (${cleaned.length === 0 ? 'empty' : `${cleaned.length} chars`}): "${segment}"`,
        );
        continue;
      }

      const normalized = normalizeKeyword(cleaned);
      if (seenNorm.has(normalized)) {
        skippedInBatchDupes++;
        continue;
      }
      seenNorm.add(normalized);

      resolved.push({ display: cleaned, normalized, cluster });
    }

    let created = 0;
    let skipped = skippedInBatchDupes;

    for (const row of resolved) {
      const { error } = await this.client.from('seo_keywords').insert({
        keyword: row.display,
        normalized_keyword: row.normalized,
        intent,
        cluster: row.cluster,
        priority,
        language,
        status,
        created_by: actorId ?? null,
        updated_by: actorId ?? null,
      });

      if (error) {
        if (error.code === '23505') {
          skipped++;
        } else {
          errorsOut.push(`"${row.display}": ${error.message}`);
        }
      } else {
        created++;
      }
    }

    await this.logChange(
      'bulk_import',
      { created, skipped, total: resolved.length },
      actorId,
    );
    return { created, skipped, errors: errorsOut };
  }

  async bulkUpdateStatus(
    ids: string[],
    status: string,
    actorId?: string,
  ): Promise<number> {
    const allowed = ['active', 'paused', 'archived', 'banned'];
    if (!allowed.includes(status)) {
      throw new BadRequestException(`Invalid status: ${status}`);
    }

    const { data, error } = await this.client
      .from('seo_keywords')
      .update({ status, updated_by: actorId ?? null })
      .in('id', ids)
      .select('id');

    if (error) throw new BadRequestException(error.message);

    await this.logChange(
      'bulk_status',
      { ids, status, count: data?.length },
      actorId,
    );
    return data?.length ?? 0;
  }

  /**
   * Permanently delete keywords (assignments cascade). Use with admin confirmation only.
   */
  async bulkPermanentDelete(
    ids: string[],
    actorId?: string,
  ): Promise<{ deleted: number }> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new BadRequestException('ids must be a non-empty array');
    }
    const { data, error } = await this.client
      .from('seo_keywords')
      .delete()
      .in('id', ids)
      .select('id');
    if (error) throw new BadRequestException(error.message);
    const deleted = data?.length ?? 0;
    await this.logChange('bulk_permanent_delete', { ids, deleted }, actorId);
    return { deleted };
  }

  /**
   * Normalize marketing route paths the same way as BlogService.normalizeRoutePath
   * so admin assignments (`target_ref`) match `/blog/page-seo` and Next.js routes.
   */
  normalizeMarketingRoutePath(route: string): string {
    let r = route.trim();
    if (!r.startsWith('/')) r = `/${r}`;
    r = r.replace(/\/+$/, '') || '/';
    if (r.length > 512) throw new BadRequestException('route_path too long');
    return r;
  }

  /**
   * Public site metadata: first active keyword for this route, honoring primary/weight order.
   * Used by `/blog/page-seo` — no auth; only returns the cleaned phrase, not internal IDs.
   */
  async getPublicPrimaryRouteKeyword(
    normalizedRoutePath: string,
  ): Promise<string | null> {
    const r = this.normalizeMarketingRoutePath(normalizedRoutePath);
    const { data, error } = await this.client
      .from('seo_keyword_assignments')
      .select('is_primary, weight, keyword:seo_keywords(keyword, status)')
      .eq('target_type', 'route')
      .eq('target_ref', r)
      .order('is_primary', { ascending: false })
      .order('weight', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    for (const raw of data ?? []) {
      const rel = (raw as { keyword: unknown }).keyword;
      const kw = Array.isArray(rel) ? rel[0] : rel;
      if (!kw || typeof kw !== 'object' || kw === null) continue;
      const k = kw as { keyword?: string; status?: string };
      if (k.status !== 'active' || !k.keyword) continue;
      return cleanKeywordText(k.keyword);
    }
    return null;
  }

  async getAssignments(
    targetType: string,
    targetRef: string,
  ): Promise<SeoKeywordAssignment[]> {
    const { data, error } = await this.client
      .from('seo_keyword_assignments')
      .select(
        '*, keyword:seo_keywords(id, keyword, normalized_keyword, intent, cluster, status)',
      )
      .eq('target_type', targetType)
      .eq('target_ref', targetRef)
      .order('is_primary', { ascending: false })
      .order('weight', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as SeoKeywordAssignment[];
  }

  async upsertAssignment(
    dto: UpsertAssignmentDto,
  ): Promise<SeoKeywordAssignment> {
    const { data, error } = await this.client
      .from('seo_keyword_assignments')
      .upsert(
        {
          keyword_id: dto.keyword_id,
          target_type: dto.target_type,
          target_ref: dto.target_ref,
          weight: dto.weight ?? 50,
          is_primary: dto.is_primary ?? false,
        },
        { onConflict: 'keyword_id,target_type,target_ref' },
      )
      .select(
        '*, keyword:seo_keywords(id, keyword, normalized_keyword, intent, cluster, status)',
      )
      .single();

    if (error) throw new BadRequestException(error.message);
    return data as SeoKeywordAssignment;
  }

  async bulkUpsertAssignments(
    dto: BulkUpsertAssignmentsDto,
    actorId?: string,
  ): Promise<{ upserted: number }> {
    const rawIds = dto.keyword_ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw new BadRequestException('keyword_ids must be a non-empty array');
    }
    const keyword_ids = [
      ...new Set(rawIds.map((id) => String(id).trim()).filter(Boolean)),
    ];
    if (keyword_ids.length > 500) {
      throw new BadRequestException('Max 500 keywords per bulk assign');
    }
    if (!dto.target_ref?.trim()) {
      throw new BadRequestException('target_ref is required');
    }

    const target_type = dto.target_type;
    const validTargets: SeoKeywordAssignment['target_type'][] = [
      'route',
      'page_type',
      'blog_post',
      'template',
    ];
    if (!validTargets.includes(target_type)) {
      throw new BadRequestException(`Invalid target_type: ${target_type}`);
    }

    const primary = dto.primary_keyword_id?.trim() || null;
    if (primary && !keyword_ids.includes(primary)) {
      throw new BadRequestException(
        'primary_keyword_id must be included in keyword_ids',
      );
    }

    const weight = dto.weight ?? 50;
    const target_ref = dto.target_ref.trim();

    if (primary) {
      const { error: clearErr } = await this.client
        .from('seo_keyword_assignments')
        .update({ is_primary: false })
        .eq('target_type', target_type)
        .eq('target_ref', target_ref);
      if (clearErr) throw new BadRequestException(clearErr.message);
    }

    const rows = keyword_ids.map((keyword_id) => ({
      keyword_id,
      target_type,
      target_ref,
      weight,
      is_primary: primary === keyword_id,
    }));

    const { error } = await this.client
      .from('seo_keyword_assignments')
      .upsert(rows, {
        onConflict: 'keyword_id,target_type,target_ref',
      });

    if (error) throw new BadRequestException(error.message);

    await this.logChange(
      'bulk_assign',
      {
        target_type,
        target_ref,
        upserted: keyword_ids.length,
        primary_keyword_id: primary,
      },
      actorId,
    );

    return { upserted: keyword_ids.length };
  }

  async deleteAssignment(id: string): Promise<void> {
    const { error } = await this.client
      .from('seo_keyword_assignments')
      .delete()
      .eq('id', id);

    if (error) throw new BadRequestException(error.message);
  }

  async getClusters(): Promise<
    { cluster: string; count: number; active: number; paused: number }[]
  > {
    const { data, error } = await this.client
      .from('seo_keywords')
      .select('cluster, status')
      .not('cluster', 'is', null);

    if (error) throw new BadRequestException(error.message);

    const map = new Map<
      string,
      { count: number; active: number; paused: number }
    >();
    for (const row of data ?? []) {
      if (!row.cluster) continue;
      const entry = map.get(row.cluster) ?? { count: 0, active: 0, paused: 0 };
      entry.count++;
      if (row.status === 'active') entry.active++;
      if (row.status === 'paused') entry.paused++;
      map.set(row.cluster, entry);
    }

    return Array.from(map.entries())
      .map(([cluster, stats]) => ({ cluster, ...stats }))
      .sort((a, b) => b.count - a.count);
  }

  async logChange(
    action: string,
    payload: unknown,
    actorId?: string,
  ): Promise<void> {
    const { error } = await this.client.from('seo_keyword_changes').insert({
      action,
      payload,
      actor_user_id: actorId ?? null,
    });

    if (error) {
      this.logger.warn(`Failed to log seo_keyword_changes: ${error.message}`);
    }
  }
}
