import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { CacheService } from './cache.service';
import {
  DEFAULT_LEGAL_PAGES,
  LEGAL_PAGE_SLUGS,
  getDefaultLegalPage,
  isStaleLegalDbRow,
  type LegalPageDefault,
} from '../config/legal-content';
import {
  DEFAULT_SITE_CONTENT,
  SITE_CONTENT_KEYS,
  getDefaultSiteContent,
} from '../config/site-content-defaults';
import {
  DEFAULT_PRICING_META,
  type PricingMeta,
} from '../config/pricing-features';

const CACHE_TTL = 300; // 5 minutes
/** Bump when legal default templates change to invalidate stale Redis entries. */
const LEGAL_CACHE_VERSION = 'v2';
const C = {
  announcementsPublic: 'site:announcements:public',
  legalPublicList: `site:legal:list:${LEGAL_CACHE_VERSION}`,
  legalPublic: (slug: string) => `site:legal:${LEGAL_CACHE_VERSION}:${slug}`,
  contentPublic: (key: string) => `site:content:${key}`,
  pricingMeta: 'site:content:pricing_meta',
};

export type AnnouncementVariant =
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'promo';

export interface SiteAnnouncement {
  id: string;
  message: string;
  title: string | null;
  detail: string | null;
  variant: AnnouncementVariant;
  linkUrl: string | null;
  linkLabel: string | null;
  isActive: boolean;
  dismissible: boolean;
  startsAt: string | null;
  endsAt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface LegalPagePublic {
  slug: string;
  title: string;
  summary: string;
  body: string;
  seoDescription: string;
  version: string;
  effectiveDate: string;
  sortOrder: number;
  isPublished: boolean;
  /** true when served from code defaults (no DB override saved). */
  isDefault: boolean;
  updatedAt: string | null;
}

export interface SiteContentPublic {
  key: string;
  content: Record<string, unknown>;
  isDefault: boolean;
  updatedAt: string | null;
}

@Injectable()
export class SiteContentService {
  private readonly logger = new Logger(SiteContentService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
  ) {}

  private db() {
    return this.supabaseService.getServiceClient();
  }

  // ===========================================================================
  // Announcements
  // ===========================================================================
  private mapAnnouncement(row: Record<string, any>): SiteAnnouncement {
    return {
      id: String(row.id),
      message: String(row.message ?? ''),
      title: row.title ?? null,
      detail: row.detail ?? null,
      variant: (row.variant ?? 'info') as AnnouncementVariant,
      linkUrl: row.link_url ?? null,
      linkLabel: row.link_label ?? null,
      isActive: Boolean(row.is_active),
      dismissible: Boolean(row.dismissible),
      startsAt: row.starts_at ?? null,
      endsAt: row.ends_at ?? null,
      sortOrder: Number(row.sort_order ?? 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listPublicAnnouncements(): Promise<SiteAnnouncement[]> {
    const cached = await this.cacheService.get(C.announcementsPublic);
    if (cached) return cached as SiteAnnouncement[];

    const nowIso = new Date().toISOString();
    const { data, error } = await this.db()
      .from('site_announcements')
      .select('*')
      .eq('is_active', true)
      .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`listPublicAnnouncements: ${error.message}`);
      return [];
    }

    const now = Date.now();
    const rows = (data ?? [])
      .map((r) => this.mapAnnouncement(r))
      .filter(
        (a) => !a.endsAt || new Date(a.endsAt).getTime() >= now,
      );

    await this.cacheService.set(C.announcementsPublic, rows, CACHE_TTL);
    return rows;
  }

  async adminListAnnouncements(): Promise<SiteAnnouncement[]> {
    const { data, error } = await this.db()
      .from('site_announcements')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => this.mapAnnouncement(r));
  }

  async createAnnouncement(
    input: Partial<SiteAnnouncement>,
    userId?: string,
  ): Promise<SiteAnnouncement> {
    const row: Record<string, unknown> = {
      message: input.message ?? '',
      title: input.title ?? null,
      detail: input.detail ?? null,
      variant: input.variant ?? 'info',
      link_url: input.linkUrl ?? null,
      link_label: input.linkLabel ?? null,
      is_active: input.isActive ?? true,
      dismissible: input.dismissible ?? true,
      starts_at: input.startsAt ?? null,
      ends_at: input.endsAt ?? null,
      sort_order: input.sortOrder ?? 0,
    };
    if (userId) row.created_by = userId;

    const { data, error } = await this.db()
      .from('site_announcements')
      .insert(row)
      .select()
      .single();
    if (error) throw new Error(error.message);
    await this.cacheService.delete(C.announcementsPublic);
    return this.mapAnnouncement(data);
  }

  async updateAnnouncement(
    id: string,
    patch: Partial<SiteAnnouncement>,
  ): Promise<SiteAnnouncement> {
    const row: Record<string, unknown> = {};
    if (patch.message !== undefined) row.message = patch.message;
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.detail !== undefined) row.detail = patch.detail;
    if (patch.variant !== undefined) row.variant = patch.variant;
    if (patch.linkUrl !== undefined) row.link_url = patch.linkUrl;
    if (patch.linkLabel !== undefined) row.link_label = patch.linkLabel;
    if (patch.isActive !== undefined) row.is_active = patch.isActive;
    if (patch.dismissible !== undefined) row.dismissible = patch.dismissible;
    if (patch.startsAt !== undefined) row.starts_at = patch.startsAt;
    if (patch.endsAt !== undefined) row.ends_at = patch.endsAt;
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;

    const { data, error } = await this.db()
      .from('site_announcements')
      .update(row)
      .eq('id', id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException('Announcement not found');
    await this.cacheService.delete(C.announcementsPublic);
    return this.mapAnnouncement(data);
  }

  async deleteAnnouncement(id: string): Promise<void> {
    const { error } = await this.db()
      .from('site_announcements')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    await this.cacheService.delete(C.announcementsPublic);
  }

  // ===========================================================================
  // Legal pages
  // ===========================================================================
  private defaultToPublic(def: LegalPageDefault): LegalPagePublic {
    return {
      slug: def.slug,
      title: def.title,
      summary: def.summary,
      body: def.body,
      seoDescription: def.seoDescription,
      version: def.version,
      effectiveDate: def.effectiveDate,
      sortOrder: def.sortOrder,
      isPublished: true,
      isDefault: true,
      updatedAt: null,
    };
  }

  private mergeLegal(
    def: LegalPageDefault,
    row: Record<string, any> | null,
  ): LegalPagePublic {
    // Draft CMS rows with bracket placeholders must not override code defaults.
    if (!row || isStaleLegalDbRow(row)) return this.defaultToPublic(def);
    return {
      slug: def.slug,
      title: row.title ?? def.title,
      summary: row.summary ?? def.summary,
      body: row.body && String(row.body).trim().length ? row.body : def.body,
      seoDescription: row.seo_description ?? def.seoDescription,
      version: row.version ?? def.version,
      effectiveDate: row.effective_date ?? def.effectiveDate,
      sortOrder: Number(row.sort_order ?? def.sortOrder),
      isPublished: Boolean(row.is_published ?? true),
      isDefault: false,
      updatedAt: row.updated_at ?? null,
    };
  }

  async getLegalPublic(slug: string): Promise<LegalPagePublic | null> {
    const def = getDefaultLegalPage(slug);
    if (!def) return null;

    const cached = await this.cacheService.get(C.legalPublic(slug));
    if (cached) return cached as LegalPagePublic;

    const { data } = await this.db()
      .from('legal_pages')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    const merged = this.mergeLegal(def, data ?? null);
    if (!merged.isPublished) {
      // Unpublished override → fall back to nothing (404) for public.
      return null;
    }
    await this.cacheService.set(C.legalPublic(slug), merged, CACHE_TTL);
    return merged;
  }

  async listLegalPublic(): Promise<
    Array<Pick<LegalPagePublic, 'slug' | 'title' | 'summary' | 'sortOrder'>>
  > {
    const cached = await this.cacheService.get(C.legalPublicList);
    if (cached) return cached as any;

    const { data } = await this.db().from('legal_pages').select('*');
    const overrides = new Map<string, Record<string, any>>(
      (data ?? []).map((r) => [r.slug, r]),
    );

    const list = LEGAL_PAGE_SLUGS.map((slug) =>
      this.mergeLegal(DEFAULT_LEGAL_PAGES[slug], overrides.get(slug) ?? null),
    )
      .filter((p) => p.isPublished)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(({ slug, title, summary, sortOrder }) => ({
        slug,
        title,
        summary,
        sortOrder,
      }));

    await this.cacheService.set(C.legalPublicList, list, CACHE_TTL);
    return list;
  }

  async adminListLegal(): Promise<LegalPagePublic[]> {
    const { data } = await this.db().from('legal_pages').select('*');
    const overrides = new Map<string, Record<string, any>>(
      (data ?? []).map((r) => [r.slug, r]),
    );
    return LEGAL_PAGE_SLUGS.map((slug) =>
      this.mergeLegal(DEFAULT_LEGAL_PAGES[slug], overrides.get(slug) ?? null),
    ).sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async adminGetLegal(slug: string): Promise<LegalPagePublic> {
    const def = getDefaultLegalPage(slug);
    if (!def) throw new NotFoundException('Unknown legal page');
    const { data } = await this.db()
      .from('legal_pages')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();
    return this.mergeLegal(def, data ?? null);
  }

  async upsertLegal(
    slug: string,
    patch: Partial<LegalPagePublic>,
    userId?: string,
  ): Promise<LegalPagePublic> {
    const def = getDefaultLegalPage(slug);
    if (!def) throw new NotFoundException('Unknown legal page');

    const row: Record<string, unknown> = { slug };
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.summary !== undefined) row.summary = patch.summary;
    if (patch.body !== undefined) row.body = patch.body;
    if (patch.seoDescription !== undefined)
      row.seo_description = patch.seoDescription;
    if (patch.version !== undefined) row.version = patch.version;
    if (patch.effectiveDate !== undefined)
      row.effective_date = patch.effectiveDate || null;
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
    if (patch.isPublished !== undefined) row.is_published = patch.isPublished;
    if (userId) row.updated_by = userId;

    // Ensure required NOT NULL columns on first insert.
    if (row.title === undefined) row.title = def.title;
    if (row.body === undefined) row.body = def.body;

    const { data, error } = await this.db()
      .from('legal_pages')
      .upsert(row, { onConflict: 'slug' })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await this.cacheService.delete(C.legalPublic(slug));
    await this.cacheService.delete(C.legalPublicList);
    return this.mergeLegal(def, data);
  }

  async resetLegal(slug: string): Promise<LegalPagePublic> {
    const def = getDefaultLegalPage(slug);
    if (!def) throw new NotFoundException('Unknown legal page');
    await this.db().from('legal_pages').delete().eq('slug', slug);
    await this.cacheService.delete(C.legalPublic(slug));
    await this.cacheService.delete(C.legalPublicList);
    return this.defaultToPublic(def);
  }

  // ===========================================================================
  // Site content (marketing copy blocks)
  // ===========================================================================
  async getContentPublic(key: string): Promise<SiteContentPublic | null> {
    const def = getDefaultSiteContent(key);
    if (!def) return null;

    const cached = await this.cacheService.get(C.contentPublic(key));
    if (cached) return cached as SiteContentPublic;

    const { data } = await this.db()
      .from('site_content')
      .select('*')
      .eq('section_key', key)
      .maybeSingle();

    const isDefault = !data || data.is_published === false;
    const content =
      data && data.is_published !== false && data.content
        ? { ...def, ...(data.content as Record<string, unknown>) }
        : def;

    const out: SiteContentPublic = {
      key,
      content,
      isDefault,
      updatedAt: data?.updated_at ?? null,
    };
    await this.cacheService.set(C.contentPublic(key), out, CACHE_TTL);
    return out;
  }

  async getAllPublicContent(): Promise<Record<string, Record<string, unknown>>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const key of SITE_CONTENT_KEYS) {
      const c = await this.getContentPublic(key);
      if (c) out[key] = c.content;
    }
    return out;
  }

  async adminListContent(): Promise<SiteContentPublic[]> {
    const { data } = await this.db().from('site_content').select('*');
    const overrides = new Map<string, Record<string, any>>(
      (data ?? []).map((r) => [r.section_key, r]),
    );
    return SITE_CONTENT_KEYS.map((key) => {
      const row = overrides.get(key);
      const def = DEFAULT_SITE_CONTENT[key];
      return {
        key,
        content:
          row && row.content
            ? { ...def, ...(row.content as Record<string, unknown>) }
            : def,
        isDefault: !row,
        updatedAt: row?.updated_at ?? null,
      };
    });
  }

  async upsertContent(
    key: string,
    content: Record<string, unknown>,
    userId?: string,
  ): Promise<SiteContentPublic> {
    if (!getDefaultSiteContent(key)) {
      throw new NotFoundException('Unknown content key');
    }
    const row: Record<string, unknown> = {
      section_key: key,
      content,
      is_published: true,
    };
    if (userId) row.updated_by = userId;

    const { data, error } = await this.db()
      .from('site_content')
      .upsert(row, { onConflict: 'section_key' })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await this.cacheService.delete(C.contentPublic(key));
    return {
      key,
      content: { ...DEFAULT_SITE_CONTENT[key as keyof typeof DEFAULT_SITE_CONTENT], ...(data.content as Record<string, unknown>) },
      isDefault: false,
      updatedAt: data.updated_at,
    };
  }

  async resetContent(key: string): Promise<SiteContentPublic> {
    const def = getDefaultSiteContent(key);
    if (!def) throw new NotFoundException('Unknown content key');
    await this.db().from('site_content').delete().eq('section_key', key);
    await this.cacheService.delete(C.contentPublic(key));
    return { key, content: def, isDefault: true, updatedAt: null };
  }

  // ===========================================================================
  // Pricing display metadata (feature bullets / descriptions / highlights)
  // SSOT defaults from pricing-features.ts; admin overrides via site_content key.
  // ===========================================================================
  async getPricingMetaPublic(): Promise<PricingMeta> {
    const cached = await this.cacheService.get(C.pricingMeta);
    if (cached) return cached as PricingMeta;

    const { data } = await this.db()
      .from('site_content')
      .select('content,is_published')
      .eq('section_key', 'pricing_meta')
      .maybeSingle();

    let meta: PricingMeta = DEFAULT_PRICING_META;
    if (data && data.is_published !== false && data.content) {
      meta = { ...DEFAULT_PRICING_META, ...(data.content as Partial<PricingMeta>) } as PricingMeta;
    }
    await this.cacheService.set(C.pricingMeta, meta, CACHE_TTL);
    return meta;
  }

  async adminGetPricingMeta(): Promise<{ meta: PricingMeta; isDefault: boolean }> {
    const { data } = await this.db()
      .from('site_content')
      .select('content,is_published')
      .eq('section_key', 'pricing_meta')
      .maybeSingle();
    if (data && data.is_published !== false && data.content) {
      return {
        meta: { ...DEFAULT_PRICING_META, ...(data.content as Partial<PricingMeta>) } as PricingMeta,
        isDefault: false,
      };
    }
    return { meta: DEFAULT_PRICING_META, isDefault: true };
  }

  async upsertPricingMeta(
    meta: Partial<PricingMeta>,
    userId?: string,
  ): Promise<PricingMeta> {
    const row: Record<string, unknown> = {
      section_key: 'pricing_meta',
      content: meta,
      is_published: true,
    };
    if (userId) row.updated_by = userId;
    const { error } = await this.db()
      .from('site_content')
      .upsert(row, { onConflict: 'section_key' });
    if (error) throw new Error(error.message);
    await this.cacheService.delete(C.pricingMeta);
    return { ...DEFAULT_PRICING_META, ...meta } as PricingMeta;
  }

  async resetPricingMeta(): Promise<PricingMeta> {
    await this.db().from('site_content').delete().eq('section_key', 'pricing_meta');
    await this.cacheService.delete(C.pricingMeta);
    return DEFAULT_PRICING_META;
  }
}
