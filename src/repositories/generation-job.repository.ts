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

  async create(userId: string, webhookUrl?: string): Promise<GenerationJob> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generation_jobs')
      .insert({
        user_id: userId,
        status: JobStatus.GENERATING,
        progress: 5,
        current_stage: 'initializing',
        webhook_url: webhookUrl,
        retry_count: 0,
      })
      .select()
      .single();

    if (error) throw error;

    return this.mapDatabaseToInterface(data);
  }

  async findById(jobId: string): Promise<GenerationJob | null> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generation_jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle(); // Use maybeSingle to avoid errors if not found

    if (error) {
      console.error(`Error fetching job ${jobId}:`, error);
      return null;
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

    return (data || []).map((item) => this.mapDatabaseToInterface(item));
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
    console.log(
      `📝 Updating job ${jobId} with content ${contentId}, status: ${status}`,
    );

    const updatePayload = {
      content_id: contentId,
      status,
      progress: 100,
      current_stage: 'done',
      response,
      // Clear any prior `error` (e.g. from an earlier sweeper pass that lost
      // the race with this completion) so the row's final state is internally
      // consistent: status=ready ⇒ error=null.
      error: null as string | null,
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

    console.log(
      '✅ Supabase update successful, returned data:',
      JSON.stringify(data, null, 2),
    );

    return this.mapDatabaseToInterface(data);
  }

  /** Persist queue payload on the job row so failed jobs can be retried. */
  async stashJobPayload(
    jobId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const job = await this.findById(jobId);
    const existing =
      job?.response && typeof job.response === 'object' && !Array.isArray(job.response)
        ? (job.response as Record<string, unknown>)
        : {};
    const { error } = await this.supabaseService
      .getServiceClient()
      .from('generation_jobs')
      .update({
        response: { ...existing, ...patch },
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
    if (error) throw error;
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

  /**
   * Atomically mark a job as failed ONLY if it is still in a non-terminal
   * status. Returns `null` when the job has already been finalized (e.g. the
   * worker wrote `ready` between the sweeper's SELECT and UPDATE), so callers
   * can skip side-effects like progress logging or retry plumbing.
   *
   * This is the safe path for stale-job sweepers; never call it from the
   * worker's own failure handler (which legitimately needs to overwrite any
   * status the row currently holds).
   */
  async updateErrorIfStillActive(
    jobId: string,
    errorMsg: string,
    retryCount: number,
  ): Promise<GenerationJob | null> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generation_jobs')
      .update({
        status: JobStatus.FAILED,
        error: errorMsg,
        retry_count: retryCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .in('status', [
        JobStatus.PENDING,
        JobStatus.GENERATING,
        JobStatus.MEDIA_GENERATING,
        JobStatus.PUBLISHING,
      ])
      .select()
      .maybeSingle();

    if (error) throw error;
    return data ? this.mapDatabaseToInterface(data) : null;
  }

  /**
   * Find active jobs older than a threshold.
   * Used for stale job cleanup to prevent queue jams.
   */
  async findStaleActiveJobs(olderThanMs: number): Promise<GenerationJob[]> {
    const threshold = new Date(Date.now() - olderThanMs).toISOString();

    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('generation_jobs')
      .select('*')
      .in('status', [
        JobStatus.GENERATING,
        'media_generating',
        'publishing',
      ])
      .lt('updated_at', threshold)
      .order('updated_at', { ascending: true })
      .limit(50);

    if (error) {
      console.error('Error finding stale jobs:', error);
      return [];
    }

    return (data || []).map((item) => this.mapDatabaseToInterface(item));
  }
}
