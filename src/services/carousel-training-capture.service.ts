import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { SupabaseService } from './supabase.service';

/**
 * Carousel / custom-topic capture for internal evaluation datasets.
 *
 * Privacy gate (per-user explicit consent only):
 *   - The user opt-in flag (`trainingDataCaptureOptIn`) is the primary gate. When the
 *     user ticks the "opt in to quality dataset capture" checkbox, we are explicitly
 *     authorized to record sanitized prompt + output rows for this generation.
 *   - The runtime env `TRAINING_CAPTURE_ENABLED` is now a hard kill-switch. Setting it
 *     to `"false"` disables ALL writes regardless of opt-in (used for outage drills /
 *     compliance freezes). When unset OR `"true"`, user opt-in alone is sufficient.
 *
 * We never silently record all SaaS inputs — only opted-in ones. Hashed user/job ids
 * isolate the dataset rows from the live tables.
 */

export type CarouselCaptureEventType =
  | 'custom_topic_carousel_started'
  | 'carousel_plan_ready'
  | 'carousel_text_ready'
  | 'carousel_quality_retry'
  | 'carousel_render_complete';

export interface CarouselCapturePayloadBase {
  topicPreview: string;
  platform?: string;
  slideCount?: number;
  contentType?: string;
  carouselVisualStyle?: string;
  carouselNoteDensity?: string | null;
  carouselSubjectMode?: string | null;
  noteDensity?: string;
  programmingModeEffective?: boolean;
  /** Non-sensitive summary */
  carouselPlanSummary?: Record<string, unknown>;
  slideTitleSample?: string[];
  slideTitlesSample?: string[];
  slideTotal?: number;
  outputMeta?: Record<string, unknown>;
}

/** Strip obvious PII patterns; shorten long strings for safer storage */
export function redactCarouselCapturePayload(
  payload: Record<string, unknown>,
  consentOptIn: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  if (!consentOptIn) {
    delete out.carouselPlanDetailed;
    delete out.rawSlidesDigest;
    if (typeof out.topicPreview === 'string' && out.topicPreview.length > 180) {
      out.topicPreview = `${out.topicPreview.slice(0, 177)}...`;
    }
  }
  if (typeof out.topicPreview === 'string') {
    out.topicPreview = out.topicPreview.replace(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      '[redacted-email]',
    );
  }
  return out;
}

@Injectable()
export class CarouselTrainingCaptureService {
  private readonly logger = new Logger(CarouselTrainingCaptureService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
  ) {}

  /**
   * Hard kill-switch. Returns false ONLY when env is explicitly set to a falsy literal
   * (`"false"`, `"0"`, `"no"`, `"off"`). Default (unset) and any truthy value allow
   * writes when the user opted in. Lets ops disable the pipeline without rebuilding.
   */
  private trainingCaptureKillSwitchAllowsWrite(): boolean {
    const raw = this.configService.get<string>('TRAINING_CAPTURE_ENABLED');
    if (raw == null) return true;
    const v = String(raw).trim().toLowerCase();
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
    return true;
  }

  private hashTrainingId(parts: string[]): string {
    const salt =
      this.configService.get<string>('TRAINING_CAPTURE_SALT') ||
      'change-me-in-production-training-salt';
    return createHash('sha256')
      .update(`${parts.join('\n')}\n${salt}`)
      .digest('hex')
      .slice(0, 40);
  }

  async record(params: {
    userId: string;
    generationJobId?: string;
    eventType: CarouselCaptureEventType;
    consentOptIn: boolean;
    payload: CarouselCapturePayloadBase & Record<string, unknown>;
  }): Promise<void> {
    try {
      if (!params.consentOptIn) {
        // No user consent → never record. This is the privacy gate.
        return;
      }
      if (!this.trainingCaptureKillSwitchAllowsWrite()) {
        this.logger.debug(
          `Skipping capture (${params.eventType}): TRAINING_CAPTURE_ENABLED kill-switch is off`,
        );
        return;
      }

      const url = this.configService.get<string>('supabase.url') || '';
      const sr =
        this.configService.get<string>('supabase.serviceRoleKey') || '';
      if (!url || !sr) {
        return;
      }

      const body = redactCarouselCapturePayload(
        params.payload as Record<string, unknown>,
        params.consentOptIn,
      );

      const { error } = await this.supabaseService
        .getServiceClient()
        .from('carousel_generation_capture_events')
        .insert({
          user_id: params.userId,
          generation_job_id: params.generationJobId ?? null,
          event_type: params.eventType,
          consent_opt_in: params.consentOptIn,
          payload: body,
        });

      if (error) {
        this.logger.warn(
          `Carousel capture insert failed (${params.eventType}): ${error.message}`,
        );
      }

      // Persist a `generation_training_candidates` row at two milestones:
      //   - `carousel_text_ready` → prompt + planned slide titles (text payload)
      //   - `carousel_render_complete` → prompt + output meta after successful render
      // The `redacted_output` column (added by the 20260505_redacted_output migration)
      // is optional; older deployments that haven't migrated will still get prompt rows.
      const isCandidateMilestone =
        params.eventType === 'carousel_text_ready' ||
        params.eventType === 'carousel_render_complete';
      if (isCandidateMilestone) {
        const topic =
          typeof body.topicPreview === 'string' ? body.topicPreview : '';
        const redactedPrompt = topic
          .replace(
            /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
            '[redacted-email]',
          )
          .slice(0, 4000);
        const titleSamples =
          (body.slideTitlesSample as string[] | undefined) ??
          (body.slideTitleSample as string[] | undefined) ??
          [];
        const outputSummary = {
          slideCount: body.slideCount,
          slideTitlesSample: titleSamples,
          carouselVisualStyle: body.carouselVisualStyle,
          noteDensity: body.noteDensity,
          programmingModeEffective: body.programmingModeEffective,
          renderedSlides: (
            body.outputMeta as { renderedSlides?: number } | undefined
          )?.renderedSlides,
          outputMeta: body.outputMeta,
        };
        const redactedOutput = JSON.stringify(outputSummary).slice(0, 8000);

        const { error: candErr } = await this.supabaseService
          .getServiceClient()
          .from('generation_training_candidates')
          .insert({
            user_id_hash: this.hashTrainingId(['user', params.userId]),
            generation_id_hash: params.generationJobId
              ? this.hashTrainingId(['job', params.generationJobId])
              : null,
            redacted_prompt: redactedPrompt || '(empty)',
            redacted_output: redactedOutput,
            metadata: {
              event_type: params.eventType,
              slideCount: body.slideCount,
              carouselVisualStyle: body.carouselVisualStyle,
            },
          });
        if (candErr) {
          // If the deployed schema lacks the new `redacted_output` column, retry
          // without it so the prompt row still lands. Older migrations will keep
          // working until the redacted_output migration runs.
          if (
            /column .*redacted_output.* does not exist/i.test(
              candErr.message,
            ) ||
            /could not find the .*redacted_output.* column/i.test(
              candErr.message,
            )
          ) {
            const { error: legacyErr } = await this.supabaseService
              .getServiceClient()
              .from('generation_training_candidates')
              .insert({
                user_id_hash: this.hashTrainingId(['user', params.userId]),
                generation_id_hash: params.generationJobId
                  ? this.hashTrainingId(['job', params.generationJobId])
                  : null,
                redacted_prompt: redactedPrompt || '(empty)',
                metadata: {
                  event_type: params.eventType,
                  slideCount: body.slideCount,
                  carouselVisualStyle: body.carouselVisualStyle,
                  legacy_schema: true,
                  outputSummary,
                },
              });
            if (legacyErr) {
              this.logger.warn(
                `generation_training_candidates insert failed (legacy fallback): ${legacyErr.message}`,
              );
            }
          } else {
            this.logger.warn(
              `generation_training_candidates insert failed: ${candErr.message}`,
            );
          }
        }
      }
    } catch (e) {
      this.logger.warn(
        `Carousel capture exception (${params.eventType}): ${(e as Error).message}`,
      );
    }
  }
}
