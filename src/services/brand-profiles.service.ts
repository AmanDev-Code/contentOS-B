import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from './supabase.service';

/**
 * Brand Kit MVP (Sprint 1.5, Stage A).
 *
 * CRUD over `public.brand_profiles`. This is the data layer behind the
 * "your AI posts in YOUR voice" feature. Stage A only stores/serves the
 * brand kit; the AI prompt injection that consumes `tone` / `voice_examples`
 * / `do_use` / `do_not_use` lands in Stage B (Bifrost-dependent) and is NOT
 * part of this file.
 *
 * All queries use the service client but are ALWAYS scoped by `user_id`, so a
 * user can only ever touch their own rows (matches the row-level-security
 * policies on the table).
 */

export interface BrandAsset {
  url: string;
  label?: string;
  kind?: string;
}

export interface BrandProfileInput {
  name: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  accentColor?: string | null;
  tone?: string | null;
  targetAudience?: string | null;
  voiceExamples?: string[];
  doUse?: string[];
  doNotUse?: string[];
  additionalInformation?: string | null;
  assets?: BrandAsset[];
  metadata?: Record<string, unknown>;
}

export interface BrandProfile {
  id: string;
  user_id: string;
  name: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  tone: string | null;
  target_audience: string | null;
  voice_examples: string[];
  do_use: string[];
  do_not_use: string[];
  additional_information: string | null;
  assets: BrandAsset[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const MAX_NAME = 255;
const MAX_VOICE_EXAMPLES = 5;
const MAX_VOCAB_TERMS = 50;
const MAX_TONE = 2000;
const MAX_AUDIENCE = 2000;
const MAX_EXAMPLE_LEN = 5000;
const MAX_TERM_LEN = 120;
const MAX_ADDITIONAL_INFO = 10000;
const MAX_ASSETS = 20;
const MAX_ASSET_URL = 2048;
const MAX_ASSET_LABEL = 200;

@Injectable()
export class BrandProfilesService {
  private readonly logger = new Logger(BrandProfilesService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * Returns the user's primary (first-created) brand profile, or null if none exists.
   * Used by AI generation to inject brand voice into the system prompt.
   */
  async getPrimaryForUser(userId: string): Promise<BrandProfile | null> {
    const profiles = await this.list(userId);
    return profiles.length > 0 ? profiles[0] : null;
  }

  async list(userId: string): Promise<BrandProfile[]> {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('brand_profiles')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) {
      this.logger.error(`list brand_profiles failed: ${error.message}`);
      throw new BadRequestException('Failed to load brand profiles.');
    }
    return (data ?? []) as BrandProfile[];
  }

  async getById(userId: string, id: string): Promise<BrandProfile> {
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('brand_profiles')
      .select('*')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      this.logger.error(`getById brand_profiles failed: ${error.message}`);
      throw new BadRequestException('Failed to load brand profile.');
    }
    if (!data) {
      throw new NotFoundException('Brand profile not found.');
    }
    return data as BrandProfile;
  }

  async create(
    userId: string,
    input: BrandProfileInput,
  ): Promise<BrandProfile> {
    const row = this.toRow(userId, input);
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('brand_profiles')
      .insert(row)
      .select('*')
      .single();
    if (error) {
      this.logger.error(`create brand_profiles failed: ${error.message}`);
      throw new BadRequestException(
        'Failed to save brand profile. Please check the colors and try again.',
      );
    }
    return data as BrandProfile;
  }

  async update(
    userId: string,
    id: string,
    input: BrandProfileInput,
  ): Promise<BrandProfile> {
    // Ensure the row exists and belongs to the user before updating.
    await this.getById(userId, id);
    const row = this.toRow(userId, input);
    // user_id is immutable on update.
    delete (row as { user_id?: string }).user_id;
    const client = this.supabaseService.getServiceClient();
    const { data, error } = await client
      .from('brand_profiles')
      .update(row)
      .eq('user_id', userId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) {
      this.logger.error(`update brand_profiles failed: ${error.message}`);
      throw new BadRequestException(
        'Failed to update brand profile. Please check the colors and try again.',
      );
    }
    return data as BrandProfile;
  }

  /**
   * Patch ONLY the metadata JSONB column for a user's brand profile, leaving all
   * other fields (logo, colors, assets, voice, etc.) untouched. Used to persist
   * derived data like the cached vision analysis without risking a full-row
   * overwrite. Scoped to the owning user — never touches another user's row.
   */
  async updateMetadata(
    userId: string,
    id: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const client = this.supabaseService.getServiceClient();
    const { error } = await client
      .from('brand_profiles')
      .update({ metadata })
      .eq('user_id', userId)
      .eq('id', id);
    if (error) {
      this.logger.warn(
        `updateMetadata brand_profiles failed: ${error.message}`,
      );
    }
  }

  async remove(userId: string, id: string): Promise<{ success: boolean }> {
    await this.getById(userId, id);
    const client = this.supabaseService.getServiceClient();
    const { error } = await client
      .from('brand_profiles')
      .delete()
      .eq('user_id', userId)
      .eq('id', id);
    if (error) {
      this.logger.error(`delete brand_profiles failed: ${error.message}`);
      throw new BadRequestException('Failed to delete brand profile.');
    }
    return { success: true };
  }

  /**
   * Validate + normalize the public input into a DB row. Mirrors the table's
   * CHECK constraints (hex colors) so we fail with a friendly message before
   * hitting Postgres, and caps array/string sizes to keep prompts bounded.
   */
  private toRow(
    userId: string,
    input: BrandProfileInput,
  ): Record<string, unknown> {
    const name = (input.name ?? '').trim();
    if (!name) {
      throw new BadRequestException('Brand name is required.');
    }
    if (name.length > MAX_NAME) {
      throw new BadRequestException('Brand name is too long.');
    }

    return {
      user_id: userId,
      name,
      logo_url: this.cleanString(input.logoUrl) ?? null,
      primary_color: this.cleanColor(input.primaryColor, 'primary'),
      secondary_color: this.cleanColor(input.secondaryColor, 'secondary'),
      accent_color: this.cleanColor(input.accentColor, 'accent'),
      tone: this.cleanString(input.tone, MAX_TONE) ?? null,
      target_audience:
        this.cleanString(input.targetAudience, MAX_AUDIENCE) ?? null,
      voice_examples: this.cleanArray(
        input.voiceExamples,
        MAX_VOICE_EXAMPLES,
        MAX_EXAMPLE_LEN,
      ),
      do_use: this.cleanArray(input.doUse, MAX_VOCAB_TERMS, MAX_TERM_LEN),
      do_not_use: this.cleanArray(
        input.doNotUse,
        MAX_VOCAB_TERMS,
        MAX_TERM_LEN,
      ),
      additional_information:
        this.cleanString(input.additionalInformation, MAX_ADDITIONAL_INFO) ??
        null,
      assets: this.cleanAssets(input.assets),
      metadata:
        input.metadata && typeof input.metadata === 'object'
          ? input.metadata
          : {},
    };
  }

  /**
   * Normalize the brand asset gallery: keep only entries with a usable URL,
   * trim labels/kinds, and cap the list size. The 10MB-per-file limit is
   * enforced at upload time on the client + /media/upload pipeline; here we
   * only persist the resulting URLs.
   */
  private cleanAssets(value: BrandAsset[] | undefined): BrandAsset[] {
    if (!Array.isArray(value)) return [];
    const out: BrandAsset[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const url = this.cleanString(item.url, MAX_ASSET_URL);
      if (!url) continue;
      const asset: BrandAsset = { url };
      const label = this.cleanString(item.label, MAX_ASSET_LABEL);
      if (label) asset.label = label;
      const kind = this.cleanString(item.kind, 40);
      if (kind) asset.kind = kind;
      out.push(asset);
      if (out.length >= MAX_ASSETS) break;
    }
    return out;
  }

  private cleanString(
    value: string | null | undefined,
    maxLen?: number,
  ): string | null {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    if (maxLen && trimmed.length > maxLen) {
      return trimmed.slice(0, maxLen);
    }
    return trimmed;
  }

  private cleanColor(
    value: string | null | undefined,
    label: string,
  ): string | null {
    const cleaned = this.cleanString(value);
    if (!cleaned) return null;
    if (!HEX_COLOR.test(cleaned)) {
      throw new BadRequestException(
        `The ${label} color must be a hex value like #1A2B3C.`,
      );
    }
    return cleaned;
  }

  private cleanArray(
    value: string[] | undefined,
    maxItems: number,
    maxLen: number,
  ): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => v.length > 0)
      .map((v) => (v.length > maxLen ? v.slice(0, maxLen) : v))
      .slice(0, maxItems);
  }
}
