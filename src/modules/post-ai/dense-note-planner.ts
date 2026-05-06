import { z } from 'zod';

export const DenseNotePlanSchema = z.object({
  subject: z.string().min(2),
  audience: z.string().min(2),
  tone: z.string().min(2),
  depth: z.string().min(2),
  pageCount: z.number().int().positive(),
  pages: z.array(
    z.object({
      pageIndex: z.number().int().min(1),
      title: z.string().min(3),
      learningObjective: z.string().min(16),
      keyPoints: z.array(z.string().min(10)).min(3).max(8),
    }),
  ),
});

export type DenseNotePlan = z.infer<typeof DenseNotePlanSchema>;

export function buildDenseNotePlannerPrompt(
  topic: string,
  slideCount: number,
): { system: string; user: string } {
  return {
    system: [
      'You are a curriculum designer for social carousel study decks.',
      'Return ONLY valid JSON (no markdown) with this exact shape:',
      '{',
      '  "subject": string,',
      '  "audience": string,',
      '  "tone": string,',
      '  "depth": string,',
      '  "pageCount": number,',
      '  "pages": [',
      '    { "pageIndex": number, "title": string, "learningObjective": string, "keyPoints": string[] }',
      '  ]',
      '}',
      `Hard rules: pageCount MUST equal ${slideCount}. The "pages" array MUST have exactly ${slideCount} entries.`,
      `pageIndex MUST be 1 through ${slideCount} in order with no gaps or duplicates.`,
      'Titles must be unique, concrete, and specific to the user topic (no "Slide 3", "Carousel slide N", or placeholder headings).',
      'Learning progression: frame → definitions → mechanics → examples → pitfalls/common mistakes → recap / how to practice.',
      'Each keyPoints list must hold 3–6 substantive teaching bullets the corresponding page will expand into dense notes.',
      'Generalize to ANY user topic (technical, business, language, health, hobby, etc.) — stay faithful to the user wording.',
    ].join('\n'),
    user: `User topic / request:\n${topic.trim()}`,
  };
}
