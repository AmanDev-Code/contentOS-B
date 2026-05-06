import { z } from 'zod';

/**
 * Phase-1 outline produced before full slide JSON. Keeps arcs consistent under token pressure.
 */

export const CarouselSlidePlanEntrySchema = z.object({
  index: z.number().int().min(1),
  title: z.string(),
  learnerObjective: z.string(),
});

export const CarouselIntentPlanSchema = z.object({
  inferredSubject: z.string(),
  inferredAudience: z.string(),
  inferredDepth: z.string(),
  pedagogicalArc: z.string(),
  slides: z.array(CarouselSlidePlanEntrySchema),
});

export type CarouselIntentPlan = z.infer<typeof CarouselIntentPlanSchema>;

export function buildCarouselOutlineSystemPrompt(slideCount: number): string {
  return [
    'You ONLY output JSON for carousel lesson planning.',
    `The user carousel will contain exactly ${slideCount} slides.`,
    'Infer subject, intended audience, and depth from Topic line.',
    'slides[] must have EXACTLY ' + `${slideCount} entries` + ', indices 1..N in order, unique titles.',
    'Each learnerObjective names what the viewer should master on that slide (one sentence).',
    'pedagogicalArc: 2 sentences on how slides progress.',
    '',
    'Schema:',
    '{',
    '  "inferredSubject": string,',
    '  "inferredAudience": string,',
    '  "inferredDepth": string,',
    '  "pedagogicalArc": string,',
    '  "slides": [{ "index": number, "title": string, "learnerObjective": string }]',
    '}',
    '',
    'Return ONLY JSON. No markdown fences.',
  ].join('\n');
}
