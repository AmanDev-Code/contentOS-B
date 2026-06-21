/**
 * Explicit carousel image base style (user override or inferred from topic).
 * Drives image prompt preamble and overlay layout — not the OpenAI "vivid/natural" flag.
 */

export const CAROUSEL_VISUAL_STYLES = [
  'handwritten_notebook',
  /** Full-page dense study notes: planner + stricter quality + multi-line layout */
  'handwritten_notebook_dense',
  'whiteboard_notes',
  'diagram_clean',
  'stock_visual',
] as const;

export type CarouselVisualStyle = (typeof CAROUSEL_VISUAL_STYLES)[number];

export type CarouselVisualStyleOrAuto = 'auto' | CarouselVisualStyle;

/**
 * Topic cues that imply full-page, line-filling notes (not title + 3 bullets).
 * Checked before generic notebook routing.
 */
const DENSE_NOTEBOOK_PHRASES = [
  'complete notes',
  'full page',
  'full-page',
  'dense notes',
  'line by line',
  'line-by-line',
  'written by hand',
  'outside the lines',
  'outside lines',
  'in the margins',
  'margin note',
  'small notes',
  'training notes',
  'topic-complete',
  'like my notes',
  'real notes',
  'personal notes',
  'study pages',
  'cram sheet',
  'exam cram',
  'everything on one page',
  'handwritten pages',
];

const HANDBOOK_PHRASES = [
  'handwritten',
  'hand-written',
  'hand writing',
  'notebook',
  'notepad',
  'note book',
  'pages',
  '12 page',
  '12-page',
  'multi page',
  'multipage',
  'study notes',
  'lecture notes',
  'exam notes',
  'margin notes',
  'scribble',
  'jot',
  'sketch notes',
];

const WHITEBOARD_PHRASES = [
  'whiteboard',
  'white board',
  'dry erase',
  'dry-erase',
  'marker board',
];

const DIAGRAM_PHRASES = [
  'clean diagram',
  'technical diagram',
  'vector diagram',
  'minimal diagram',
  'schematic',
  'infographic style',
];

/**
 * Infer style from user topic when `auto` is selected.
 */
function impliesDenseNotebookPages(topicLower: string): boolean {
  const t = topicLower;
  for (const p of DENSE_NOTEBOOK_PHRASES) {
    if (t.includes(p)) return true;
  }
  // N-page + notes / notebook / handwritten → dense composition
  if (
    /\b(?:8|9|10|11|12)\s*[- ]?page\b/.test(t) &&
    /note|notebook|handwritten|hand-written|study|lecture|cram|sheet/.test(t)
  ) {
    return true;
  }
  return false;
}

export function inferCarouselVisualStyleFromTopic(
  topicLower: string,
): CarouselVisualStyle {
  const t = topicLower;

  if (impliesDenseNotebookPages(t)) {
    return 'handwritten_notebook_dense';
  }

  for (const p of HANDBOOK_PHRASES) {
    if (t.includes(p)) return 'handwritten_notebook';
  }
  for (const p of WHITEBOARD_PHRASES) {
    if (t.includes(p)) return 'whiteboard_notes';
  }
  for (const p of DIAGRAM_PHRASES) {
    if (t.includes(p)) return 'diagram_clean';
  }

  // Educational / DSA context often wants notes-like backgrounds even without the word "notebook"
  if (
    /\bdsa\b/.test(t) ||
    /\bdata\s+structures?\b/.test(t) ||
    /\balgorithms?\b/.test(t) ||
    /leetcode/.test(t) ||
    /interview\s+prep/.test(t) ||
    /coding\s+interview/.test(t)
  ) {
    return 'handwritten_notebook';
  }

  return 'stock_visual';
}

export function resolveCarouselVisualStyle(
  topic: string,
  override: CarouselVisualStyleOrAuto | undefined,
): { resolved: CarouselVisualStyle; source: 'explicit' | 'inferred' } {
  const o = override ?? 'auto';
  if (o !== 'auto') {
    return { resolved: o, source: 'explicit' };
  }
  return {
    resolved: inferCarouselVisualStyleFromTopic(topic.toLowerCase()),
    source: 'inferred',
  };
}

export type CustomCarouselOverlayProfile =
  | 'linkedin_panel'
  | 'notebook_paper'
  | 'whiteboard';

export function overlayProfileForCarouselStyle(
  style: CarouselVisualStyle,
): CustomCarouselOverlayProfile {
  switch (style) {
    case 'handwritten_notebook':
    case 'handwritten_notebook_dense':
      return 'notebook_paper';
    case 'whiteboard_notes':
      return 'whiteboard';
    default:
      return 'linkedin_panel';
  }
}

export function isNotebookPaperCarouselStyle(
  style: CarouselVisualStyle,
): boolean {
  return (
    style === 'handwritten_notebook' || style === 'handwritten_notebook_dense'
  );
}
