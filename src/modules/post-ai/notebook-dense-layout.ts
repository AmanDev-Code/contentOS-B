/**
 * Deterministic layout metrics for dense handwritten notebook carousels.
 * Keeps thresholds testable without invoking Sharp or LLMs.
 */

export const DENSE_NOTEBOOK_LINE_STEP_PX = 29;

export const DENSE_NOTEBOOK_QUALITY = {
  /** Minimum printable content lines (main column) per page for 10+ slide dense decks */
  minContentLinesLargeDeck: 12,
  /** Minimum notebook section blocks per slide */
  minSections: 2,
  /**
   * Quality gate uses logical teaching rows from `countDenseSlideContentMetrics` (one JSON line
   * ≈ one compositor row before wrap). Prompt targets ~8–14 lines/slide; fill must not require
   * 25+ logical rows (old 0.66×38) which rejected normal model output. ~0.32×28 ≈ 9 rows minimum.
   */
  minFillRatio: 0.32,
  /** Minimum non-whitespace characters from structured fields per page (10–12 slides) */
  minCharsLargeDeck: 300,
  /** Smaller decks (≤9 slides) slightly relaxed */
  minCharsSmallDeck: 260,
  /** Approx. ruled-band row slots below title (two-column body; aligns with compositor) */
  assumedMaxLines: 28,
} as const;

export function estimateNotebookPageFillRatio(params: {
  lineCount: number;
  maxLines: number;
}): number {
  if (params.maxLines <= 0) return 0;
  return Math.min(1, params.lineCount / params.maxLines);
}

export type DenseSlideForMetrics = {
  body: string;
  bullets?: string[];
  denseBullets?: string[];
  codeSnippets?: string[];
  notebookSections?: Array<{
    subheading?: string;
    lines: string[];
    bulletItems?: string[];
  }>;
  marginNotes?: string[];
};

/**
 * Aggregate structured + legacy fields the quality gate and renderer use.
 */
export function countDenseSlideContentMetrics(slide: DenseSlideForMetrics): {
  totalChars: number;
  lineCount: number;
  sectionCount: number;
} {
  let totalChars = (slide.body || '').replace(/\s+/g, ' ').trim().length;
  let lineCount = 0;
  let sectionCount = 0;

  if (slide.notebookSections?.length) {
    sectionCount = slide.notebookSections.length;
    for (const sec of slide.notebookSections) {
      const sub = (sec.subheading || '').trim();
      if (sub) {
        totalChars += sub.length;
        lineCount += 1;
      }
      for (const line of sec.lines || []) {
        const t = line.trim();
        if (t) {
          totalChars += t.length;
          lineCount += 1;
        }
      }
      if (sec.bulletItems?.length) {
        for (const b of sec.bulletItems) {
          const t = b.trim();
          if (t) {
            totalChars += t.length;
            lineCount += 1;
          }
        }
      }
    }
  }

  for (const b of slide.bullets || []) {
    const t = b.trim();
    if (t) {
      totalChars += t.length;
      lineCount += 1;
    }
  }

  for (const b of slide.denseBullets || []) {
    const t = b.trim();
    if (t) {
      totalChars += t.length;
      lineCount += 1;
    }
  }

  for (const c of slide.codeSnippets || []) {
    const t = c.trim();
    if (t) {
      totalChars += t.length;
      lineCount += Math.max(1, Math.ceil(t.length / 72));
    }
  }

  for (const m of slide.marginNotes || []) {
    const t = m.trim();
    if (t) totalChars += t.length;
  }

  return { totalChars, lineCount, sectionCount };
}
