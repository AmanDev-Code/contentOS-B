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
        status: ContentStatus.READY,
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
    // For now, return published content as "scheduled" since we don't have scheduled_for field yet
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'published')
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
      .eq('status', 'published')
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

  async updateContent(
    contentId: string,
    updates: {
      title?: string;
      content?: string;
      hashtags?: string[];
    },
  ): Promise<GeneratedContent> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generated_content')
      .update({
        ...updates,
        updated_at: new Date(),
      })
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
}
