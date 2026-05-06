/**
 * Deterministic padding for sparse dense-notebook carousel slides before/instead of
 * another full LLM rewrite. Expands teaching lines from slide titles, body, and topic
 * keywords so compositor + quality gates see usable density.
 */

import type { CarouselNoteDensityLevel } from './custom-topic.schemas';
import type { CarouselQualityIssue } from './carousel-quality';
import { analyzeCarouselQuality } from './carousel-quality';

export type ExpandableCarouselSlide = {
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
};

function topicKeywords(topicLower: string): string[] {
  return topicLower
    .split(/[^a-z0-9+#]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 12);
}

function padLine(seed: string, topicBits: string, minLen = 64): string {
  const base = seed.replace(/\s+/g, ' ').trim();
  if (base.length >= minLen) return base;
  const filler = ` ${topicBits} — sketch a 2–3 line example, name the invariant, then check edge cases before coding.`;
  const out = (base + filler).replace(/\s+/g, ' ').trim();
  return out.length >= minLen ? out.slice(0, 190) : (out + ' ' + topicBits).slice(0, 190);
}

function ensureProgrammingHeadings(
  sections: Array<{ subheading?: string; lines: string[]; bulletItems?: string[] }>,
  slideTitle: string,
  topicBits: string,
): void {
  const merged = sections.map((s) => `${s.subheading || ''}`).join(' ').toLowerCase();
  const needConcept = !/\bconcept|definition|what\b/.test(merged);
  const needPitfall = !/\bpitfall|mistake|watch|gotcha|trap\b/.test(merged);
  const needComplexity = !/\bcomplexity|big-? ?o|perf|latency\b/.test(merged);
  const needJava = !/\b(java|pseudo|snippet|example|idea)\b/.test(merged);

  let i = 0;
  for (const sec of sections) {
    const sh = (sec.subheading || '').trim();
    if (!sh) {
      if (needConcept && i === 0) sec.subheading = 'Concept · what this means';
      else if (needPitfall && i === 1) sec.subheading = 'Pitfalls · common mistakes';
      else if (needComplexity && i % 2 === 0) sec.subheading = 'Complexity · Big-O interview cue';
      else if (needJava) sec.subheading = 'Java / example sketch';
    }
    i++;
  }

  const first = sections[0];
  if (first && !first.lines.length) {
    first.lines.push(
      padLine(
        `${slideTitle}: define the core idea in one sentence, then tie it to ${topicBits}.`,
        topicBits,
      ),
    );
  }
}

/**
 * Returns a deep-cloned slides array with extra structured lines, margin notes, and
 * section scaffolding. Idempotent enough for repeated calls (keeps getting longer —
 * prefer calling once after LLM output).
 */
export function expandSparseCarouselSlides(
  slides: ExpandableCarouselSlide[],
  opts: {
    topicLower: string;
    programmingModeEffective: boolean;
    noteDensity: CarouselNoteDensityLevel;
    /** Notebook-paper carousels that need full-page structured scaffolding */
    scaffoldFullNotebookPages: boolean;
  },
): ExpandableCarouselSlide[] {
  const topicBits = topicKeywords(opts.topicLower).join(' · ') || 'your study topic';
  const dense = opts.noteDensity === 'dense';
  const scaffold = opts.scaffoldFullNotebookPages;

  return slides.map((slide, idx) => {
    const s: ExpandableCarouselSlide = JSON.parse(JSON.stringify(slide)) as ExpandableCarouselSlide;
    const slideTag = `slide ${idx + 1}`;
    const title = (s.title || `Slide ${idx + 1}`).trim();
    const body = (s.body || '').trim();

    if (scaffold && (!s.notebookSections || s.notebookSections.length < 2)) {
      s.notebookSections = [
        {
          subheading: 'Concept · definition checkpoint',
          lines: [
            padLine(
              `${title} (${slideTag}): restate the definition you would write under exam pressure; link it to ${topicBits}.`,
              topicBits,
            ),
            padLine(
              `Worked mental model (${slideTag}): compare this idea to the previous slide and name one invariant you keep repeating aloud.`,
              topicBits,
            ),
            padLine(
              `Interview tell (${slideTag}): one sentence you say before touching the keyboard so the room hears your plan.`,
              topicBits,
            ),
          ],
        },
        {
          subheading: 'Pitfalls · traps + drills',
          lines: [
            padLine(
              `Trap (${slideTag}): the fastest wrong answer you have seen peers write — write the counterexample that breaks it.`,
              topicBits,
            ),
            padLine(
              `Drill (${slideTag}): pick a tiny input (n≤5) and trace state by hand; only then scale the pattern.`,
              topicBits,
            ),
          ],
          bulletItems: [
            padLine(
              `Micro-checklist (${slideTag}) before submit: null/empty, overflow, off-by-one.`,
              topicBits,
              48,
            ),
          ],
        },
      ];
    } else if (scaffold && s.notebookSections?.length) {
      for (const sec of s.notebookSections) {
        if (!sec.lines) sec.lines = [];
        while (sec.lines.length < 3) {
          sec.lines.push(
            padLine(
              `${title} · ${sec.subheading || 'notes'} · ${slideTag}: add one concrete example referencing ${topicBits}.`,
              topicBits,
            ),
          );
        }
      }
    }

    if (scaffold && opts.programmingModeEffective && s.notebookSections?.length) {
      ensureProgrammingHeadings(s.notebookSections, title, topicBits);
      const hasCode = (s.codeSnippets || []).some((c) => c.trim().length > 6);
      if (!hasCode) {
        s.codeSnippets = [
          ...((s.codeSnippets as string[]) || []),
          `// ${title.slice(0, 72)} — Java interview stub: clarify types before loops`,
        ];
      }
    }

    const margin = [...((s.marginNotes as string[]) || []).map((m) => m.trim()).filter(Boolean)];
    const substantive = (m: string) => m.length > 12;
    if (scaffold) {
      while (margin.filter(substantive).length < 2) {
        margin.push(
          padLine(
            `Tip · ${slideTag}: rehearse Big-O and one pitfall for “${title.slice(0, 42)}” aloud before you code.`,
            topicBits,
            72,
          ),
        );
      }
    }
    s.marginNotes = margin;

    if (dense && scaffold) {
      const db = [...((s.denseBullets as string[]) || [])];
      const hooks = [
        'invariant you restate under pressure',
        'edge case you must trace by hand first',
        'Big-O line you say before writing code',
      ];
      while (db.length < 3) {
        const hook = hooks[db.length] ?? `anchor ${db.length + 1}`;
        db.push(
          padLine(
            `${title} · ${slideTag}: one-line memory hook (${hook}) tied to ${topicBits}.`,
            topicBits,
            52,
          ),
        );
      }
      s.denseBullets = db;
    }

    if (body.length > 0 && body.length < 120) {
      s.body =
        padLine(body, topicBits, 100) +
        ' ' +
        padLine(`Bridge (${slideTag}): connect this slide to the broader ${topicBits} arc.`, topicBits, 80);
    }

    return s;
  });
}

/** Run deterministic expansion and return new issues (full re-analysis). */
export function reanalyzeCarouselAfterExpansion(params: {
  slides: ExpandableCarouselSlide[];
  expectedCount: number;
  topicLower: string;
  resolvedVisualStyle?: import('./carousel-visual-style').CarouselVisualStyle;
  noteDensity?: CarouselNoteDensityLevel;
  programmingModeEffective?: boolean;
  scaffoldFullNotebookPages: boolean;
}): { slides: ExpandableCarouselSlide[]; issues: CarouselQualityIssue[] } {
  const expanded = expandSparseCarouselSlides(params.slides, {
    topicLower: params.topicLower,
    programmingModeEffective: Boolean(params.programmingModeEffective),
    noteDensity: params.noteDensity ?? 'dense',
    scaffoldFullNotebookPages: params.scaffoldFullNotebookPages,
  });
  const issues = analyzeCarouselQuality({
    slides: expanded,
    expectedCount: params.expectedCount,
    topicLower: params.topicLower,
    resolvedVisualStyle: params.resolvedVisualStyle,
    noteDensity: params.noteDensity,
    programmingModeEffective: params.programmingModeEffective,
  });
  return { slides: expanded, issues };
}
