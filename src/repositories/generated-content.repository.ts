import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../services/supabase.service';
import { GeneratedContent, ContentStatus, VisualType } from '../common/types';

@Injectable()
export class GeneratedContentRepository {
  constructor(private supabaseService: SupabaseService) {}

  async create(
    userId: string,
    title: string,
    content: string,
    data: {
      jobId?: string;
      categoryId?: string;
      aiScore?: number;
      visualType?: VisualType;
      visualUrl?: string;
      carouselUrls?: string[];
      imageUrls?: string[];
      /** Optional pre-rendered carousel PDF URL (e.g. document-deck presets). */
      pdfUrl?: string;
      hashtags?: string[];
      aiReasoning?: string;
      performancePrediction?: Record<string, any>;
      suggestedImprovements?: string[];
      status?: ContentStatus;
      source?: 'viral' | 'custom';
    },
  ): Promise<GeneratedContent> {
    const { data: result, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .insert({
        user_id: userId,
        title,
        content,
        job_id: data.jobId,
        category_id: data.categoryId,
        ai_score: data.aiScore,
        status: data.status || ContentStatus.READY,
        visual_type: data.visualType || VisualType.IMAGE,
        visual_url: data.visualUrl,
        carousel_urls: data.carouselUrls,
        image_urls: data.imageUrls,
        pdf_url: data.pdfUrl,
        hashtags: data.hashtags,
        ai_reasoning: data.aiReasoning,
        performance_prediction: data.performancePrediction,
        suggested_improvements: data.suggestedImprovements,
        source: data.source || 'viral',
      })
      .select()
      .single();

    if (error) throw error;
    return result;
  }

  async findById(contentId: string): Promise<GeneratedContent | null> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('*')
      .eq('id', contentId)
      .is('deleted_at', null)
      .single();

    if (error) return null;
    return data;
  }

  async findByUserId(
    userId: string,
    limit = 50,
    offset = 0,
    sourceFilter?: 'viral' | 'custom',
  ): Promise<GeneratedContent[]> {
    let query = this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null);

    if (sourceFilter) {
      query = query.eq('source', sourceFilter);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return data || [];
  }

  async countByUserId(userId: string, sourceFilter?: 'viral' | 'custom'): Promise<number> {
    let query = this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('deleted_at', null);

    if (sourceFilter) {
      query = query.eq('source', sourceFilter);
    }

    const { count, error } = await query;

    if (error) throw error;
    return count || 0;
  }

  async findScheduledContent(
    userId: string,
    limit = 50,
    offset = 0,
  ): Promise<GeneratedContent[]> {
    // Legacy behavior: return already published rows for historical schedule view.
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('*')
      .eq('user_id', userId)
      .eq('publish_status', 'published')
      .not('published_at', 'is', null)
      .is('deleted_at', null)
      .order('published_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return data || [];
  }

  async countScheduledByUserId(userId: string): Promise<number> {
    const { count, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('publish_status', 'published')
      .not('published_at', 'is', null)
      .is('deleted_at', null);

    if (error) throw error;
    return count || 0;
  }

  async findByJobId(jobId: string): Promise<GeneratedContent[]> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('*')
      .eq('job_id', jobId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async findLatestUnlinkedByUserSince(
    userId: string,
    sinceIso: string,
  ): Promise<GeneratedContent | null> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .is('job_id', null)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  async attachJobIdIfMissing(
    contentId: string,
    jobId: string,
  ): Promise<GeneratedContent | null> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .update({
        job_id: jobId,
        updated_at: new Date(),
      })
      .eq('id', contentId)
      .is('job_id', null)
      .select('*')
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  async updateContent(
    contentId: string,
    updates: {
      title?: string;
      content?: string;
      hashtags?: string[];
      performance_prediction?: Record<string, unknown>;
      carousel_urls?: string[];
      image_urls?: string[];
      visual_url?: string;
      pdf_url?: string;
    },
  ): Promise<GeneratedContent> {
    const { performance_prediction, ...rest } = updates;
    const payload: Record<string, unknown> = {
      ...rest,
      updated_at: new Date(),
    };
    if (performance_prediction !== undefined) {
      payload.performance_prediction = performance_prediction;
    }
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .update(payload)
      .eq('id', contentId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Atomically replace a single URL in the `image_urls` text[] array (and
   * mirror the swap into `visual_url` when the index points at the row's
   * primary visual). Used by the per-image regeneration worker so that we
   * never clobber sibling images when two regenerations finish out of order.
   */
  async replaceImageUrlAtIndex(
    contentId: string,
    imageIndex: number,
    newUrl: string,
  ): Promise<GeneratedContent | null> {
    if (!Number.isInteger(imageIndex) || imageIndex < 0) {
      throw new Error(`replaceImageUrlAtIndex: invalid imageIndex=${imageIndex}`);
    }
    const client = this.supabaseService.getServiceClient();
    const { data: existing, error: fetchError } = await client
      .from('generated_content')
      .select('id,image_urls,visual_url')
      .eq('id', contentId)
      .is('deleted_at', null)
      .single();
    if (fetchError) throw fetchError;
    if (!existing) return null;

    const currentUrls: string[] = Array.isArray(existing.image_urls)
      ? [...existing.image_urls]
      : [];
    const previousUrl = currentUrls[imageIndex];
    while (currentUrls.length <= imageIndex) currentUrls.push('');
    currentUrls[imageIndex] = newUrl;

    const updates: Record<string, unknown> = {
      image_urls: currentUrls,
      updated_at: new Date(),
    };
    // Mirror to `visual_url` when the regenerated slot is currently the row's
    // primary visual (or when index 0 is regenerated and visual_url was unset).
    if (
      existing.visual_url === previousUrl ||
      (imageIndex === 0 && !existing.visual_url)
    ) {
      updates.visual_url = newUrl;
    }

    const { data, error } = await client
      .from('generated_content')
      .update(updates)
      .eq('id', contentId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  /**
   * Append a newly regenerated image URL (and its source prompt) so each regen
   * adds another pickable option instead of overwriting an existing slot.
   */
  async appendRegeneratedImage(
    contentId: string,
    newUrl: string,
    sourceImageIndex: number,
    sourcePrompt: string,
  ): Promise<{ content: GeneratedContent; newImageIndex: number } | null> {
    if (!Number.isInteger(sourceImageIndex) || sourceImageIndex < 0) {
      throw new Error(
        `appendRegeneratedImage: invalid sourceImageIndex=${sourceImageIndex}`,
      );
    }
    const client = this.supabaseService.getServiceClient();
    const { data: existing, error: fetchError } = await client
      .from('generated_content')
      .select('id,image_urls,performance_prediction')
      .eq('id', contentId)
      .is('deleted_at', null)
      .single();
    if (fetchError) throw fetchError;
    if (!existing) return null;

    const currentUrls: string[] = Array.isArray(existing.image_urls)
      ? [...existing.image_urls]
      : [];
    const newImageIndex = currentUrls.length;
    currentUrls.push(newUrl);

    const pp = (existing.performance_prediction || {}) as Record<string, unknown>;
    const customMeta = (pp.customTopicMeta || {}) as Record<string, unknown>;
    const prompts = Array.isArray(customMeta.imagePrompts)
      ? [...(customMeta.imagePrompts as string[])]
      : [];
    const promptToStore =
      sourcePrompt.trim() ||
      prompts[sourceImageIndex] ||
      prompts[prompts.length - 1] ||
      '';
    prompts.push(promptToStore);

    const performance_prediction = {
      ...pp,
      customTopicMeta: {
        ...customMeta,
        imagePrompts: prompts,
      },
    };

    const { data, error } = await client
      .from('generated_content')
      .update({
        image_urls: currentUrls,
        performance_prediction,
        updated_at: new Date(),
      })
      .eq('id', contentId)
      .select()
      .single();
    if (error) throw error;
    return { content: data, newImageIndex };
  }

  async markAsPublished(
    contentId: string,
    linkedinPostUrl: string,
  ): Promise<GeneratedContent> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .update({
        status: ContentStatus.PUBLISHED,
        linkedin_post_url: linkedinPostUrl,
        published_at: new Date(),
        updated_at: new Date(),
      })
      .eq('id', contentId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async softDelete(contentId: string): Promise<void> {
    const { error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .update({
        deleted_at: new Date(),
        updated_at: new Date(),
      })
      .eq('id', contentId);

    if (error) throw error;
  }

  async findPublishedWithinRange(
    userId: string,
    from: Date,
    to: Date,
  ): Promise<
    Array<{
      id: string;
      title: string;
      content: string;
      visual_type: string | null;
      published_at: string;
      linkedin_post_url: string | null;
    }>
  > {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('id,title,content,visual_type,published_at,linkedin_post_url')
      .eq('user_id', userId)
      .eq('publish_status', 'published')
      .not('published_at', 'is', null)
      .is('deleted_at', null)
      .gte('published_at', from.toISOString())
      .lt('published_at', to.toISOString())
      .order('published_at', { ascending: false });

    if (error) throw error;
    return (data || []) as Array<{
      id: string;
      title: string;
      content: string;
      visual_type: string | null;
      published_at: string;
      linkedin_post_url: string | null;
    }>;
  }
}
