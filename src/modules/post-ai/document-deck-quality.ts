/**
 * Quality gate for the educational document-deck presets (`handwritten_notes`,
 * `structured_document`). These decks render deterministically from validated
 * structured content, so we DON'T require LLM-image-style alignment — we only
 * need to ensure the deck shape is consistent and body pages are dense enough.
 */

import type {
  CarouselDocumentTheme,
  CarouselSlideOutput,
  CarouselPostOutput,
  TocEntry,
} from './custom-topic.schemas';
import type { CarouselQualityIssue } from './carousel-quality';

const MIN_BODY_BULLETS = 4;
const MAX_BODY_BULLETS = 8;
const MIN_TITLE_CHARS = 4;
const MIN_BODY_CHARS = 24;
const MIN_BULLET_CHARS = 12;

export interface DocumentDeckQualityParams {
  output: Pick<
    CarouselPostOutput,
    'slides' | 'tocEntries' | 'coverTitle' | 'coverSubtitle' | 'author'
  >;
  expectedSlideCount: number;
  documentMode: 'handwritten_notes' | 'structured_document';
  /** For logging only; gate behavior is the same for both notebook + clean_document. */
  theme?: CarouselDocumentTheme;
}

function looksLikePlaceholderTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (/^carousel\s+slide\s*\d+\s*$/i.test(t)) return true;
  if (/^slide\s*\d+\s*$/i.test(t)) return true;
  if (/^page\s*\d+\s*$/i.test(t)) return true;
  if (/^untitled/i.test(t)) return true;
  return false;
}

function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bodyBulletList(slide: CarouselSlideOutput): string[] {
  const collected: string[] = [];
  for (const b of slide.bullets || []) {
    const t = String(b ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (t) collected.push(t);
  }
  // Body decks may also use notebookSections.lines as natural bullets.
  for (const sec of slide.notebookSections || []) {
    for (const ln of sec.lines || []) {
      const t = String(ln ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (t) collected.push(t);
    }
    for (const b of sec.bulletItems || []) {
      const t = String(b ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (t) collected.push(t);
    }
  }
  // Strict de-dup
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of collected) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Hard-required deck-shape + content checks. Returns the same `CarouselQualityIssue` shape. */
export function analyzeDocumentDeckQuality(
  params: DocumentDeckQualityParams,
): CarouselQualityIssue[] {
  const issues: CarouselQualityIssue[] = [];
  const { output, expectedSlideCount, documentMode } = params;
  const slides = output.slides ?? [];

  if (slides.length !== expectedSlideCount) {
    issues.push({
      code: 'documentdeck_slide_count',
      detail: `Expected ${expectedSlideCount} slides for ${documentMode} deck, got ${slides.length}.`,
    });
  }

  // Cover validity
  const cover = slides.find((s) => s.sectionType === 'cover') ?? slides[0];
  if (!cover || cover.sectionType !== 'cover') {
    issues.push({
      code: 'documentdeck_cover_missing',
      detail:
        'Document deck must have a cover slide as the first page (sectionType="cover", pageNumber=1).',
    });
  } else if (cover.pageNumber !== 1) {
    issues.push({
      code: 'documentdeck_cover_page',
      detail: `Cover must have pageNumber=1 (got ${cover.pageNumber ?? 'undefined'}).`,
    });
  }
  const coverTitle = (output.coverTitle || '').trim();
  if (coverTitle.length < MIN_TITLE_CHARS) {
    issues.push({
      code: 'documentdeck_cover_title',
      detail: `coverTitle must be ≥${MIN_TITLE_CHARS} chars (got ${coverTitle.length}).`,
    });
  }

  // TOC validity
  const tocSlide = slides.find((s) => s.sectionType === 'toc') ?? slides[1];
  if (!tocSlide || tocSlide.sectionType !== 'toc') {
    issues.push({
      code: 'documentdeck_toc_missing',
      detail:
        'Document deck must include a Table of Contents slide as page 2 (sectionType="toc", pageNumber=2).',
    });
  } else if (tocSlide.pageNumber !== 2) {
    issues.push({
      code: 'documentdeck_toc_page',
      detail: `TOC must have pageNumber=2 (got ${tocSlide.pageNumber ?? 'undefined'}).`,
    });
  }

  const bodySlides = slides.filter((s) => s.sectionType === 'body');
  const tocEntries: TocEntry[] = output.tocEntries ?? [];

  if (bodySlides.length === 0) {
    issues.push({
      code: 'documentdeck_no_body',
      detail:
        'Document deck must include at least one body slide (sectionType="body").',
    });
  }

  if (tocEntries.length !== bodySlides.length) {
    issues.push({
      code: 'documentdeck_toc_body_mismatch',
      detail: `tocEntries length (${tocEntries.length}) must match body slide count (${bodySlides.length}).`,
    });
  } else {
    for (let i = 0; i < bodySlides.length; i++) {
      const body = bodySlides[i];
      const entry = tocEntries[i];
      if (!entry) continue;
      const bodyKey = normalizeTitleKey(body.title || '');
      const entryKey = normalizeTitleKey(entry.title || '');
      if (bodyKey.length < MIN_TITLE_CHARS) {
        // Already flagged below; skip TOC mismatch noise here.
      } else if (entryKey !== bodyKey) {
        issues.push({
          code: 'documentdeck_toc_title_mismatch',
          detail: `tocEntries[${i}].title ("${entry.title}") does not match body slide title ("${body.title}").`,
        });
      }
      if (entry.pageNumber !== body.pageNumber) {
        issues.push({
          code: 'documentdeck_toc_page_mismatch',
          detail: `tocEntries[${i}].pageNumber (${entry.pageNumber}) does not match body slide pageNumber (${body.pageNumber ?? 'undefined'}).`,
        });
      }
    }
  }

  // Page numbers monotonic 1..N, no duplicates, no gaps
  const numbered = slides
    .map((s, i) => ({ idx: i, n: s.pageNumber, sectionType: s.sectionType }))
    .filter((s) => typeof s.n === 'number') as Array<{
    idx: number;
    n: number;
    sectionType?: string;
  }>;
  if (numbered.length === slides.length) {
    const sorted = [...numbered].sort((a, b) => a.n - b.n);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].n !== i + 1) {
        issues.push({
          code: 'documentdeck_page_numbers_invalid',
          detail: `Page numbers must be 1..${slides.length} with no gaps or repeats; saw ${sorted[i].n} at position ${i}.`,
        });
        break;
      }
    }
    // Ensure deck order matches page-number order
    for (let i = 1; i < numbered.length; i++) {
      if (numbered[i].n <= numbered[i - 1].n) {
        issues.push({
          code: 'documentdeck_page_numbers_out_of_order',
          detail: `Slides must be ordered by ascending pageNumber; slide ${numbered[i].idx + 1} has pageNumber ${numbered[i].n} after ${numbered[i - 1].n}.`,
        });
        break;
      }
    }
  } else {
    issues.push({
      code: 'documentdeck_page_numbers_missing',
      detail: `Every slide must have an integer pageNumber (missing on ${slides.length - numbered.length} slides).`,
    });
  }

  // Per-slide body checks
  const seenTitles = new Set<string>();
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const title = (slide.title || '').trim();
    if (looksLikePlaceholderTitle(title)) {
      issues.push({
        code: 'documentdeck_placeholder_title',
        detail: `Slide ${i + 1} (page ${slide.pageNumber ?? '?'}) uses a placeholder title.`,
      });
    } else if (title.length < MIN_TITLE_CHARS) {
      issues.push({
        code: 'documentdeck_title_too_short',
        detail: `Slide ${i + 1} title too short (${title.length} chars).`,
      });
    }

    // Cross-slide title duplicates
    const tk = normalizeTitleKey(title);
    if (tk.length >= MIN_TITLE_CHARS) {
      if (seenTitles.has(tk)) {
        issues.push({
          code: 'documentdeck_duplicate_title',
          detail: `Slide ${i + 1} title duplicates an earlier slide ("${title}").`,
        });
      }
      seenTitles.add(tk);
    }

    if (slide.sectionType === 'body') {
      const body = (slide.body || '').trim();
      if (body.length < MIN_BODY_CHARS) {
        issues.push({
          code: 'documentdeck_body_too_short',
          detail: `Body slide ${i + 1} body too short (${body.length} < ${MIN_BODY_CHARS} chars).`,
        });
      }

      const bullets = bodyBulletList(slide);
      if (bullets.length < MIN_BODY_BULLETS) {
        issues.push({
          code: 'documentdeck_bullets_low',
          detail: `Body slide ${i + 1} has ${bullets.length} substantive bullets/lines (need ≥${MIN_BODY_BULLETS}).`,
        });
      }
      if (bullets.length > MAX_BODY_BULLETS) {
        // Not a hard fail — but note (renderer will truncate).
      }
      for (let j = 0; j < bullets.length; j++) {
        if (bullets[j].length < MIN_BULLET_CHARS) {
          issues.push({
            code: 'documentdeck_bullet_too_short',
            detail: `Body slide ${i + 1} bullet ${j + 1} is too short (${bullets[j].length} chars).`,
          });
          break;
        }
      }
    }

    if (slide.sectionType === 'cover' && slide.pageNumber !== 1) {
      // already handled above
    }
  }

  return issues;
}

/**
 * Strict-retry instruction for the LLM after document-deck quality fails. Mirrors the
 * style of `buildCarouselStrictRetryInstruction` so the worker can reuse the recovery
 * loop in `CustomTopicGenerationService`.
 */
export function buildDocumentDeckStrictRetryInstruction(
  issues: CarouselQualityIssue[],
  documentMode: 'handwritten_notes' | 'structured_document',
): string {
  return [
    `DOCUMENT DECK REWRITE REQUIRED — your previous ${documentMode} output failed automated checks.`,
    'Issues:',
    ...issues.map((x) => `- [${x.code}] ${x.detail}`),
    '',
    'Rewrite the ENTIRE JSON output:',
    '- Keep the strict cover + TOC + body (+ optional outro) shape with monotonic pageNumbers.',
    '- tocEntries length must EQUAL body slide count; titles + pageNumbers must match each body slide verbatim.',
    '- Every body slide needs ≥4 substantive bullets (≥12 chars each) plus a 1–2 sentence body.',
    '- No "Slide N", "Untitled", or generic placeholder titles.',
    '- Do not change schema field names.',
    '',
    'Return ONLY valid JSON.',
  ].join('\n');
}
