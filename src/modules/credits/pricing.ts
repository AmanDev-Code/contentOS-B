/**
 * Custom Topic AI Post — credit pricing.
 *
 * All stored values use half-credit integers (multiply display credits × 2)
 * to eliminate floating-point drift on carousel 2.5-per-slide pricing.
 *
 * The per-unit credit values are derived from the single source of truth
 * (`credit-costs.ts → CREDIT_COSTS.generate`). This wrapper preserves the
 * existing `CUSTOM_TOPIC_PRICING` shape (incl. half-credit integers) that the
 * generation worker + specs depend on, while eliminating duplicated numbers.
 */
import { CREDIT_COSTS } from './credit-costs';

export const CUSTOM_TOPIC_PRICING = {
  TEXT_CREDITS: CREDIT_COSTS.generate.textBase,
  IMAGE_PER_UNIT_CREDITS: CREDIT_COSTS.generate.imagePerUnit,
  SLIDE_PER_UNIT_CREDITS: CREDIT_COSTS.generate.slidePerUnit,

  TEXT_HALF_CREDITS: Math.round(CREDIT_COSTS.generate.textBase * 2),
  IMAGE_PER_UNIT_HALF_CREDITS: Math.round(
    CREDIT_COSTS.generate.imagePerUnit * 2,
  ),
  SLIDE_PER_UNIT_HALF_CREDITS: Math.round(
    CREDIT_COSTS.generate.slidePerUnit * 2,
  ),
} as const;

export interface CreditSlice {
  subtaskKey: string; // e.g. 'text', 'image_1', 'slide_3'
  credits: number;
  halfCredits: number;
}

/** UI and legacy clients may send `post` for plain text; API + workers expect `text`. */
export function normalizeCustomTopicContentType(
  raw: unknown,
): 'text' | 'image' | 'carousel' {
  const s = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  if (s === 'post' || s === 'text') return 'text';
  if (s === 'image') return 'image';
  if (s === 'carousel') return 'carousel';
  return 'text';
}

export function calculateTotalCredits(
  contentType: 'text' | 'image' | 'carousel',
  imageCount?: number,
  slideCount?: number,
): number {
  const text = CUSTOM_TOPIC_PRICING.TEXT_CREDITS;
  if (contentType === 'text') return text;
  if (contentType === 'image')
    return (
      text + CUSTOM_TOPIC_PRICING.IMAGE_PER_UNIT_CREDITS * (imageCount ?? 1)
    );
  if (contentType === 'carousel')
    return (
      text + CUSTOM_TOPIC_PRICING.SLIDE_PER_UNIT_CREDITS * (slideCount ?? 2)
    );
  return text;
}

export function calculateTotalHalfCredits(
  contentType: 'text' | 'image' | 'carousel',
  imageCount?: number,
  slideCount?: number,
): number {
  return Math.round(
    calculateTotalCredits(contentType, imageCount, slideCount) * 2,
  );
}

export function buildCreditSlices(
  contentType: 'text' | 'image' | 'carousel',
  imageCount?: number,
  slideCount?: number,
): CreditSlice[] {
  const slices: CreditSlice[] = [
    {
      subtaskKey: 'text',
      credits: CUSTOM_TOPIC_PRICING.TEXT_CREDITS,
      halfCredits: CUSTOM_TOPIC_PRICING.TEXT_HALF_CREDITS,
    },
  ];

  if (contentType === 'image') {
    const count = imageCount ?? 1;
    for (let i = 1; i <= count; i++) {
      slices.push({
        subtaskKey: `image_${i}`,
        credits: CUSTOM_TOPIC_PRICING.IMAGE_PER_UNIT_CREDITS,
        halfCredits: CUSTOM_TOPIC_PRICING.IMAGE_PER_UNIT_HALF_CREDITS,
      });
    }
  }

  if (contentType === 'carousel') {
    const count = slideCount ?? 2;
    for (let i = 1; i <= count; i++) {
      slices.push({
        subtaskKey: `slide_${i}`,
        credits: CUSTOM_TOPIC_PRICING.SLIDE_PER_UNIT_CREDITS,
        halfCredits: CUSTOM_TOPIC_PRICING.SLIDE_PER_UNIT_HALF_CREDITS,
      });
    }
  }

  return slices;
}
