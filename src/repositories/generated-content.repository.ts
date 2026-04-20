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
      hashtags?: string[];
      aiReasoning?: string;
      performancePrediction?: Record<string, any>;
      suggestedImprovements?: string[];
      status?: ContentStatus;
    },
  ): Promise<GeneratedContent> {
    const { data: result, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .insert({
        user_id: userId,
        title,
        content,
        job_id: data.jobId, // Re-enabled after migration
        category_id: data.categoryId,
        ai_score: data.aiScore,
        status: data.status || ContentStatus.READY,
        visual_type: data.visualType || VisualType.IMAGE,
        visual_url: data.visualUrl,
        carousel_urls: data.carouselUrls,
        hashtags: data.hashtags,
        ai_reasoning: data.aiReasoning,
        performance_prediction: data.performancePrediction,
        suggested_improvements: data.suggestedImprovements,
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
  ): Promise<GeneratedContent[]> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return data || [];
  }

  async countByUserId(userId: string): Promise<number> {
    const { count, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('deleted_at', null);

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
