/**
 * Carousel "document mode" preset routing for educational decks.
 *
 * When tonality=educational + contentType=carousel, two presets render the deck
 * deterministically (cover + TOC + body) without calling the OpenAI image model:
 *
 *   - `handwritten_notes`     → ruled student-notebook style (notebook theme)
 *   - `structured_document`   → clean PDF/study-document style (clean_document theme)
 *
 * `auto` resolves from prompt cues (notebook vs. ebook/pdf vibe). `none` keeps the
 * legacy compositor + LLM-image carousel pipeline. Always honors explicit overrides.
 */

import type {
  CarouselDocumentMode,
  CarouselDocumentTheme,
} from './custom-topic.schemas';

/** Phrase cues that imply a real-notebook handwritten study deck. */
const NOTEBOOK_PRESET_CUES = [
  'notebook',
  'handwritten',
  'hand written',
  'hand-written',
  'study notes',
  'lecture notes',
  'notepad',
  'cram sheet',
  'revision notes',
  'page of notes',
  'pages of notes',
  'student notes',
  'notes carousel',
];

/** Phrase cues that imply a polished document/ebook/whitepaper deck. */
const DOCUMENT_PRESET_CUES = [
  'ebook',
  'e-book',
  'document',
  'guide',
  'guidebook',
  'report',
  'whitepaper',
  'white paper',
  'pdf style',
  'pdf-style',
  'pdf carousel',
  'study material',
  'study guide',
  'reference manual',
  'manual',
  'handbook',
  'documentation',
  'cheatsheet',
  'cheat sheet',
  'syllabus',
  'curriculum',
];

export interface DocumentModeResolution {
  resolved: 'none' | 'handwritten_notes' | 'structured_document';
  source: 'explicit' | 'inferred' | 'default';
}

/**
 * Returns the active educational deck preset.
 *
 * - `tonality !== 'educational'` or `contentType !== 'carousel'` → `none` (legacy).
 * - `override === 'auto'` → infer from topic (default to `none` when ambiguous).
 * - Explicit override → honor as-is.
 *
 * Note: `none` is also returned for `auto` when the topic doesn't suggest either
 * preset; the existing carousel pipeline owns those cases (intentional).
 */
export function resolveCarouselDocumentMode(params: {
  topic: string;
  tonality: string;
  contentType: 'text' | 'image' | 'carousel';
  override?: CarouselDocumentMode;
}): DocumentModeResolution {
  const { topic, tonality, contentType } = params;
  if (tonality !== 'educational' || contentType !== 'carousel') {
    return { resolved: 'none', source: 'default' };
  }

  const o: CarouselDocumentMode = params.override ?? 'auto';
  if (
    o === 'none' ||
    o === 'handwritten_notes' ||
    o === 'structured_document'
  ) {
    return { resolved: o, source: 'explicit' };
  }

  const t = topic.toLowerCase();

  // Notebook beats document if both fire (most users explicitly say "notebook"/"handwritten").
  for (const cue of NOTEBOOK_PRESET_CUES) {
    if (t.includes(cue)) {
      return { resolved: 'handwritten_notes', source: 'inferred' };
    }
  }
  for (const cue of DOCUMENT_PRESET_CUES) {
    if (t.includes(cue)) {
      return { resolved: 'structured_document', source: 'inferred' };
    }
  }

  return { resolved: 'none', source: 'default' };
}

/** Default theme per preset. */
export function documentThemeForMode(
  mode: 'handwritten_notes' | 'structured_document',
): CarouselDocumentTheme {
  return mode === 'handwritten_notes' ? 'notebook' : 'clean_document';
}

/** True when this preset uses the deterministic document-deck renderer (no LLM image). */
export function isDocumentDeckPreset(
  mode: DocumentModeResolution['resolved'],
): mode is 'handwritten_notes' | 'structured_document' {
  return mode === 'handwritten_notes' || mode === 'structured_document';
}

/**
 * Page-budget split for a document-deck of size `slideCount` (cover + TOC always
 * counted toward the user-selected slide budget). Returns inclusive 1-indexed page
 * numbers per section. We always reserve page 1 = cover, page 2 = TOC, page N = optional outro.
 *
 * Pricing rule (`2 + 2.5 × slideCount`) is unchanged: cover/TOC pages are billed
 * the same as body pages. See backend pricing module.
 */
export function planDocumentDeckPages(slideCount: number): {
  coverPage: number;
  tocPage: number;
  bodyPages: number[];
  outroPage: number | null;
  totalPages: number;
} {
  const N = Math.max(2, Math.min(40, Math.round(slideCount)));

  if (N <= 2) {
    // Degenerate case — keep cover only when ≤ 2 slides.
    return {
      coverPage: 1,
      tocPage: 2,
      bodyPages: [],
      outroPage: null,
      totalPages: 2,
    };
  }

  // Reserve outro for ≥ 6-slide decks (gives enough body to feel substantive).
  const includeOutro = N >= 6;
  const outroPage = includeOutro ? N : null;
  const bodyEnd = includeOutro ? N - 1 : N;
  const bodyPages: number[] = [];
  for (let p = 3; p <= bodyEnd; p++) bodyPages.push(p);

  return {
    coverPage: 1,
    tocPage: 2,
    bodyPages,
    outroPage,
    totalPages: N,
  };
}
