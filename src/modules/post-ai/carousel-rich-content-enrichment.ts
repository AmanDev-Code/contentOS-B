/**
 * Post-generation enrichment for carousel slides.
 *
 * The LLM frequently skips optional rich fields (codeSnippet, complexity,
 * diagramSpec, tipBoxes) even when the prompt asks for them — especially on the
 * first pass. Rather than burning a second OpenAI round-trip per slide, we
 * deterministically harvest those fields from the text the model already wrote
 * (bullets, denseBullets, paragraph, body, notebookSections.lines).
 *
 * This pass is idempotent and never overwrites fields the model already filled.
 * It runs unconditionally for both legacy carousels and document-deck presets,
 * but only enriches body slides (sectionType === 'body' or undefined for legacy).
 *
 * Goals:
 *   - For DSA / programming topics: surface a `codeSnippet` from triple-backtick
 *     fences, language-tagged blocks, or `<lang>:` headers in the text so the
 *     renderer's code panel actually appears.
 *   - For algorithmic topics: lift a `complexity` line out of any bullet
 *     containing "O(...)" / "Time:" / "Space:" patterns so the colored strip
 *     renders.
 *   - For comparative topics: synthesize a `comparison-table` diagramSpec from
 *     "Name: detail" / "Name — detail" bullets so a slide always has at least
 *     one structural visual element instead of a wall of bullets.
 *   - For "tip"-flagged bullets ("Pro tip:", "Common mistake:", "Remember:"):
 *     promote them to a `tipBoxes` callout.
 *
 * Defensive design: never throws. On any unexpected input shape we return the
 * original slide unchanged so the renderer still gets valid data.
 */

import type {
  CarouselPostOutput,
  CarouselSlideOutput,
  CodeSnippetObject,
  DiagramSpec,
  TipBox,
} from './custom-topic.schemas';

/* ------------------------------------------------------------------------- */
/* Topic classification (used to gate aggressive enrichment for educational  */
/* / programming decks where rich fields are most expected).                  */
/* ------------------------------------------------------------------------- */

const PROGRAMMING_TOPIC_RE =
  /\b(algorithm|data\s*structure|dsa|leetcode|interview|programming|coding|java(?:script)?\b|python|typescript|c\+{2}|cpp|kotlin|swift|rust|go(?:lang)?|ruby|sql|api|backend|frontend|recursion|big[\s-]?o|complexity|hashmap|linked\s*list|sorting|graph|tree|stack|queue|heap|dp|dynamic\s+programming)\b/i;

const COMPARISON_TOPIC_RE =
  /\b(vs\.?|versus|compare|comparison|trade-?offs?|cheat\s*sheet|differences?|side\s*by\s*side)\b/i;

export function topicWantsCodeRichContent(topicLower: string): boolean {
  return PROGRAMMING_TOPIC_RE.test(topicLower);
}

export function topicWantsComparisonDiagram(topicLower: string): boolean {
  return (
    COMPARISON_TOPIC_RE.test(topicLower) ||
    topicWantsCodeRichContent(topicLower)
  );
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

function safeText(s: unknown): string {
  return typeof s === 'string' ? s : '';
}

function collectAllText(slide: CarouselSlideOutput): string {
  const parts: string[] = [];
  parts.push(safeText(slide.title));
  parts.push(safeText(slide.body));
  parts.push(safeText(slide.paragraph));
  for (const b of slide.bullets ?? []) parts.push(safeText(b));
  for (const b of slide.denseBullets ?? []) parts.push(safeText(b));
  for (const m of slide.marginNotes ?? []) parts.push(safeText(m));
  for (const c of slide.codeSnippets ?? []) parts.push(safeText(c));
  for (const sec of slide.notebookSections ?? []) {
    parts.push(safeText(sec.subheading));
    for (const ln of sec.lines ?? []) parts.push(safeText(ln));
    for (const ln of sec.bulletItems ?? []) parts.push(safeText(ln));
  }
  return parts.filter((s) => s && s.trim()).join('\n');
}

/** Match triple-backtick fenced code blocks with optional language tag. */
const FENCED_CODE_RE = /```([a-zA-Z+#0-9_-]{0,30})?\s*\n?([\s\S]*?)```/m;
/** Match the very common LLM pattern: "java\nSystem.out.println(...);" — short header followed by a code-shaped line. */
const LANGUAGE_HEADER_RE =
  /^(?:python|java|javascript|typescript|c\+{2}|cpp|c|kotlin|swift|rust|go|ruby|php|scala|sql|bash|sh|pseudocode|pseudo)(?:\s*:|\s*\n)/i;
/** Match Big-O / complexity-style strings inside a bullet. */
const COMPLEXITY_RE =
  /(?:Time(?:\s+complexity)?\s*:?\s*O\([^)]+\))(?:[\s,;·-]+(?:Space(?:\s+complexity)?\s*:?\s*O\([^)]+\)))?|(?:Space(?:\s+complexity)?\s*:?\s*O\([^)]+\))(?:[\s,;·-]+(?:Time(?:\s+complexity)?\s*:?\s*O\([^)]+\)))?|O\([^)]+\)\s*(?:time|space|amortized|worst|avg|average|best)\b/i;
const STANDALONE_BIGO_RE = /\bO\([0-9a-zA-Z*\s+^/log!()-]+\)\s*$/;

/** Match "Pro tip:", "Tip:", "Warning:", "Common mistake:", etc. */
const TIP_PREFIX_RE =
  /^\s*(?:💡\s*)?(pro\s+tip|tip|hot\s+tip|warning|⚠️|caution|danger|note|info|fyi|common\s+mistake|gotcha|mistake|interview\s+(?:hack|tip)|remember(?:[: ]|$)|hack|hint)[\s:—-]*/i;

/** Heuristic: split a bullet on the first " — ", " - ", or ":" pair into name + detail. */
function splitNameDetail(raw: string): { name: string; detail: string } | null {
  const text = raw.trim();
  if (!text) return null;
  // Prefer em-dash / en-dash separator (less likely to produce false positives like "url: https://...").
  const dashMatch = text.match(/^(.{2,40}?)\s+[—–-]\s+(.+)$/);
  if (dashMatch) {
    const name = dashMatch[1].trim();
    const detail = dashMatch[2].trim();
    if (name && detail && /[a-zA-Z0-9]/.test(name)) {
      return { name, detail };
    }
  }
  // Colon separator: only when LHS is short and not URL-like.
  const colonMatch = text.match(/^([^:]{2,40}):\s+(.+)$/);
  if (colonMatch) {
    const name = colonMatch[1].trim();
    const detail = colonMatch[2].trim();
    if (
      name &&
      detail &&
      /[a-zA-Z]/.test(name) &&
      !/^(https?|www|file|ftp)$/i.test(name) &&
      // Avoid pure code like "var x: int = 5"
      !/^\s*(let|const|var|fn|def|class|public|private|protected|static)\s/i.test(
        name,
      )
    ) {
      return { name, detail };
    }
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Code snippet extraction                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Best-effort: pull a code-looking block out of the slide's text fields.
 * Strategy (first match wins):
 *   1. Triple-backticks fenced block in any text field.
 *   2. A `codeSnippets[]` legacy entry that looks like multi-line code.
 *   3. A bullet that starts with a language header (e.g. "java\n…").
 *   4. A multi-line bullet/paragraph with code-shaped tokens.
 */
function extractCodeSnippet(
  slide: CarouselSlideOutput,
): CodeSnippetObject | null {
  const blob = collectAllText(slide);
  const fenced = blob.match(FENCED_CODE_RE);
  if (fenced) {
    const lang = (fenced[1] || '').trim() || 'text';
    const code = (fenced[2] || '').replace(/\r/g, '').trim();
    if (code.length >= 6) {
      return { language: lang.slice(0, 30), code };
    }
  }

  // Legacy strings — promote the longest non-trivial entry.
  const legacy = (slide.codeSnippets ?? [])
    .map((c) => safeText(c))
    .filter((c) => c.trim().length >= 8)
    .sort((a, b) => b.length - a.length);
  if (legacy.length > 0) {
    const code = legacy[0].trim();
    return { language: inferLanguageFromCode(code), code };
  }

  // Language-header bullets.
  for (const candidate of (slide.bullets ?? []).concat(
    slide.denseBullets ?? [],
  )) {
    const t = safeText(candidate);
    const headerMatch = t.match(/^(\w{2,16})\s*:\s*([\s\S]+)$/);
    if (
      headerMatch &&
      /^(python|java|javascript|typescript|cpp|c\+{2}|c|kotlin|swift|rust|go|ruby|php|scala|sql|bash|sh|pseudocode|pseudo)$/i.test(
        headerMatch[1],
      )
    ) {
      const lang = headerMatch[1].toLowerCase();
      const code = headerMatch[2].trim();
      if (code.length >= 8 && /[(){};=]|->/.test(code)) {
        return { language: lang, code };
      }
    }
    if (LANGUAGE_HEADER_RE.test(t) && /[(){};=]|->/.test(t)) {
      const lang = (t.match(/^(\w+)/)?.[1] || 'code').toLowerCase();
      const code = t.replace(LANGUAGE_HEADER_RE, '').trim();
      if (code.length >= 8) {
        return { language: lang, code };
      }
    }
  }

  return null;
}

function inferLanguageFromCode(code: string): string {
  if (/\bSystem\.out\.|public\s+(?:static|class)|@Override|->\s*\{/.test(code))
    return 'java';
  if (/\bdef\s+\w+\(|self\.|->\s*[A-Z]\w*:/.test(code)) return 'python';
  if (
    /\bconst\s+\w+\s*=|=>\s*[\w(]|console\.log|interface\s+\w+\s*\{/.test(code)
  ) {
    return code.includes(': ') || code.includes('interface ')
      ? 'typescript'
      : 'javascript';
  }
  if (/std::|cout\s*<<|::\s*[a-z]/.test(code)) return 'cpp';
  if (/SELECT\s+|FROM\s+\w+|WHERE\s+/i.test(code)) return 'sql';
  return 'code';
}

/* ------------------------------------------------------------------------- */
/* Complexity extraction                                                     */
/* ------------------------------------------------------------------------- */

function extractComplexity(slide: CarouselSlideOutput): string | null {
  const candidates: string[] = [];
  for (const b of slide.bullets ?? []) candidates.push(safeText(b));
  for (const b of slide.denseBullets ?? []) candidates.push(safeText(b));
  for (const m of slide.marginNotes ?? []) candidates.push(safeText(m));
  candidates.push(safeText(slide.body), safeText(slide.paragraph));
  for (const sec of slide.notebookSections ?? []) {
    for (const ln of sec.lines ?? []) candidates.push(safeText(ln));
    for (const ln of sec.bulletItems ?? []) candidates.push(safeText(ln));
  }

  type ComplexityHit = { score: number; text: string };
  const hits: ComplexityHit[] = [];
  for (const raw of candidates) {
    const text = raw?.trim();
    if (!text) continue;
    const hasTime = /\bTime\b/i.test(text);
    const hasSpace = /\bSpace\b/i.test(text);
    const m = text.match(COMPLEXITY_RE);
    if (m) {
      // Prefer the whole bullet when it includes both Time + Space + reasonable length.
      if (text.length <= 140 && hasTime && hasSpace) {
        hits.push({ score: 100, text: text.replace(/\s+/g, ' ') });
        continue;
      }
      const matched = m[0].replace(/\s+/g, ' ').trim();
      // Score: explicit Time/Space label > complexity-keyword tail > raw match.
      let score = 30;
      if (/\bTime\b/i.test(matched)) score += 20;
      if (/\bSpace\b/i.test(matched)) score += 20;
      hits.push({ score, text: matched });
      continue;
    }
    // Standalone tail O(...) — only count when accompanied by Time/Space label.
    const tail = text.match(STANDALONE_BIGO_RE);
    if (tail && (hasTime || hasSpace) && text.length <= 140) {
      hits.push({ score: 25, text: text.replace(/\s+/g, ' ') });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.score - a.score);
  return hits[0].text.trim();
}

/* ------------------------------------------------------------------------- */
/* Tip box extraction                                                        */
/* ------------------------------------------------------------------------- */

function extractTipBoxes(slide: CarouselSlideOutput, max = 2): TipBox[] {
  const out: TipBox[] = [];
  const sources: string[] = [];
  for (const b of slide.bullets ?? []) sources.push(safeText(b));
  for (const b of slide.denseBullets ?? []) sources.push(safeText(b));
  for (const m of slide.marginNotes ?? []) sources.push(safeText(m));

  for (const raw of sources) {
    if (out.length >= max) break;
    const text = raw.trim();
    if (text.length < 10) continue;
    const match = text.match(TIP_PREFIX_RE);
    if (!match) continue;
    const headerRaw = (match[1] || '').toLowerCase();
    const accent = /warning|caution|danger|⚠️/.test(headerRaw)
      ? 'warning'
      : /info|note|fyi/.test(headerRaw)
        ? 'info'
        : /mistake|gotcha/.test(headerRaw)
          ? 'warning'
          : 'tip';
    const cleaned = text.replace(TIP_PREFIX_RE, '').trim();
    if (cleaned.length < 6) continue;
    // Title = the matched flag, capitalized; body = the rest.
    const title =
      headerRaw
        .replace(/[^a-z\s]/g, '')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .slice(0, 36) || 'Tip';
    out.push({ title, body: cleaned.slice(0, 220), accent });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Diagram synthesis (comparison-table fallback)                             */
/* ------------------------------------------------------------------------- */

/**
 * Synthesize a comparison-table diagramSpec from "Name — Detail" / "Name: Detail"
 * patterns in bullets. Returns null when fewer than 2 rows match (avoiding
 * useless one-row tables).
 */
function synthesizeComparisonTableDiagram(
  slide: CarouselSlideOutput,
): DiagramSpec | null {
  const seenNames = new Set<string>();
  const rows: { label: string; color?: string }[] = [];
  const rawBullets = [
    ...(slide.bullets ?? []),
    ...(slide.denseBullets ?? []),
  ].map((b) => safeText(b));
  for (const b of rawBullets) {
    if (rows.length >= 6) break;
    const split = splitNameDetail(b);
    if (!split) continue;
    const key = split.name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    // Reject super-long names (likely a sentence with embedded colon).
    if (split.name.length > 36) continue;
    if (split.detail.length < 4) continue;
    rows.push({
      label: `${split.name} — ${split.detail}`,
    });
  }
  if (rows.length < 3) return null;
  return {
    type: 'comparison-table',
    title: safeText(slide.title)?.slice(0, 60) || 'Comparison',
    elements: rows.slice(0, 5),
  };
}

/* ------------------------------------------------------------------------- */
/* Per-slide enrichment                                                      */
/* ------------------------------------------------------------------------- */

export interface EnrichmentOptions {
  topicLower: string;
  /** Document-deck preset is active (handwritten_notes / structured_document). */
  documentMode?: 'handwritten_notes' | 'structured_document';
}

function isBodySlide(slide: CarouselSlideOutput): boolean {
  if (!slide.sectionType) return true; // Legacy carousels lack sectionType.
  return slide.sectionType === 'body';
}

export interface EnrichmentResult {
  slidesEnriched: number;
  fieldsAdded: {
    codeSnippet: number;
    complexity: number;
    diagramSpec: number;
    tipBoxes: number;
  };
}

/**
 * Mutate-in-place enrichment for an entire carousel deck. Returns counts so the
 * caller can decide whether to trigger a strict-retry round (very low yield ⇒
 * the model returned almost no usable structured content).
 */
export function enrichCarouselDeckRichContent(
  output: Pick<CarouselPostOutput, 'slides'>,
  opts: EnrichmentOptions,
): EnrichmentResult {
  const result: EnrichmentResult = {
    slidesEnriched: 0,
    fieldsAdded: {
      codeSnippet: 0,
      complexity: 0,
      diagramSpec: 0,
      tipBoxes: 0,
    },
  };
  const slides = Array.isArray(output.slides) ? output.slides : [];
  const wantCode = topicWantsCodeRichContent(opts.topicLower);
  const wantDiagram = topicWantsComparisonDiagram(opts.topicLower);
  const isDocumentDeck = Boolean(opts.documentMode);

  for (const slide of slides) {
    if (!slide || typeof slide !== 'object') continue;
    if (!isBodySlide(slide)) continue;
    let touched = false;

    if (!slide.codeSnippet) {
      const code = extractCodeSnippet(slide);
      if (code) {
        slide.codeSnippet = code;
        result.fieldsAdded.codeSnippet++;
        touched = true;
      }
    }

    if (!slide.complexity) {
      const c = extractComplexity(slide);
      if (c) {
        slide.complexity = c;
        result.fieldsAdded.complexity++;
        touched = true;
      }
    }

    if (!slide.tipBoxes || slide.tipBoxes.length === 0) {
      const tips = extractTipBoxes(slide, isDocumentDeck ? 2 : 1);
      if (tips.length > 0) {
        slide.tipBoxes = tips;
        result.fieldsAdded.tipBoxes++;
        touched = true;
      }
    }

    // Only synthesize a diagram if the topic suggests one would help AND the
    // slide actually has comparable bullet shapes. This avoids noisy one-row
    // tables on storytelling decks.
    if (
      !slide.diagramSpec &&
      (wantDiagram || isDocumentDeck) &&
      (slide.bullets?.length ?? 0) >= 3
    ) {
      const diagram = synthesizeComparisonTableDiagram(slide);
      if (diagram) {
        slide.diagramSpec = diagram;
        result.fieldsAdded.diagramSpec++;
        touched = true;
      }
    }

    if (touched) {
      result.slidesEnriched++;
    }
    void wantCode; // documented for future per-slide language defaulting.
  }

  return result;
}

/**
 * Lightweight scoring used by the service to decide whether to re-prompt the
 * model. Counts how many rich fields each body slide has filled (after
 * deterministic enrichment).
 */
export function scoreCarouselRichness(
  output: Pick<CarouselPostOutput, 'slides'>,
): { averageRichScore: number; bodySlides: number } {
  const slides = Array.isArray(output.slides) ? output.slides : [];
  const bodySlides = slides.filter(isBodySlide);
  if (bodySlides.length === 0) {
    return { averageRichScore: 0, bodySlides: 0 };
  }
  let total = 0;
  for (const s of bodySlides) {
    let score = 0;
    if (safeText(s.paragraph).length >= 40) score++;
    if ((s.bullets?.length ?? 0) >= 4) score++;
    if (s.codeSnippet?.code) score++;
    if (s.complexity) score++;
    if (s.diagramSpec) score++;
    if ((s.tipBoxes?.length ?? 0) > 0) score++;
    if ((s.notebookSections?.length ?? 0) > 0) score++;
    total += score;
  }
  return {
    averageRichScore: total / bodySlides.length,
    bodySlides: bodySlides.length,
  };
}
