/**
 * Deterministic checks for carousel LLM output before media generation.
 */

import type { CarouselVisualStyle } from './carousel-visual-style';
import { isNotebookPaperCarouselStyle } from './carousel-visual-style';
import type { CarouselNoteDensityLevel } from './custom-topic.schemas';
import {
  DENSE_NOTEBOOK_QUALITY,
  countDenseSlideContentMetrics,
  estimateNotebookPageFillRatio,
} from './notebook-dense-layout';
import { collectStructuredNotebookLines } from './notebook-compositor-lines';

export interface CarouselQualityIssue {
  code: string;
  detail: string;
}

function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikePlaceholderTitle(title: string): boolean {
  const t = title.trim();
  if (/^carousel\s+slide\s*\d+\s*$/i.test(t)) return true;
  if (/^slide\s*\d+\s*$/i.test(t)) return true;
  if (/^slide\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*$/i.test(t))
    return true;
  return false;
}

/** Low-information “filler” handwriting lines we refuse to ship in dense mode */
function isLowInformationDenseLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 12) return true;
  if (/^(slide|page)\s+\d+$/i.test(t)) return true;
  if (
    /\b(is important|very important|critically important|matters most|remember this|key takeaway|dont forget this|good to know)\b/i.test(
      t,
    ) &&
    t.length < 72
  ) {
    return true;
  }
  return false;
}

function denseGenericLineIssues(slideIndex: number, lines: string[]): CarouselQualityIssue[] {
  const issues: CarouselQualityIssue[] = [];
  let fluff = 0;
  const normalized = lines.map((l) => l.replace(/\s+/g, ' ').trim().toLowerCase());
  const counts = new Map<string, number>();
  for (const l of normalized) {
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  for (const line of lines) {
    if (isLowInformationDenseLine(line)) fluff++;
  }
  if (fluff >= 4 || (lines.length > 0 && fluff / lines.length > 0.35)) {
    issues.push({
      code: 'dense_low_information_lines',
      detail: `Slide ${slideIndex + 1}: too many thin/generic lines — expand with definitions, steps, or concrete examples.`,
    });
  }
  for (const [line, n] of counts) {
    if (line.length > 24 && n >= 3) {
      issues.push({
        code: 'dense_repeated_lines',
        detail: `Slide ${slideIndex + 1}: repeated low-value line appears ${n} times.`,
      });
      break;
    }
  }
  return issues;
}

const JAVA_DSA_DECK_TERMS = [
  'array',
  'string',
  'list',
  'stack',
  'queue',
  'hash',
  'tree',
  'heap',
  'graph',
  'recurs',
  'leetcode',
  'interview',
  'complexity',
  'dynamic',
];

function dsInterviewTopic(topicLower: string): boolean {
  return (
    /\bjava\b/.test(topicLower) ||
    /\bdsa\b/.test(topicLower) ||
    /\bdata\s+structures?\b/.test(topicLower) ||
    /\bjvm\b/.test(topicLower) ||
    /leetcode/.test(topicLower) ||
    /interview/.test(topicLower) ||
    /coding\s+interview/.test(topicLower)
  );
}

/** Markers suggesting code / interview supplements on at least programming slides */
const PROGRAMMING_SURFACE_RE =
  /\{[\s\S]{0,400}\}|`[^`]{3,120}`|\b(public\s+static|class\s+\w+|void\s+\w+|import\s+java\b|Arrays\.|Collections\.|List<|Map<|Set<|PriorityQueue|ArrayDeque|StringBuilder)\b|O\([\w logn]+\)|\btime\s+complexity\b|\bpitfall\b|\binterview\b/i;

export function analyzeProgrammingCarouselSurface(textBlob: string): boolean {
  return PROGRAMMING_SURFACE_RE.test(textBlob);
}

export function topicRequestsFilledHandwritingNotes(topicLower: string): boolean {
  return (
    /\bcomplete\s+handwritten\b/.test(topicLower) ||
    /\bhandwritten\s+notes\b/.test(topicLower) ||
    /\bfull[\s-]?page\s+notes\b/.test(topicLower) ||
    /\bdense\s+study\s+notes\b/.test(topicLower) ||
    /\breal\s+study\s+notes\b/.test(topicLower)
  );
}

/**
 * Educational carousel: handwritten teaching content belongs in the slide image (no compositor overlay).
 * Requires educational tonality + ruled notebook visual + topic/study/teaching cues.
 */
export function educationalNotebookImageNativeMode(params: {
  tonality: string;
  topicLower: string;
  visualStyle: CarouselVisualStyle;
}): boolean {
  if (params.tonality !== 'educational') return false;
  if (!isNotebookPaperCarouselStyle(params.visualStyle)) return false;
  const t = params.topicLower;
  if (topicRequestsFilledHandwritingNotes(t)) return true;
  if (dsInterviewTopic(t)) return true;
  return /\b(study|exam|lecture|tutorial|course|prep\b|material|concept|chapter|subject|dsa|algorithm|leetcode|programming|coding|python\b|typescript|javascript|cpp|java|c\+{2}|notebook|handwritten|notepad|notes\b|cheat\s*sheet|cram|revision|homework|assignment)\b/i.test(
    t,
  );
}

function slideCountHeuristic(expectedCount: number): number {
  if (expectedCount >= 12) return 10;
  if (expectedCount >= 8) return 8;
  return 6;
}

export function analyzeCarouselQuality(params: {
  slides: Array<{
    title: string;
    body: string;
    imagePrompt: string;
    bullets?: string[];
    denseBullets?: string[];
    codeSnippets?: string[];
    notebookSections?: Array<{
      subheading?: string;
      lines: string[];
      bulletItems?: string[];
    }>;
    marginNotes?: string[];
  }>;
  expectedCount: number;
  topicLower: string;
  resolvedVisualStyle?: CarouselVisualStyle;
  noteDensity?: CarouselNoteDensityLevel;
  programmingModeEffective?: boolean;
}): CarouselQualityIssue[] {
  const issues: CarouselQualityIssue[] = [];
  const { slides, expectedCount, topicLower, resolvedVisualStyle } = params;
  const noteDensity: CarouselNoteDensityLevel =
    params.noteDensity ??
    (resolvedVisualStyle &&
      isNotebookPaperCarouselStyle(resolvedVisualStyle)
      ? 'dense'
      : 'standard');
  const programmingMode = Boolean(params.programmingModeEffective);

  if (slides.length !== expectedCount) {
    issues.push({
      code: 'slide_count',
      detail: `Expected exactly ${expectedCount} slides, got ${slides.length}.`,
    });
  }

  const topicTokens = topicLower
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t.length >= 3);

  const minBodyDense = expectedCount >= 10 ? 36 : 40;
  const minBodyCompact = expectedCount >= 10 ? 40 : 48;
  const minBodyLen =
    noteDensity === 'dense' ? minBodyDense : noteDensity === 'compact' ? 28 : minBodyCompact;
  const minTitleLen = 4;

  const bodies = slides.map((s) => (s.body || '').trim());
  const titles = slides.map((s) => (s.title || '').trim());
  const titleKeys = titles.map((t) => normalizeTitleKey(t));
  const seenTitles = new Set<string>();
  for (let i = 0; i < titleKeys.length; i++) {
    const k = titleKeys[i];
    if (k.length < 4) continue;
    if (seenTitles.has(k)) {
      issues.push({
        code: 'duplicate_heading',
        detail: `Slides use the same or nearly the same title as another slide (slide ${i + 1}).`,
      });
      break;
    }
    seenTitles.add(k);
  }

  let programmingSurfaceHits = 0;

  for (let i = 0; i < slides.length; i++) {
    const title = titles[i];
    const body = bodies[i];
    const prompt = (slides[i].imagePrompt || '').trim();
    const bullets = Array.isArray(slides[i].bullets)
      ? slides[i].bullets!.map((b) => String(b).trim()).filter(Boolean)
      : [];

    const slideBlob = `${title}\n${body}\n${bullets.join(' ')}\n${(slides[i].denseBullets ?? []).join(' ')}\n${(slides[i].codeSnippets ?? []).join(' ')}\n${collectStructuredNotebookLines(slides[i]).join(' ')}`;
    if (programmingMode && analyzeProgrammingCarouselSurface(slideBlob)) {
      programmingSurfaceHits++;
    }

    if (title.length < minTitleLen) {
      issues.push({
        code: 'title_too_short',
        detail: `Slide ${i + 1} title too short (${title.length} chars).`,
      });
    }

    if (body.length < minBodyLen) {
      issues.push({
        code: 'body_too_short',
        detail: `Slide ${i + 1} body too short (${body.length} chars, min ${minBodyLen}).`,
      });
    }

    if (looksLikePlaceholderTitle(title)) {
      issues.push({
        code: 'placeholder_title',
        detail: `Slide ${i + 1} uses generic placeholder title.`,
      });
    }

    if (/carousel\s+slide\s*\d+/i.test(body) && body.length < 120) {
      issues.push({
        code: 'placeholder_body',
        detail: `Slide ${i + 1} body looks like a placeholder.`,
      });
    }

    if (noteDensity !== 'dense') {
      if (bullets.length > 0) {
        const minBul = noteDensity === 'compact' ? 1 : 3;
        const maxBul = noteDensity === 'compact' ? 3 : 5;
        if (bullets.length < minBul || bullets.length > maxBul) {
          issues.push({
            code: 'bullets_count',
            detail: `Slide ${i + 1} bullets count invalid for ${noteDensity} density (have ${bullets.length}, expected ${minBul}-${maxBul}).`,
          });
        }
        const minBulletChars = noteDensity === 'compact' ? 10 : 12;
        for (let j = 0; j < bullets.length; j++) {
          if (bullets[j].length < minBulletChars) {
            issues.push({
              code: 'bullet_too_short',
              detail: `Slide ${i + 1} bullet ${j + 1} is too short; use substantive teaching points.`,
            });
            break;
          }
        }
      } else if (noteDensity !== 'compact' && expectedCount >= 8 && !slides[i].notebookSections?.length) {
        issues.push({
          code: 'bullets_missing',
          detail: `Slide ${i + 1}: for ${noteDensity} carousels with ${expectedCount}+ slides, include bullets OR structured notebookSections.`,
        });
      }
    } else {
      const metrics = countDenseSlideContentMetrics({
        body: slides[i].body,
        bullets: slides[i].bullets,
        denseBullets: slides[i].denseBullets,
        codeSnippets: slides[i].codeSnippets,
        notebookSections: slides[i].notebookSections,
        marginNotes: slides[i].marginNotes,
      });
      const structuredLines = collectStructuredNotebookLines(slides[i]);
      
      // STRICTER DENSITY REQUIREMENTS: Each slide should have 15-25+ substantive teaching lines
      const denseLinesFloor = Math.max(15, Math.min(22, Math.round(16 + slides.length / 5)));
      const minBulletsCount = 8;
      const minDenseBulletsCount = 4;
      const minCodeSnippetsForTech = 1;
      const minMarginNotes = 3;
      const minNotebookSections = 3;

      if (!slides[i].notebookSections?.length || slides[i].notebookSections!.length < minNotebookSections) {
        issues.push({
          code: 'dense_missing_sections',
          detail: `Slide ${i + 1}: dense mode requires at least ${minNotebookSections} notebookSections (e.g., Definition, Example, Pitfalls, Tips).`,
        });
      }
      
      // Check bullets count
      const bulletsCount = (slides[i].bullets || []).filter(b => b.trim().length > 20).length;
      if (bulletsCount < minBulletsCount) {
        issues.push({
          code: 'dense_bullets_sparse',
          detail: `Slide ${i + 1}: need ≥${minBulletsCount} substantive bullets (have ${bulletsCount}). Each bullet must be ≥20 chars with real information.`,
        });
      }
      
      // Check denseBullets
      const denseBulletsCount = (slides[i].denseBullets || []).filter(b => b.trim().length > 10).length;
      if (denseBulletsCount < minDenseBulletsCount) {
        issues.push({
          code: 'dense_densebullets_sparse',
          detail: `Slide ${i + 1}: need ≥${minDenseBulletsCount} denseBullets for quick reference (have ${denseBulletsCount}).`,
        });
      }
      
      // Check margin notes
      const marginOk = (slides[i].marginNotes || []).filter(
        (x) => x.trim().length > 12,
      ).length;
      if (marginOk < minMarginNotes) {
        issues.push({
          code: 'dense_margin_missing',
          detail: `Slide ${i + 1}: need ≥${minMarginNotes} substantive marginNotes callouts (tip / mistake / remember). Have ${marginOk}.`,
        });
      }
      
      // Check code snippets for technical topics
      const codeSnippetsCount = (slides[i].codeSnippets || []).filter(c => c.trim().length > 10).length;
      const isTechnicalTopic = /\b(code|programming|algorithm|data\s*structure|java|python|javascript|api|function|class|array|list|stack|queue|tree|graph|hash|leetcode|dsa)\b/i.test(topicLower);
      if (isTechnicalTopic && codeSnippetsCount < minCodeSnippetsForTech) {
        issues.push({
          code: 'dense_code_missing',
          detail: `Slide ${i + 1}: technical topics need ≥${minCodeSnippetsForTech} code snippet(s). Have ${codeSnippetsCount}.`,
        });
      }
      
      if (metrics.lineCount < denseLinesFloor) {
        issues.push({
          code: 'dense_slide_too_sparse',
          detail: `Slide ${i + 1}: need ≥${denseLinesFloor} substantive lines/bullets (have ${metrics.lineCount}). FILL THE PAGE with content.`,
        });
      }
      
      // Stricter character count requirements
      const minCharsDeck =
        expectedCount >= 10
          ? Math.max(600, DENSE_NOTEBOOK_QUALITY.minCharsLargeDeck)
          : Math.max(500, DENSE_NOTEBOOK_QUALITY.minCharsSmallDeck);
      if (metrics.totalChars < minCharsDeck) {
        issues.push({
          code: 'dense_chars_low',
          detail: `Slide ${i + 1}: insufficient characters (${metrics.totalChars} < ${minCharsDeck}). Add more detailed explanations.`,
        });
      }

      // Check body length - must be substantial
      if ((slides[i].body || '').trim().length < 150) {
        issues.push({
          code: 'dense_body_too_short',
          detail: `Slide ${i + 1}: body text too short (${(slides[i].body || '').trim().length} chars < 150). Add 3-5 complete sentences.`,
        });
      }

      const fill = estimateNotebookPageFillRatio({
        lineCount: metrics.lineCount,
        maxLines: DENSE_NOTEBOOK_QUALITY.assumedMaxLines,
      });
      const targetFillRatio = Math.max(0.7, DENSE_NOTEBOOK_QUALITY.minFillRatio);
      if (fill < targetFillRatio) {
        issues.push({
          code: 'dense_page_underfilled',
          detail: `Slide ${i + 1}: page density ${Math.round(fill * 100)}% < target ${Math.round(targetFillRatio * 100)}% — FILL THE PAGE with content.`,
        });
      }

      issues.push(...denseGenericLineIssues(i, structuredLines));
    }

    if (prompt.length < 24) {
      issues.push({
        code: 'image_prompt_weak',
        detail: `Slide ${i + 1} imagePrompt too short.`,
      });
    }

    const notebookStyleGate =
      resolvedVisualStyle &&
      isNotebookPaperCarouselStyle(resolvedVisualStyle);

    if (notebookStyleGate && resolvedVisualStyle) {
      const p = prompt.toLowerCase();
      const ok =
        /notebook|lined|ruled|dotted|paper|desk|study|journal|notepad|parchment|binder|margins|\bpaper\b.*\btexture\b|\btexture\b.*\bpaper\b|\b(?:note|desk)\s+page\b/.test(
          p,
        );
      const discouraged =
        /\b(?:steak|burger|coffee\s+cup\s+still\s+life|chef|restaurant\s+plating|trophy\s+celebration)\b/i.test(
          prompt,
        );
      if (!ok || discouraged) {
        issues.push({
          code: 'image_prompt_style_mismatch',
          detail: `Slide ${i + 1}: imagePrompt must describe a top-down notebook or study-paper page (ruled or dotted texture), not unrelated stock metaphors.`,
        });
      }
    }

    if (
      notebookStyleGate &&
      topicRequestsFilledHandwritingNotes(topicLower) &&
      expectedCount >= 8
    ) {
      const n = collectStructuredNotebookLines(slides[i]).length;
      const hwMin = expectedCount >= 12 ? 6 : 7;
      if (n < hwMin) {
        issues.push({
          code: 'handwriting_slide_line_budget_low',
          detail: `Slide ${i + 1}: prompt requests filled handwritten study pages — need ≥${hwMin} teaching lines from body, bullets, notebookSections, denseBullets, and code (have ${n}).`,
        });
      }
    }

    /* programming template per slide hints */
    if (programmingMode && noteDensity === 'dense' && slides[i].notebookSections?.length) {
      const headings = slides[i]
        .notebookSections!.map((s) => `${s.subheading || ''}`)
        .join(' ')
        .toLowerCase();
      let hit = 0;
      if (/\bconcept|definition|what\b/.test(headings)) hit++;
      if (/\bpitfall|mistake|watch|gotcha|trap\b/.test(headings)) hit++;
      if (/\bcomplexity|big-? ?o|perf|latency\b/.test(headings)) hit++;
      if (/\b(java|pseudo|snippet|example|idea)\b/.test(headings)) hit++;
      const codeOnSlide = (slides[i].codeSnippets ?? []).some((c) => c.trim().length > 8);
      if (hit < 2 && !codeOnSlide) {
        issues.push({
          code: 'programming_section_hints_missing',
          detail: `Slide ${i + 1}: programming+dense decks need section cues (≥2 of concept/pitfalls/complexity/Java) or a substantive codeSnippets line.`,
        });
      }
    }
  }

  if (
    resolvedVisualStyle &&
    isNotebookPaperCarouselStyle(resolvedVisualStyle) &&
    topicRequestsFilledHandwritingNotes(topicLower) &&
    slides.length >= 10
  ) {
    let sum = 0;
    for (const s of slides) {
      sum += collectStructuredNotebookLines(s).length;
    }
    const avg = sum / slides.length;
    if (avg < 6) {
      issues.push({
        code: 'handwriting_deck_avg_sparse',
        detail: `Average teaching items per slide is ${avg.toFixed(1)} — target ≥6 for full study-note carousels.`,
      });
    }
  }

  if (topicTokens.length >= 2 && slides.length > 0 && noteDensity !== 'compact') {
    let weakRelevance = 0;
    for (const slide of slides) {
      const blob = `${slide.title} ${slide.body}`.toLowerCase();
      const hits = topicTokens.filter((t) => blob.includes(t)).length;
      if (hits < 1) weakRelevance++;
    }
    if (weakRelevance > Math.ceil(slides.length * 0.4)) {
      issues.push({
        code: 'topic_drift',
        detail:
          'Too many slides do not reflect key terms from the user topic (possible generic filler).',
      });
    }
  }

  const normalizedBodies = bodies.map((b) => b.replace(/\s+/g, ' ').toLowerCase());
  for (let i = 1; i < normalizedBodies.length; i++) {
    if (
      normalizedBodies[i].length > 20 &&
      normalizedBodies[i] === normalizedBodies[i - 1]
    ) {
      issues.push({
        code: 'repeated_slides',
        detail: `Slides ${i} and ${i + 1} have nearly identical body text.`,
      });
      break;
    }
  }

  if (dsInterviewTopic(topicLower) && slides.length >= 8) {
    const deckBlob = slides
      .map((s) => {
        const b = (s.bullets ?? []).join(' ');
        const db = (s.denseBullets ?? []).join(' ');
        const code = (s.codeSnippets ?? []).join(' ');
        const structured = collectStructuredNotebookLines(s).join(' ');
        return `${s.title} ${s.body} ${b} ${db} ${code} ${structured}`;
      })
      .join(' ')
      .toLowerCase();
    const requiredJava = /\bjava\b/.test(topicLower);
    if (requiredJava && !/\bjava\b/.test(deckBlob)) {
      issues.push({
        code: 'topic_keywords_weak',
        detail: 'Topic mentions Java but few slides reference Java specifically.',
      });
    }
    let hits = 0;
    for (const term of JAVA_DSA_DECK_TERMS) {
      if (deckBlob.includes(term)) hits++;
    }
    const minHits = slideCountHeuristic(expectedCount);
    if (hits < minHits) {
      issues.push({
        code: 'topic_keywords_weak',
        detail: `Deck should cover core DSA interview themes (arrays, lists, stacks, queues, hashing, trees, heaps, graphs, recursion/DP, Big-O, LeetCode patterns). Only ${hits} theme hits — need broader coverage.`,
      });
    }
  }

  if (programmingMode && slides.length >= 6 && noteDensity !== 'compact') {
    const need = Math.max(3, Math.ceil(slides.length * 0.45));
    if (programmingSurfaceHits < need) {
      issues.push({
        code: 'programming_surface_weak',
        detail: `Programming mode expects ≥${need} slides with code/complexity/pitfall/snippet cues; matched ${programmingSurfaceHits}.`,
      });
    }
  }

  return issues;
}

/** Quality codes we never waive with the minimum-ship escape hatch */
const CAROUSEL_MIN_SHIP_BLOCKING_CODES = new Set<string>([
  'slide_count',
  'duplicate_heading',
  'placeholder_title',
  'placeholder_body',
  'title_too_short',
  'body_too_short',
  'topic_drift',
  'repeated_slides',
  'topic_keywords_weak',
  'image_prompt_style_mismatch',
  'image_prompt_weak',
  'bullets_count',
  'bullet_too_short',
  'bullets_missing',
  'dense_low_information_lines',
  'dense_repeated_lines',
  'programming_surface_weak',
  'dense_slide_too_sparse',
  'dense_chars_low',
  'dense_bullets_sparse',
  'dense_densebullets_sparse',
  'dense_margin_missing',
  'dense_code_missing',
  'dense_body_too_short',
  'dense_page_underfilled',
  'dense_missing_sections',
]);

/**
 * Accept only when structural minimums hold so we never ship empty/placeholder decks,
 * but allow a narrowed bar after deterministic expansion + one model retry.
 */
export function meetsMinimumShippableCarousel(params: {
  slides: Array<{
    title: string;
    body: string;
    imagePrompt: string;
    bullets?: string[];
    denseBullets?: string[];
    codeSnippets?: string[];
    notebookSections?: Array<{
      subheading?: string;
      lines: string[];
      bulletItems?: string[];
    }>;
    marginNotes?: string[];
  }>;
  expectedCount: number;
  noteDensity?: CarouselNoteDensityLevel;
  programmingModeEffective?: boolean;
  /** Remaining analyzer issues — used to block “ship anyway” for serious codes */
  remainingIssues?: CarouselQualityIssue[];
}): boolean {
  const { slides, expectedCount, programmingModeEffective, remainingIssues } = params;
  const noteDensity: CarouselNoteDensityLevel = params.noteDensity ?? 'standard';

  if (remainingIssues?.some((i) => CAROUSEL_MIN_SHIP_BLOCKING_CODES.has(i.code))) {
    return false;
  }

  if (slides.length !== expectedCount) return false;

  for (let i = 0; i < slides.length; i++) {
    const title = (slides[i].title || '').trim();
    const body = (slides[i].body || '').trim();
    if (title.length < 4 || looksLikePlaceholderTitle(title)) return false;
    if (body.length < 28) return false;
    const prompt = (slides[i].imagePrompt || '').trim();
    if (prompt.length < 16) return false;

    if (noteDensity === 'dense') {
      const metrics = countDenseSlideContentMetrics({
        body: slides[i].body,
        bullets: slides[i].bullets,
        denseBullets: slides[i].denseBullets,
        codeSnippets: slides[i].codeSnippets,
        notebookSections: slides[i].notebookSections,
        marginNotes: slides[i].marginNotes,
      });
      // STRICTER minimum: 12 lines and 400 chars for dense mode
      if (metrics.lineCount < 12 || metrics.totalChars < 400) return false;
      // Need at least 3 sections for proper organization
      if ((slides[i].notebookSections?.length ?? 0) < 3) return false;
      // Need at least 2 margin notes
      const marginOk = (slides[i].marginNotes || []).filter((x) => x.trim().length > 10).length;
      if (marginOk < 2) return false;
      // Need at least 6 substantial bullets
      const bulletsOk = (slides[i].bullets || []).filter((x) => x.trim().length > 20).length;
      if (bulletsOk < 6) return false;
      // Body must be substantial
      if ((slides[i].body || '').trim().length < 100) return false;
    }
  }

  if (programmingModeEffective && noteDensity !== 'compact') {
    let programmingSurfaceHits = 0;
    for (const s of slides) {
      const bullets = Array.isArray(s.bullets)
        ? s.bullets!.map((b) => String(b).trim()).filter(Boolean)
        : [];
      const slideBlob = `${s.title}\n${s.body}\n${bullets.join(' ')}\n${(s.denseBullets ?? []).join(' ')}\n${(s.codeSnippets ?? []).join(' ')}\n${collectStructuredNotebookLines(s).join(' ')}`;
      if (analyzeProgrammingCarouselSurface(slideBlob)) programmingSurfaceHits++;
    }
    const need = Math.max(2, Math.ceil(slides.length * 0.28));
    if (programmingSurfaceHits < need) return false;
  }

  return true;
}

export function buildCarouselStrictRetryInstruction(
  issues: CarouselQualityIssue[],
  opts: {
    noteDensity?: CarouselNoteDensityLevel;
    programmingModeEffective?: boolean;
  },
): string {
  const dens = opts.noteDensity ?? 'standard';
  const prog = Boolean(opts.programmingModeEffective);

  const denseBullets =
    dens === 'dense'
      ? [
          '',
          '=== CRITICAL: MAXIMUM DENSITY REQUIRED ===',
          'YOUR SLIDES WERE TOO SPARSE. EACH SLIDE MUST BE COMPLETELY FILLED.',
          '',
          'MINIMUM REQUIREMENTS PER SLIDE:',
          '- body: 3-5 COMPLETE SENTENCES (100-200 words) with real explanations, not one-liners',
          '- bullets[]: 8-12 substantive teaching points (each ≥25 chars with REAL information)',
          '- denseBullets[]: 4-8 quick-reference items, tips, or examples',
          '- notebookSections[]: 3-5 organized sections with subheadings:',
          '  - Each section MUST have: subheading + 4-8 teaching lines + 3-5 bulletItems',
          '  - Section types: Definition, Examples, Common Mistakes, Pro Tips, Code Example, etc.',
          '- marginNotes[]: 3-5 callouts (tips / mistakes / Big-O / "Remember:" / "Pro tip:")',
          '- codeSnippets[]: 1-3 real code examples for technical topics (working syntax)',
          '',
          'CONTENT QUALITY:',
          '- NO generic filler like "Important concept" or "Key point"',
          '- Include SPECIFIC examples, numbers, comparisons, edge cases',
          '- Each bullet must teach something CONCRETE and USEFUL',
          '- Total: 15-25 substantive teaching lines per slide MINIMUM',
        ]
      : [
          '',
          '=== CONTENT DENSITY REQUIRED ===',
          'YOUR SLIDES WERE TOO SPARSE. ADD MORE CONTENT:',
          '- body: 2-4 complete sentences with real explanations',
          '- bullets[]: 6-10 substantive teaching points',
          '- Include specific examples, numbers, and real information',
        ];

  const programmingBullets =
    prog && dens === 'dense'
      ? [
          '',
          'PROGRAMMING DECK REQUIREMENTS:',
          '- Every slide MUST have code snippets with real syntax',
          '- Section subheadings MUST include: Definition, Language Specifics, Time/Space Complexity, Common Pitfalls, Interview Tips',
          '- Include Big-O notation for all relevant operations',
          '- Show edge cases and common bugs',
        ]
      : prog
        ? ['', '- Include language-specific code examples, Big-O, and common pitfalls.']
        : [];

  return [
    'QUALITY REWRITE REQUIRED — your previous carousel FAILED automated quality checks.',
    '',
    'ISSUES FOUND:',
    ...issues.map((x) => `- [${x.code}] ${x.detail}`),
    '',
    'YOU MUST REWRITE THE ENTIRE JSON OUTPUT WITH MUCH MORE CONTENT:',
    '- Produce EXACTLY the requested number of slides.',
    '- Each slide title must be a specific, descriptive lesson heading (not "Carousel slide N").',
    '- Progressive pedagogical ladder for tutorials.',
    '- imagePrompt: TEXT-FREE base background only.',
    ...denseBullets,
    ...programmingBullets,
    '',
    dens === 'dense'
      ? 'REQUIRED JSON FIELDS PER SLIDE: title, body (3-5 sentences), bullets[] (8-12 items), denseBullets[] (4-8 items), notebookSections[] (3-5 sections with subheading, lines[], bulletItems[]), marginNotes[] (3-5 callouts), codeSnippets[] (1-3 for tech topics), imagePrompt.'
      : 'Required: title, body (2-4 sentences), bullets[] (6-10 items), imagePrompt.',
    '',
    'SPARSE CONTENT WILL BE REJECTED AGAIN. FILL EVERY SLIDE COMPLETELY.',
    '',
    'Return ONLY valid JSON matching the schema.',
  ].join('\n');
}
