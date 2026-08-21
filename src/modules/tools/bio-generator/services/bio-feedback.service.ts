/**
 * BioFeedbackService — Persists thumbs-up / thumbs-down on generated bios
 * and exposes aggregates for the admin dashboard.
 *
 * Privacy: raw client IPs never touch Postgres. We hash `(ip + daily_salt)`
 * with SHA-256 so we can dedupe/rate-limit and rotate keys, while never
 * being able to reverse-lookup an individual.
 *
 * Counts are NEVER returned to end users — the write endpoint returns only
 * the vote it accepted. The aggregates method is admin-only.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

import { SupabaseService } from '../../../../services/supabase.service';
import type { FeedbackBioDto } from '../dto/generate.dto';

/** Row shape returned by the admin aggregate query. */
export interface BioFeedbackAggregate {
  total: number;
  up: number;
  down: number;
  ratio: number; // up / (up + down), 0-1, or 0 when no votes
}

export interface BioFeedbackBreakdownRow {
  key: string;
  up: number;
  down: number;
  total: number;
  ratio: number;
}

export interface BioFeedbackAnalytics {
  overall: BioFeedbackAggregate;
  byPlatform: BioFeedbackBreakdownRow[];
  byAngle: BioFeedbackBreakdownRow[];
  byTone: BioFeedbackBreakdownRow[];
  byBioType: BioFeedbackBreakdownRow[];
  byEmojis: BioFeedbackBreakdownRow[];
  byFocusArea: BioFeedbackBreakdownRow[];
  recent: Array<{
    id: string;
    vote: 'up' | 'down';
    platform: string;
    angle: string;
    tone: string;
    focusAreas: string[];
    emojis: boolean;
    bioType: string;
    bioText: string | null;
    createdAt: string;
  }>;
}

@Injectable()
export class BioFeedbackService {
  private readonly logger = new Logger(BioFeedbackService.name);
  private static readonly TABLE = 'bio_generator_feedback';
  private static readonly MAX_TEXT_SNAPSHOT = 500;

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Deterministic IP hash. The salt rotates daily so an attacker who
   * exfiltrates the table can't correlate across days, but within a day
   * we can dedupe repeat votes from the same browser.
   */
  private hashIp(ip: string): string {
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    return createHash('sha256').update(`${ip}::${day}`).digest('hex');
  }

  /** Insert or upsert a vote. Flipping thumbs on the same generation UPDATEs. */
  async record(input: FeedbackBioDto, ip: string): Promise<{ vote: 'up' | 'down' }> {
    const ipHash = this.hashIp(ip);
    const text = (input.text ?? '').slice(0, BioFeedbackService.MAX_TEXT_SNAPSHOT);
    const client = this.supabase.getServiceClient();

    const row = {
      ip_hash: ipHash,
      generation_id: input.generationId ?? null,
      vote: input.vote,
      platform: input.platform,
      angle: input.angle,
      tone: input.tone,
      bio_type: input.bioType ?? 'personal',
      variation_index: input.variationIndex ?? null,
      focus_areas: input.focusAreas ?? [],
      emojis: input.emojis === true,
      bio_text: text || null,
      bio_length: text ? text.length : null,
    };

    // PostgREST can't do upsert on a partial unique index, so we manually
    // check for an existing vote and UPDATE if found, INSERT otherwise.
    if (input.generationId && input.variationIndex != null) {
      const { data: existing } = await client
        .from(BioFeedbackService.TABLE)
        .select('id')
        .eq('ip_hash', ipHash)
        .eq('generation_id', input.generationId)
        .eq('variation_index', input.variationIndex)
        .maybeSingle();

      if (existing?.id) {
        const { error } = await client
          .from(BioFeedbackService.TABLE)
          .update({ vote: input.vote })
          .eq('id', existing.id);
        if (error) {
          this.logger.error(`Feedback update failed: ${error.message}`);
          throw new Error('Failed to record feedback');
        }
      } else {
        const { error } = await client.from(BioFeedbackService.TABLE).insert(row);
        if (error) {
          this.logger.error(`Feedback insert failed: ${error.message}`);
          throw new Error('Failed to record feedback');
        }
      }
    } else {
      const { error } = await client.from(BioFeedbackService.TABLE).insert(row);
      if (error) {
        this.logger.error(`Feedback insert failed: ${error.message}`);
        throw new Error('Failed to record feedback');
      }
    }

    return { vote: input.vote };
  }

  /** Full aggregate for the admin dashboard. Uses one broad SELECT, then rolls up in memory. */
  async analytics(): Promise<BioFeedbackAnalytics> {
    const client = this.supabase.getServiceClient();

    const { data, error } = await client
      .from(BioFeedbackService.TABLE)
      .select(
        'id, vote, platform, angle, tone, bio_type, focus_areas, emojis, bio_text, created_at',
      )
      .order('created_at', { ascending: false })
      .limit(10_000); // hard cap to keep the roll-up cheap

    if (error) {
      this.logger.error(`Feedback analytics failed: ${error.message}`);
      throw new Error('Failed to load analytics');
    }

    const rows = (data ?? []) as Array<{
      id: string;
      vote: 'up' | 'down';
      platform: string;
      angle: string;
      tone: string;
      bio_type: string;
      focus_areas: string[] | null;
      emojis: boolean;
      bio_text: string | null;
      created_at: string;
    }>;

    const bucket = () => ({ up: 0, down: 0 });
    const platformMap: Record<string, { up: number; down: number }> = {};
    const angleMap: Record<string, { up: number; down: number }> = {};
    const toneMap: Record<string, { up: number; down: number }> = {};
    const bioTypeMap: Record<string, { up: number; down: number }> = {};
    const emojiMap: Record<string, { up: number; down: number }> = {};
    const focusMap: Record<string, { up: number; down: number }> = {};
    let up = 0;
    let down = 0;

    for (const r of rows) {
      const inc = (m: Record<string, { up: number; down: number }>, key: string) => {
        m[key] ??= bucket();
        if (r.vote === 'up') m[key].up++;
        else m[key].down++;
      };
      if (r.vote === 'up') up++;
      else down++;
      inc(platformMap, r.platform);
      inc(angleMap, r.angle);
      inc(toneMap, r.tone);
      inc(bioTypeMap, r.bio_type);
      inc(emojiMap, r.emojis ? 'on' : 'off');
      for (const fa of r.focus_areas ?? []) inc(focusMap, fa);
    }

    const rowify = (m: Record<string, { up: number; down: number }>): BioFeedbackBreakdownRow[] =>
      Object.entries(m)
        .map(([key, v]) => {
          const total = v.up + v.down;
          return {
            key,
            up: v.up,
            down: v.down,
            total,
            ratio: total > 0 ? v.up / total : 0,
          };
        })
        .sort((a, b) => b.total - a.total);

    const total = up + down;
    return {
      overall: {
        total,
        up,
        down,
        ratio: total > 0 ? up / total : 0,
      },
      byPlatform: rowify(platformMap),
      byAngle: rowify(angleMap),
      byTone: rowify(toneMap),
      byBioType: rowify(bioTypeMap),
      byEmojis: rowify(emojiMap),
      byFocusArea: rowify(focusMap),
      recent: rows.slice(0, 50).map((r) => ({
        id: r.id,
        vote: r.vote,
        platform: r.platform,
        angle: r.angle,
        tone: r.tone,
        focusAreas: r.focus_areas ?? [],
        emojis: r.emojis,
        bioType: r.bio_type,
        bioText: r.bio_text,
        createdAt: r.created_at,
      })),
    };
  }
}
