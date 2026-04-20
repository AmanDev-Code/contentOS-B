import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { MinioService } from './minio.service';
import { randomBytes } from 'crypto';

export type JobStatus = 'draft' | 'scheduled' | 'published' | 'closed';
export type QuestionType =
  | 'short_text'
  | 'long_text'
  | 'yes_no'
  | 'single_choice'
  | 'multi_choice'
  | 'number'
  | 'url'
  | 'file';

export interface JobQuestionInput {
  id?: string;
  sort_order?: number;
  prompt: string;
  question_type: QuestionType;
  required?: boolean;
  options?: string[];
  max_file_mb?: number;
  allowed_file_exts?: string[];
}

export interface CreateJobInput {
  title: string;
  slug?: string;
  category?: string;
  location?: string;
  employment_type?: string;
  remote_option?: string;
  salary_band?: string;
  summary?: string;
  description?: string;
  responsibilities?: string;
  requirements?: string;
  nice_to_have?: string;
  benefits?: string;
  team_overview?: string;
  equity_notes?: string;
  visa_sponsorship?: boolean;
  application_deadline?: string | null;
  status?: JobStatus;
  scheduled_publish_at?: string | null;
  display_order?: number;
  questions?: JobQuestionInput[];
}

const APPLY_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const APPLY_MAX_SINGLE_BYTES = 8 * 1024 * 1024;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72);
}

function randomSlugSuffix(): string {
  return randomBytes(3).toString('hex');
}

@Injectable()
export class CareersService {
  private readonly logger = new Logger(CareersService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly minioService: MinioService,
  ) {}

  private getBucket(): string {
    return (this.minioService as any)['bucketName'] as string;
  }

  /** Promote scheduled listings whose time has passed (no separate worker). */
  async promoteScheduledJobs(): Promise<void> {
    const now = new Date().toISOString();
    const client = this.supabaseService.getServiceClient();
    const { error } = await client
      .from('job_postings')
      .update({
        status: 'published',
        published_at: now,
        updated_at: now,
      })
      .eq('status', 'scheduled')
      .lte('scheduled_publish_at', now);
    if (error) {
      this.logger.warn(`promoteScheduledJobs: ${error.message}`);
    }
  }

  async listPublicJobs(category?: string) {
    await this.promoteScheduledJobs();
    const client = this.supabaseService.getServiceClient();
    let q = client
      .from('job_postings')
      .select(
        'id, slug, title, category, location, employment_type, remote_option, salary_band, summary, published_at, application_deadline, visa_sponsorship, display_order',
      )
      .eq('status', 'published')
      .order('display_order', { ascending: false })
      .order('published_at', { ascending: false, nullsFirst: false });
    if (category && category !== 'all') {
      q = q.eq('category', category);
    }
    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    return data || [];
  }

  async listCategoriesPublic(): Promise<string[]> {
    await this.promoteScheduledJobs();
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('job_postings')
      .select('category')
      .eq('status', 'published');
    if (error) throw new BadRequestException(error.message);
    const set = new Set<string>();
    for (const row of data || []) {
      if (row?.category) set.add(row.category);
    }
    return Array.from(set).sort();
  }

  async getPublicJobBySlug(slug: string) {
    await this.promoteScheduledJobs();
    const client = this.supabaseService.getServiceClient();
    const { data: job, error } = await client
      .from('job_postings')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!job || job.status !== 'published') {
      throw new NotFoundException('Job not found');
    }
    const { data: questions } = await client
      .from('job_questions')
      .select(
        'id, sort_order, prompt, question_type, required, options, max_file_mb, allowed_file_exts',
      )
      .eq('job_id', job.id)
      .order('sort_order', { ascending: true });
    return { job, questions: questions || [] };
  }

  async applyToJob(
    slug: string,
    body: {
      full_name: string;
      email: string;
      phone?: string;
      location?: string;
      linkedin_url?: string;
      portfolio_url?: string;
      cover_letter?: string;
      answers?: Record<string, string | string[] | number | boolean>;
      attachments?: Array<{
        purpose: string;
        filename: string;
        mime_type: string;
        data_base64: string;
      }>;
    },
  ) {
    const { job, questions } = await this.getPublicJobBySlug(slug);
    if (job.application_deadline) {
      const d = new Date(job.application_deadline);
      if (!Number.isNaN(d.getTime()) && d.getTime() < Date.now()) {
        throw new BadRequestException('Applications are closed for this role');
      }
    }

    const answers = body.answers || {};
    let totalBytes = 0;

    for (const q of questions as any[]) {
      if (!q.required) continue;
      const v = answers[q.id];
      if (q.question_type === 'file') {
        const hasFile = (body.attachments || []).some(
          (a) => a.purpose === `question:${q.id}`,
        );
        if (!hasFile) {
          throw new BadRequestException(`Missing required file: ${q.prompt}`);
        }
        continue;
      }
      const empty =
        v === undefined ||
        v === null ||
        (typeof v === 'string' && v.trim() === '') ||
        (Array.isArray(v) && v.length === 0);
      if (empty) {
        throw new BadRequestException(`Missing required answer: ${q.prompt}`);
      }
    }

    const client = this.supabaseService.getServiceClient();
    const { data: appRow, error: appErr } = await client
      .from('job_applications')
      .insert({
        job_id: job.id,
        full_name: body.full_name.trim(),
        email: body.email.trim().toLowerCase(),
        phone: body.phone?.trim() || null,
        location: body.location?.trim() || null,
        linkedin_url: body.linkedin_url?.trim() || null,
        portfolio_url: body.portfolio_url?.trim() || null,
        cover_letter: body.cover_letter?.trim() || null,
        answers,
      })
      .select('id')
      .single();
    if (appErr || !appRow) {
      throw new BadRequestException(appErr?.message || 'Failed to save application');
    }
    const applicationId = appRow.id as string;

    for (const att of body.attachments || []) {
      const raw = att.data_base64?.includes(',')
        ? att.data_base64.split(',')[1]
        : att.data_base64;
      if (!raw) continue;
      const buf = Buffer.from(raw, 'base64');
      if (buf.length > APPLY_MAX_SINGLE_BYTES) {
        throw new BadRequestException(`File too large: ${att.filename}`);
      }
      totalBytes += buf.length;
      if (totalBytes > APPLY_MAX_TOTAL_BYTES) {
        throw new BadRequestException('Total attachment size exceeds limit');
      }
      const safeName = (att.filename || 'upload')
        .replace(/[^\w.\-]/g, '_')
        .slice(0, 120);
      const minioPath = `career-applications/${applicationId}/${Date.now()}-${safeName}`;
      const mime = att.mime_type || 'application/octet-stream';
      await this.minioService.uploadFile(this.getBucket(), minioPath, buf, mime);
      const publicUrl = await this.minioService.getPublicUrl(
        this.getBucket(),
        minioPath,
      );
      const { error: fErr } = await client.from('job_application_files').insert({
        application_id: applicationId,
        purpose: att.purpose.slice(0, 120),
        original_name: att.filename.slice(0, 240),
        mime_type: mime,
        size_bytes: buf.length,
        minio_path: minioPath,
        public_url: publicUrl,
      });
      if (fErr) {
        this.logger.error(`job_application_files insert: ${fErr.message}`);
        throw new BadRequestException('Failed to store attachment');
      }
    }

    return { success: true, applicationId };
  }

  // --- Admin ---

  async listJobsAdmin() {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('job_postings')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    return data || [];
  }

  async getJobAdmin(id: string) {
    const client = this.supabaseService.getServiceClient();
    const { data: job, error } = await client
      .from('job_postings')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!job) throw new NotFoundException('Job not found');
    const { data: questions } = await client
      .from('job_questions')
      .select('*')
      .eq('job_id', id)
      .order('sort_order', { ascending: true });
    return { job, questions: questions || [] };
  }

  async createJob(userId: string, input: CreateJobInput) {
    const baseSlug = input.slug?.trim() || slugify(input.title) || 'role';
    let slug = baseSlug;
    const client = this.supabaseService.getServiceClient();
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = {
        slug,
        title: input.title.trim(),
        category: (input.category || 'General').trim(),
        location: input.location?.trim() || null,
        employment_type: input.employment_type || 'full_time',
        remote_option: input.remote_option || 'hybrid',
        salary_band: input.salary_band?.trim() || null,
        summary: input.summary?.trim() || null,
        description: input.description?.trim() || '',
        responsibilities: input.responsibilities?.trim() || null,
        requirements: input.requirements?.trim() || null,
        nice_to_have: input.nice_to_have?.trim() || null,
        benefits: input.benefits?.trim() || null,
        team_overview: input.team_overview?.trim() || null,
        equity_notes: input.equity_notes?.trim() || null,
        visa_sponsorship: Boolean(input.visa_sponsorship),
        application_deadline: input.application_deadline || null,
        status: (input.status || 'draft') as JobStatus,
        scheduled_publish_at: input.scheduled_publish_at || null,
        display_order: input.display_order ?? 0,
        created_by: userId,
        published_at:
          input.status === 'published' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await client
        .from('job_postings')
        .insert(row)
        .select('id')
        .single();
      if (!error && data) {
        if (input.questions?.length) {
          await this.replaceQuestions(data.id, input.questions);
        }
        return this.getJobAdmin(data.id);
      }
      if (error?.code === '23505') {
        slug = `${baseSlug}-${randomSlugSuffix()}`;
        continue;
      }
      throw new BadRequestException(error?.message || 'Failed to create job');
    }
    throw new BadRequestException('Could not allocate unique slug');
  }

  async updateJob(id: string, input: Partial<CreateJobInput>) {
    const client = this.supabaseService.getServiceClient();
    const { data: existing, error: exErr } = await client
      .from('job_postings')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (exErr || !existing) throw new NotFoundException('Job not found');

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    const assign = <K extends string>(k: K, v: unknown) => {
      if (v !== undefined) patch[k] = v;
    };
    if (input.title !== undefined) assign('title', input.title.trim());
    if (input.slug !== undefined) assign('slug', input.slug.trim());
    if (input.category !== undefined) assign('category', input.category.trim());
    if (input.location !== undefined) assign('location', input.location?.trim() || null);
    if (input.employment_type !== undefined)
      assign('employment_type', input.employment_type);
    if (input.remote_option !== undefined)
      assign('remote_option', input.remote_option);
    if (input.salary_band !== undefined)
      assign('salary_band', input.salary_band?.trim() || null);
    if (input.summary !== undefined)
      assign('summary', input.summary?.trim() || null);
    if (input.description !== undefined)
      assign('description', input.description?.trim() || '');
    if (input.responsibilities !== undefined)
      assign('responsibilities', input.responsibilities?.trim() || null);
    if (input.requirements !== undefined)
      assign('requirements', input.requirements?.trim() || null);
    if (input.nice_to_have !== undefined)
      assign('nice_to_have', input.nice_to_have?.trim() || null);
    if (input.benefits !== undefined)
      assign('benefits', input.benefits?.trim() || null);
    if (input.team_overview !== undefined)
      assign('team_overview', input.team_overview?.trim() || null);
    if (input.equity_notes !== undefined)
      assign('equity_notes', input.equity_notes?.trim() || null);
    if (input.visa_sponsorship !== undefined)
      assign('visa_sponsorship', Boolean(input.visa_sponsorship));
    if (input.application_deadline !== undefined)
      assign('application_deadline', input.application_deadline || null);
    if (input.display_order !== undefined)
      assign('display_order', input.display_order);

    if (input.status !== undefined) {
      assign('status', input.status);
      if (input.status === 'published') {
        assign('published_at', new Date().toISOString());
      }
      if (input.status === 'draft' || input.status === 'scheduled') {
        assign('published_at', null);
      }
    }
    if (input.scheduled_publish_at !== undefined) {
      assign('scheduled_publish_at', input.scheduled_publish_at || null);
    }

    const { error } = await client.from('job_postings').update(patch).eq('id', id);
    if (error) throw new BadRequestException(error.message);

    if (input.questions) {
      await this.replaceQuestions(id, input.questions);
    }
    return this.getJobAdmin(id);
  }

  async replaceQuestions(jobId: string, questions: JobQuestionInput[]) {
    const client = this.supabaseService.getServiceClient();
    await client.from('job_questions').delete().eq('job_id', jobId);
    if (!questions.length) return;
    const rows = questions.map((q, i) => ({
      job_id: jobId,
      sort_order: q.sort_order ?? i,
      prompt: q.prompt.trim(),
      question_type: q.question_type,
      required: q.required !== false,
      options: q.options || [],
      max_file_mb: q.max_file_mb ?? 10,
      allowed_file_exts: q.allowed_file_exts?.length
        ? q.allowed_file_exts.map((e) => e.replace(/^\./, '').toLowerCase())
        : ['pdf', 'doc', 'docx'],
    }));
    const { error } = await client.from('job_questions').insert(rows);
    if (error) throw new BadRequestException(error.message);
  }

  async deleteJob(id: string) {
    const client = this.supabaseService.getServiceClient();
    const { error } = await client.from('job_postings').delete().eq('id', id);
    if (error) throw new BadRequestException(error.message);
    return { success: true };
  }

  async listApplications(jobId: string) {
    const client = this.supabaseService.getServiceClient();
    const [{ data: qrows, error: qErr }, { data: apps, error }] = await Promise.all([
      client
        .from('job_questions')
        .select('id, sort_order, prompt, question_type, required, options')
        .eq('job_id', jobId)
        .order('sort_order', { ascending: true }),
      client
        .from('job_applications')
        .select(
          'id, full_name, email, phone, location, linkedin_url, portfolio_url, cover_letter, answers, status, created_at',
        )
        .eq('job_id', jobId)
        .order('created_at', { ascending: false }),
    ]);
    if (qErr) throw new BadRequestException(qErr.message);
    if (error) throw new BadRequestException(error.message);
    const questions = qrows || [];
    const list = apps || [];
    if (list.length === 0) {
      return { applications: [], questions };
    }
    const ids = list.map((a: { id: string }) => a.id);
    const { data: files } = await client
      .from('job_application_files')
      .select(
        'id, application_id, purpose, original_name, mime_type, size_bytes, public_url',
      )
      .in('application_id', ids);
    const byApp = new Map<string, any[]>();
    for (const f of files || []) {
      const aid = (f as any).application_id as string;
      if (!byApp.has(aid)) byApp.set(aid, []);
      byApp.get(aid)!.push(f);
    }
    return {
      applications: list.map((a: any) => ({
        ...a,
        job_application_files: byApp.get(a.id) || [],
      })),
      questions,
    };
  }
}
