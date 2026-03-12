import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../services/supabase.service';
import { GenerationJob, JobStatus } from '../common/types';

@Injectable()
export class GenerationJobRepository {
  constructor(private supabaseService: SupabaseService) {}

  private mapDatabaseToInterface(data: any): GenerationJob {
    return {
      id: data.id,
      userId: data.user_id,
      contentId: data.content_id,
      status: data.status,
      progress: data.progress,
      currentStage: data.current_stage,
      webhookUrl: data.webhook_url,
      response: data.response,
      error: data.error,
      retryCount: data.retry_count,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async create(
    userId: string,
    webhookUrl?: string,
  ): Promise<GenerationJob> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generation_jobs')
      .insert({
        user_id: userId,
        status: JobStatus.GENERATING,
        progress: 0,
        webhook_url: webhookUrl,
        retry_count: 0,
      })
      .select()
      .single();

    if (error) throw error;
    
    return this.mapDatabaseToInterface(data);
  }

  async findById(jobId: string): Promise<GenerationJob | null> {
    console.log(`🔍 Fetching job ${jobId} from Supabase...`);
    
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generation_jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle(); // Use maybeSingle to avoid errors if not found

    if (error) {
      console.error(`❌ Error fetching job ${jobId}:`, error);
      return null;
    }
    
    if (data) {
      console.log(`✅ Found job ${jobId}: status=${data.status}, progress=${data.progress}`);
    } else {
      console.log(`⚠️ Job ${jobId} not found in database`);
    }
    
    return data ? this.mapDatabaseToInterface(data) : null;
  }

  async findByUserId(userId: string): Promise<GenerationJob[]> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generation_jobs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    
    return (data || []).map(item => this.mapDatabaseToInterface(item));
  }

  async updateStatus(
    jobId: string,
    status: JobStatus,
    progress?: number,
    currentStage?: string,
  ): Promise<GenerationJob> {
    const updateData: any = {
      status,
      updated_at: new Date(),
    };

    if (progress !== undefined) updateData.progress = progress;
    if (currentStage) updateData.current_stage = currentStage;

    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generation_jobs')
      .update(updateData)
      .eq('id', jobId)
      .select()
      .single();

    if (error) throw error;
    return this.mapDatabaseToInterface(data);
  }

  async updateWithContent(
    jobId: string,
    contentId: string,
    status: JobStatus,
    response?: Record<string, any>,
  ): Promise<GenerationJob> {
    console.log(`📝 Updating job ${jobId} with content ${contentId}, status: ${status}`);
    
    const updatePayload = {
      content_id: contentId,
      status,
      progress: 100,
      response,
      updated_at: new Date().toISOString(),
    };
    
    console.log('Update payload:', JSON.stringify(updatePayload, null, 2));
    
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generation_jobs')
      .update(updatePayload)
      .eq('id', jobId)
      .select()
      .single();

    if (error) {
      console.error('❌ Supabase update error:', error);
      throw error;
    }
    
    console.log('✅ Supabase update successful, returned data:', JSON.stringify(data, null, 2));
    
    return this.mapDatabaseToInterface(data);
  }

  async updateError(
    jobId: string,
    error: string,
    retryCount: number,
  ): Promise<GenerationJob> {
    const { data, error: updateError } = await this.supabaseService
      .getServiceClient()
      .from('generation_jobs')
      .update({
        status: JobStatus.FAILED,
        error,
        retry_count: retryCount,
        updated_at: new Date(),
      })
      .eq('id', jobId)
      .select()
      .single();

    if (updateError) throw updateError;
    return data;
  }
}
