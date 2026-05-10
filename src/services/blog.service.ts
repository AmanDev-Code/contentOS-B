import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { SeoKeywordsService } from './seo-keywords.service';
import { isPlatformAdmin } from '../common/platform-admin';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FEATURED_IMAGE_OBJECT_POSITION = new Set([
  'left',
  'center',
  'right',
  'top',
  'bottom',
]);

export type BlogPostKind =
  | 'article'
  | 'changelog'
  | 'release'
  | 'guide'
  | 'news'
  | 'announcement';

export type BlogPostStatus = 'draft' | 'scheduled' | 'published' | 'archived';

export interface CreateBlogPostInput {
  parent_id?: string | null;
  slug: string;
  title: string;
  subtitle?: string | null;
  excerpt?: string | null;
  body?: string;
  /** Editorial bucket for marketing blog cards (distinct from structural post_kind). */
  content_category?: string | null;
  post_kind?: BlogPostKind;
  status?: BlogPostStatus;
  scheduled_publish_at?: string | null;
  published_at?: string | null;
  display_order?: number;
  featured_image_url?: string | null;
  /** Lowercase presets: left, center, right, top, bottom; omit for default crops. */
  featured_image_object_position?: string | null;
  hero_style?: string;
  reading_minutes?: number | null;
  author_display_name?: string | null;
  author_bio?: string | null;
  author_avatar_url?: string | null;
  author_role?: string | null;
  author_linkedin_url?: string | null;
  tags?: string[];
  custom_css?: string | null;
  settings?: Record<string, unknown>;
  seo_title?: string | null;
  seo_description?: string | null;
  seo_keywords?: string | null;
  canonical_url?: string | null;
  og_image_url?: string | null;
  twitter_card?: string | null;
  robots?: string | null;
  structured_data?: Record<string, unknown> | null;
  locale?: string;
  faq_json?: Array<{ question: string; answer: string }> | null;
}

export interface StaticPageSeoInput {
  route_path: string;
  seo_title?: string | null;
  seo_description?: string | null;
  seo_keywords?: string | null;
  og_image_url?: string | null;
  og_title?: string | null;
  og_description?: string | null;
  canonical_url?: string | null;
  robots?: string | null;
  structured_data?: Record<string, unknown> | null;
  h1_override?: string | null;
}

@Injectable()
export class BlogService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly seoKeywordsService: SeoKeywordsService,
  ) {}

  isPlatformAdminUser(user: { id: string; email?: string }): boolean {
    return isPlatformAdmin(user);
  }

  async isBlogEditorOrAdmin(user: { id: string; email?: string }): Promise<boolean> {
    if (isPlatformAdmin(user)) return true;
    const client = this.supabaseService.getServiceClient();
    const { data } = await client
      .from('blog_editor_grants')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();
    return !!data;
  }

  /** Accepts lowercase presets only; anything else maps to null. */
  sanitizeFeaturedImageObjectPosition(raw: unknown): string | null {
    if (raw === null || raw === undefined || raw === '') return null;
    const s = String(raw).trim().toLowerCase();
    if (!FEATURED_IMAGE_OBJECT_POSITION.has(s)) return null;
    return s;
  }

  normalizeSlug(raw: string): string {
    const s = raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!s || !SLUG_RE.test(s)) {
      throw new BadRequestException(
        'Invalid slug: use lowercase letters, numbers, and single hyphens between words.',
      );
    }
    return s;
  }

  normalizeBlogPath(path: string): string {
    const p = path
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase();
    if (!p) throw new BadRequestException('Path cannot be empty');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(p)) {
      throw new BadRequestException(
        'Path must be URL segments of lowercase slugs, e.g. releases/v2-notes',
      );
    }
    return p;
  }

  normalizeRoutePath(route: string): string {
    let r = route.trim();
    if (!r.startsWith('/')) r = `/${r}`;
    r = r.replace(/\/+$/, '') || '/';
    if (r.length > 512) throw new BadRequestException('route_path too long');
    return r;
  }

  private isRowPubliclyVisible(row: {
    status: string;
    scheduled_publish_at?: string | null;
  }): boolean {
    if (row.status === 'published') return true;
    if (row.status === 'scheduled' && row.scheduled_publish_at) {
      const t = new Date(row.scheduled_publish_at).getTime();
      return !Number.isNaN(t) && t <= Date.now();
    }
    return false;
  }

  async listAllPublishedPathsForSitemap(): Promise<
    { path: string; published_at: string | null; updated_at: string | null }[]
  > {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('blog_posts')
      .select('path, published_at, updated_at, status, scheduled_publish_at')
      .in('status', ['published', 'scheduled'])
      .not('path', 'is', null)
      .order('published_at', { ascending: false, nullsFirst: false });
    if (error) throw new BadRequestException(error.message);
    return (data || [])
      .filter((r: any) => this.isRowPubliclyVisible(r) && r.path)
      .map((r: any) => ({
        path: r.path as string,
        published_at: (r.published_at as string) ?? null,
        updated_at: (r.updated_at as string) ?? null,
      }));
  }

  async listPublishedPosts(params: {
    post_kind?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }) {
    const client = this.supabaseService.getServiceClient();
    const limit = Math.min(Math.max(params.limit ?? 24, 1), 100);
    const offset = Math.max(params.offset ?? 0, 0);
    let q = client
      .from('blog_posts')
      .select(
        'id, parent_id, path, slug, title, subtitle, excerpt, post_kind, content_category, published_at, scheduled_publish_at, status, featured_image_url, featured_image_object_position, reading_minutes, author_display_name, author_role, author_avatar_url, tags, seo_title, seo_description, og_image_url',
      )
      .in('status', ['published', 'scheduled'])
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (params.post_kind) q = q.eq('post_kind', params.post_kind);
    if (params.tag) q = q.contains('tags', [params.tag]);

    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    const visible = (data || []).filter((r: any) => this.isRowPubliclyVisible(r));
    const posts = visible.slice(offset, offset + limit);
    return { posts };
  }

  async getPublishedPostByPath(path: string) {
    const normalized = this.normalizeBlogPath(path);
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('blog_posts')
      .select('*')
      .eq('path', normalized)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Post not found');
    if (!this.isRowPubliclyVisible(data as any)) {
      throw new NotFoundException('Post not found');
    }
    return data;
  }

  async listAdminPosts(filters?: { status?: string; q?: string }) {
    const client = this.supabaseService.getServiceClient();
    let q = client
      .from('blog_posts')
      .select(
        'id, parent_id, path, slug, title, post_kind, content_category, status, published_at, scheduled_publish_at, updated_at, tags',
      )
      .order('updated_at', { ascending: false });
    if (filters?.status) q = q.eq('status', filters.status);
    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    let list = data || [];
    if (filters?.q?.trim()) {
      const s = filters.q.trim().toLowerCase();
      list = list.filter(
        (row: any) =>
          String(row.title || '')
            .toLowerCase()
            .includes(s) ||
          String(row.path || '').toLowerCase().includes(s) ||
          String(row.id || '')
            .toLowerCase()
            .includes(s),
      );
    }
    return { posts: list };
  }

  async getAdminPost(id: string) {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('blog_posts')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Post not found');
    return data;
  }

  async createPost(userId: string, input: CreateBlogPostInput) {
    const slug = this.normalizeSlug(input.slug);
    const client = this.supabaseService.getServiceClient();
    let path: string;
    if (input.parent_id) {
      const { data: parent, error: pErr } = await client
        .from('blog_posts')
        .select('path')
        .eq('id', input.parent_id)
        .maybeSingle();
      if (pErr) throw new BadRequestException(pErr.message);
      if (!parent) throw new BadRequestException('Parent post not found');
      path = `${(parent as any).path}/${slug}`;
    } else {
      path = slug;
    }
    this.normalizeBlogPath(path);

    const row = {
      parent_id: input.parent_id || null,
      path,
      slug,
      title: input.title.trim(),
      subtitle: input.subtitle?.trim() || null,
      excerpt: input.excerpt?.trim() || null,
      body: input.body ?? '',
      content_category: input.content_category?.trim() || null,
      post_kind: input.post_kind ?? 'article',
      status: input.status ?? 'draft',
      scheduled_publish_at: input.scheduled_publish_at || null,
      published_at: input.published_at || null,
      display_order: input.display_order ?? 0,
      featured_image_url: input.featured_image_url || null,
      featured_image_object_position:
        this.sanitizeFeaturedImageObjectPosition(input.featured_image_object_position),
      hero_style: input.hero_style ?? 'default',
      reading_minutes: input.reading_minutes ?? null,
      author_display_name: input.author_display_name?.trim() || null,
      author_bio: input.author_bio?.trim() || null,
      author_avatar_url: input.author_avatar_url?.trim() || null,
      author_role: input.author_role?.trim() || null,
      author_linkedin_url: input.author_linkedin_url?.trim() || null,
      tags: input.tags ?? [],
      custom_css: input.custom_css || null,
      settings: input.settings ?? {},
      seo_title: input.seo_title?.trim() || null,
      seo_description: input.seo_description?.trim() || null,
      seo_keywords: input.seo_keywords?.trim() || null,
      canonical_url: input.canonical_url?.trim() || null,
      og_image_url: input.og_image_url?.trim() || null,
      twitter_card: input.twitter_card ?? 'summary_large_image',
      robots: input.robots ?? 'index,follow',
      structured_data: input.structured_data ?? null,
      locale: input.locale ?? 'en',
      faq_json: input.faq_json ?? null,
      created_by: userId,
    };

    if (row.status === 'published' && !row.published_at) {
      (row as any).published_at = new Date().toISOString();
    }

    const { data, error } = await client
      .from('blog_posts')
      .insert(row)
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505')
        throw new BadRequestException('Path already exists for another post');
      throw new BadRequestException(error.message);
    }
    return data;
  }

  async updatePost(id: string, patch: Record<string, unknown>) {
    const forbidden = ['id', 'path', 'slug', 'parent_id', 'created_by', 'created_at'];
    for (const k of forbidden) {
      if (k in patch) delete patch[k];
    }
    if ('featured_image_object_position' in patch) {
      patch.featured_image_object_position = this.sanitizeFeaturedImageObjectPosition(
        patch.featured_image_object_position,
      );
    }
    const client = this.supabaseService.getServiceClient();
    if (Object.keys(patch).length === 0) {
      return this.getAdminPost(id);
    }
    const { data, error } = await client
      .from('blog_posts')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async deletePost(id: string) {
    const client = this.supabaseService.getServiceClient();
    const { error } = await client.from('blog_posts').delete().eq('id', id);
    if (error) throw new BadRequestException(error.message);
    return { success: true };
  }

  async listEditors() {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('blog_editor_grants')
      .select('user_id, granted_by, created_at')
      .order('created_at', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    return { editors: data || [] };
  }

  async grantEditor(adminUserId: string, targetUserId: string) {
    if (adminUserId === targetUserId) {
      throw new BadRequestException('Cannot grant editor to yourself via this action');
    }
    const client = this.supabaseService.getServiceClient();
    const { error } = await client.from('blog_editor_grants').upsert(
      {
        user_id: targetUserId,
        granted_by: adminUserId,
      },
      { onConflict: 'user_id' },
    );
    if (error) throw new BadRequestException(error.message);
    return { success: true };
  }

  async revokeEditor(userId: string) {
    const client = this.supabaseService.getServiceClient();
    const { error } = await client.from('blog_editor_grants').delete().eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);
    return { success: true };
  }

  async getStaticPageSeo(routePath: string) {
    const path = this.normalizeRoutePath(routePath);
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('static_page_seo')
      .select('*')
      .eq('route_path', path)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  /**
   * Public marketing SEO payload for Next.js metadata: `static_page_seo` row (if any) plus
   * the primary assigned keyword phrase for `target_type=route` (drives title/description when
   * CMS fields are empty).
   */
  async getPublicPageSeoPayload(routePath: string) {
    const path = this.normalizeRoutePath(routePath);
    const row = await this.getStaticPageSeo(path);
    const assignment_primary_keyword = await this.seoKeywordsService.getPublicPrimaryRouteKeyword(
      path,
    );
    return {
      ...(row ?? {}),
      assignment_primary_keyword,
    };
  }

  async listStaticPageSeo() {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('static_page_seo')
      .select('*')
      .order('route_path');
    if (error) throw new BadRequestException(error.message);
    return { pages: data || [] };
  }

  async upsertStaticPageSeo(input: StaticPageSeoInput) {
    const route_path = this.normalizeRoutePath(input.route_path);
    const client = this.supabaseService.getServiceClient();
    const row = {
      route_path,
      seo_title: input.seo_title?.trim() || null,
      seo_description: input.seo_description?.trim() || null,
      seo_keywords: input.seo_keywords?.trim() || null,
      og_image_url: input.og_image_url?.trim() || null,
      og_title: input.og_title?.trim() || null,
      og_description: input.og_description?.trim() || null,
      canonical_url: input.canonical_url?.trim() || null,
      robots: input.robots ?? 'index,follow',
      structured_data: input.structured_data ?? null,
      h1_override: input.h1_override?.trim() || null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await client
      .from('static_page_seo')
      .upsert(row, { onConflict: 'route_path' })
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async deleteStaticPageSeo(routePath: string) {
    const path = this.normalizeRoutePath(routePath);
    const client = this.supabaseService.getServiceClient();
    const { error } = await client.from('static_page_seo').delete().eq('route_path', path);
    if (error) throw new BadRequestException(error.message);
    return { success: true };
  }
}
