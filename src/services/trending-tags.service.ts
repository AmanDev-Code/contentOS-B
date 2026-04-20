import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

export interface AdminTagRecord {
  id: string;
  tag: string;
  is_active: boolean;
  priority: number;
  last_fetched_at: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class TrendingTagsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  normalizeTag(rawTag: string): string {
    const normalized = rawTag.trim().toLowerCase().replace(/^#+/, '');
    if (!normalized) {
      throw new BadRequestException('Tag is required');
    }
    if (normalized.length > 50) {
      throw new BadRequestException('Tag must be 50 characters or fewer');
    }
    // Keep strict but practical: lowercase letters, numbers, hyphen, underscore.
    if (!/^[a-z0-9_-]+$/.test(normalized)) {
      throw new BadRequestException(
        'Tag must be lowercase alphanumeric and may include - or _',
      );
    }
    return normalized;
  }

  async listTags(): Promise<AdminTagRecord[]> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('admin_tags')
      .select('*')
      .order('priority', { ascending: false })
      .order('tag', { ascending: true });

    if (error) {
      throw new BadRequestException(`Failed to list tags: ${error.message}`);
    }

    return data || [];
  }

  async getActiveTags(): Promise<AdminTagRecord[]> {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('admin_tags')
      .select('*')
      .eq('is_active', true)
      .order('priority', { ascending: false })
      .order('updated_at', { ascending: false });

    if (error) {
      throw new BadRequestException(
        `Failed to load active tags: ${error.message}`,
      );
    }

    return data || [];
  }

  async addTag(tag: string, priority = 0): Promise<AdminTagRecord> {
    const normalized = this.normalizeTag(tag);

    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('admin_tags')
      .insert({
        tag: normalized,
        is_active: true,
        priority,
      })
      .select('*')
      .single();

    if (error) {
      throw new BadRequestException(`Failed to add tag: ${error.message}`);
    }

    return data;
  }

  async updateTag(
    id: string,
    updates: { isActive?: boolean; priority?: number },
  ): Promise<AdminTagRecord> {
    const payload: Record<string, unknown> = {};
    if (typeof updates.isActive === 'boolean')
      payload.is_active = updates.isActive;
    if (typeof updates.priority === 'number')
      payload.priority = updates.priority;
    payload.updated_at = new Date().toISOString();

    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('admin_tags')
      .update(payload)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      throw new BadRequestException(`Failed to update tag: ${error.message}`);
    }

    return data;
  }

  async touchFetched(id: string): Promise<void> {
    const { error } = await this.supabaseService
      .getServiceClient()
      .from('admin_tags')
      .update({
        last_fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      throw new BadRequestException(
        `Failed to update lastFetchedAt: ${error.message}`,
      );
    }
  }

  async deleteTag(id: string): Promise<void> {
    const { error } = await this.supabaseService
      .getServiceClient()
      .from('admin_tags')
      .delete()
      .eq('id', id);

    if (error) {
      throw new BadRequestException(`Failed to delete tag: ${error.message}`);
    }
  }
}
