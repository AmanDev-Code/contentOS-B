/**
 * Trndinn credit costs — SINGLE SOURCE OF TRUTH (Sprint 1.9 / 1.9b).
 *
 * Every credit cost in the product is defined here ONCE. Both the backend
 * charge paths (`immediate-post-publish.service`, `posts.controller.schedulePost`,
 * `generation.service`) and the frontend display strings (via `GET /credits/costs`)
 * derive from this module. Do NOT hardcode credit numbers anywhere else.
 *
 * CONFIRMED COST MATRIX (do not change without founder sign-off):
 *
 *  | Action                    | Text | Image        | Carousel       | PDF add-on |
 *  |---------------------------|------|--------------|----------------|------------|
 *  | Post Now (immediate)      | 2.5  | 6  (FLAT)    | 12 (FLAT)      | +12        |
 *  | Schedule                  | 4    | 7.5 (FLAT)   | 15 (FLAT)      | +12        |
 *  | Reschedule (move)         | 0    | 0            | 0              | —          |
 *  | AI Generate / Regen full  | 2    | 2 + 3·imgs   | 2 + 2.5·slides | —          |
 *  | Regenerate all images     | —    | 3·imgs       | —              | —          |
 *  | Regenerate single image   | —    | 3            | —              | —          |
 *  | Regenerate carousel       | —    | —            | 2.5·slides     | —          |
 *  | Legacy generate           | 1.5  |              |                |            |
 *  | AI text formatting        | 0.5 / format        |                |            |
 *
 * IMPORTANT distinction (preserved here):
 *  - Post Now & Schedule image/carousel costs are FLAT — they do NOT scale by
 *    the number of images/slides.
 *  - Generate / Regenerate costs SCALE per image / per slide.
 */

export type CreditContentType = 'text' | 'image' | 'carousel';

/** Canonical credit-cost constants. All values are in display credits. */
export const CREDIT_COSTS = {
  /** Immediate publish ("Post Now") — FLAT per content type. */
  postNow: {
    text: 2.5,
    image: 6,
    carousel: 12,
  },
  /** Scheduling a post — FLAT per content type (costs more than Post Now). */
  schedule: {
    text: 4,
    image: 7.5,
    carousel: 15,
  },
  /** Moving an already-scheduled post to a new time — always free. */
  reschedule: 0,
  /** PDF document attachment add-on (applies to Post Now and Schedule). */
  pdfAddOn: 12,
  /** AI generation / full regeneration — SCALES per image / per slide. */
  generate: {
    textBase: 2,
    imagePerUnit: 3,
    slidePerUnit: 2.5,
  },
  /** Targeted regeneration of existing media. */
  regenerate: {
    /** Single image regenerate. */
    singleImage: 3,
    /** Per-image rate when regenerating all images. */
    imagePerUnit: 3,
    /** Per-slide rate when regenerating a carousel. */
    slidePerUnit: 2.5,
  },
  /** Legacy (pre-custom-topic) generation flat cost. */
  legacyGenerate: 1.5,
  /** Lightweight AI "format with AI" helper, charged per format. */
  aiTextFormatting: 0.5,
} as const;

/** Monthly plan credit allotment by internal plan_type (mirrors SQL `credit_plan_allotment`). */
export const PLAN_CREDIT_ALLOTMENTS: Record<string, number> = {
  free: 150,
  standard: 500,
  pro: 2000,
  ultimate: 10000,
};

/** Internal plan_type → marketing display name. */
export const PLAN_DISPLAY_NAMES: Record<string, string> = {
  free: 'Free',
  standard: 'Solo',
  pro: 'Growth',
  ultimate: 'Agency',
};

export function getPlanAllotment(planType?: string | null): number {
  if (planType && planType in PLAN_CREDIT_ALLOTMENTS) {
    return PLAN_CREDIT_ALLOTMENTS[planType];
  }
  return PLAN_CREDIT_ALLOTMENTS.free;
}

export function getPlanDisplayName(planType?: string | null): string {
  if (planType && planType in PLAN_DISPLAY_NAMES) {
    return PLAN_DISPLAY_NAMES[planType];
  }
  return planType ? planType : 'Free';
}

/** Cost to immediately publish a post of the given content type (+ optional PDF). */
export function postNowCost(
  contentType: CreditContentType,
  opts?: { pdf?: boolean },
): number {
  const base = CREDIT_COSTS.postNow[contentType] ?? CREDIT_COSTS.postNow.text;
  return base + (opts?.pdf ? CREDIT_COSTS.pdfAddOn : 0);
}

/** Cost to schedule a post of the given content type (+ optional PDF). */
export function scheduleCost(
  contentType: CreditContentType,
  opts?: { pdf?: boolean },
): number {
  const base = CREDIT_COSTS.schedule[contentType] ?? CREDIT_COSTS.schedule.text;
  return base + (opts?.pdf ? CREDIT_COSTS.pdfAddOn : 0);
}

/**
 * Cost to AI-generate / fully-regenerate a post. Text base + per-unit media.
 * Carousel and image SCALE by count; text is flat.
 */
export function generateCost(
  contentType: CreditContentType,
  imageCount = 1,
  slideCount = 2,
): number {
  const base = CREDIT_COSTS.generate.textBase;
  if (contentType === 'image') {
    return base + CREDIT_COSTS.generate.imagePerUnit * Math.max(0, imageCount);
  }
  if (contentType === 'carousel') {
    return base + CREDIT_COSTS.generate.slidePerUnit * Math.max(0, slideCount);
  }
  return base;
}

export function regenerateSingleImageCost(): number {
  return CREDIT_COSTS.regenerate.singleImage;
}

export function regenerateAllImagesCost(imageCount: number): number {
  return CREDIT_COSTS.regenerate.imagePerUnit * Math.max(0, imageCount);
}

export function regenerateCarouselCost(slideCount: number): number {
  return CREDIT_COSTS.regenerate.slidePerUnit * Math.max(0, slideCount);
}

/**
 * Serializable cost matrix exposed via `GET /credits/costs` so the frontend
 * computes the same numbers / display strings (no hardcoded copies).
 */
export interface CreditCostMatrix {
  postNow: { text: number; image: number; carousel: number };
  schedule: { text: number; image: number; carousel: number };
  reschedule: number;
  pdfAddOn: number;
  generate: { textBase: number; imagePerUnit: number; slidePerUnit: number };
  regenerate: {
    singleImage: number;
    imagePerUnit: number;
    slidePerUnit: number;
  };
  legacyGenerate: number;
  aiTextFormatting: number;
}

export function buildCreditCostMatrix(): CreditCostMatrix {
  return {
    postNow: { ...CREDIT_COSTS.postNow },
    schedule: { ...CREDIT_COSTS.schedule },
    reschedule: CREDIT_COSTS.reschedule,
    pdfAddOn: CREDIT_COSTS.pdfAddOn,
    generate: { ...CREDIT_COSTS.generate },
    regenerate: { ...CREDIT_COSTS.regenerate },
    legacyGenerate: CREDIT_COSTS.legacyGenerate,
    aiTextFormatting: CREDIT_COSTS.aiTextFormatting,
  };
}
