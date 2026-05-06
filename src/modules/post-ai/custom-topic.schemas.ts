import { z } from 'zod';

export const CAROUSEL_NOTE_DENSITY_LEVELS = [
  'compact',
  'standard',
  'dense',
] as const;

export type CarouselNoteDensityLevel =
  (typeof CAROUSEL_NOTE_DENSITY_LEVELS)[number];

export const CAROUSEL_SUBJECT_MODES = [
  'auto',
  'programming',
  'general',
] as const;
export type CarouselSubjectModeLevel = (typeof CAROUSEL_SUBJECT_MODES)[number];

export const CAROUSEL_VISUAL_STYLE_OR_AUTO = [
  'auto',
  'handwritten_notebook',
  'handwritten_notebook_dense',
  'whiteboard_notes',
  'diagram_clean',
  'stock_visual',
] as const;

/**
 * High-quality educational deck presets for tonality=educational + carousel.
 *
 * - `none`            → existing carousel pipeline (LLM image plate + compositor overlay)
 * - `handwritten_notes` → real student-notebook deck: ruled paper, blue/black ink,
 *                          red underlined headings, yellow highlights, page numbers,
 *                          cover + TOC + body. Renders deterministically (no LLM image).
 * - `structured_document` → clean PDF/study-document deck: cover, TOC w/ leader dots,
 *                            H1/H2 body pages, code blocks, callouts, footer page #.
 *                            Renders deterministically (no LLM image).
 *
 * Pricing remains `2 + 2.5 × slideCount` regardless of preset (cover + TOC are
 * counted toward the user-selected slide budget). See backend pricing module.
 */
export const CAROUSEL_DOCUMENT_MODES = [
  'auto',
  'none',
  'handwritten_notes',
  'structured_document',
] as const;
export type CarouselDocumentMode = (typeof CAROUSEL_DOCUMENT_MODES)[number];

/**
 * Visual theme for the document deck renderer. Decoupled from `documentMode`
 * so future presets (e.g. dotted-grid bullet journal) can reuse the notebook theme.
 */
export const CAROUSEL_DOCUMENT_THEMES = ['notebook', 'clean_document'] as const;
export type CarouselDocumentTheme = (typeof CAROUSEL_DOCUMENT_THEMES)[number];

export const CAROUSEL_SECTION_TYPES = [
  'cover',
  'toc',
  'body',
  'outro',
] as const;
export type CarouselSectionType = (typeof CAROUSEL_SECTION_TYPES)[number];

/** Structured lines for full-page dense notebook rendering */
export const NotebookSectionSchema = z.object({
  subheading: z.string().optional(),
  /** Short ink lines (target ~50–95 chars); one entry = one ruled row */
  lines: z.array(z.string()),
  /** Optional bullet block inside a section */
  bulletItems: z.array(z.string()).optional(),
});

/* ---------- Rich educational content (DSA cheatsheets, coding decks, etc.) ---------- */

/** Inline code block for syntax-highlighted rendering. */
export const CodeSnippetObjectSchema = z.object({
  language: z.string().trim().min(1).max(40),
  code: z.string().min(1),
});
export type CodeSnippetObject = z.infer<typeof CodeSnippetObjectSchema>;

/** Visualizable diagrams the renderer turns into hand-drawn / clean SVG. */
export const DIAGRAM_SPEC_TYPES = [
  'flowchart',
  'tree',
  'array',
  'linked-list',
  'hash-map',
  'graph',
  'comparison-table',
  'sequence',
] as const;
export type DiagramSpecType = (typeof DIAGRAM_SPEC_TYPES)[number];

export const DiagramElementSchema = z.object({
  /** Short label rendered inside the node (≤ ~28 chars). */
  label: z.string().min(1),
  /** Optional CSS-friendly hex/name (e.g. `#dc2626`, `red`). */
  color: z.string().optional(),
  /** Optional shape hint (`rect`, `round`, `circle`, `diamond`). */
  shape: z.string().optional(),
});

export const DiagramEdgeSchema = z.object({
  /** Element label or 0-indexed position string. */
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional(),
  color: z.string().optional(),
});

export const DiagramSpecSchema = z.object({
  type: z.enum(DIAGRAM_SPEC_TYPES),
  /** Optional title shown above the diagram. */
  title: z.string().optional(),
  /** 2–10 elements; renderer truncates excess to keep slide legible. */
  elements: z.array(DiagramElementSchema).min(1).max(10),
  edges: z.array(DiagramEdgeSchema).optional(),
});
export type DiagramSpec = z.infer<typeof DiagramSpecSchema>;

/** Highlighted callout box (tips, warnings, mnemonics). */
export const TipBoxSchema = z.object({
  title: z.string().trim().min(1).max(60),
  body: z.string().trim().min(1),
  /** Visual accent: `tip` (green/yellow), `warning` (red), `info` (blue), or hex. */
  accent: z.string().optional(),
});
export type TipBox = z.infer<typeof TipBoxSchema>;

export const PostGenerationInputSchema = z.object({
  platform: z.enum(['linkedin', 'instagram', 'x']),
  contentType: z.enum(['text', 'image', 'carousel']),
  topic: z.string().trim().min(3).max(2000),
  tonality: z.enum([
    'professional',
    'casual_friendly',
    'trendy',
    'storytelling',
    'bold_punchy',
    'educational',
    'inspirational',
  ]),
  wordLimit: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('short') }),
    z.object({ kind: z.literal('medium') }),
    z.object({ kind: z.literal('long') }),
    z.object({
      kind: z.literal('custom'),
      words: z.number().int().min(10).max(5000),
    }),
  ]),
  imageCount: z.number().int().min(1).max(4).optional(),
  slideCount: z.number().int().min(2).max(20).optional(),
  /** Carousel only: auto = infer from topic; otherwise force base image + overlay treatment. */
  carouselVisualStyle: z.enum(CAROUSEL_VISUAL_STYLE_OR_AUTO).optional(),
  /**
   * Content richness for carousel notebook-style layouts.
   * Omitted ⇒ server defaults (dense for notebook visuals; compact when wordLimit is short).
   */
  carouselNoteDensity: z.enum(CAROUSEL_NOTE_DENSITY_LEVELS).optional(),
  /** Route programming/teaching supplements (complexity blocks, pitfalls, snippets). */
  carouselSubjectMode: z.enum(CAROUSEL_SUBJECT_MODES).optional(),
  /**
   * Educational carousel deck preset (cover + TOC + body deterministic renderer).
   * Only honored when tonality=educational + contentType=carousel.
   * `auto` = infer from topic; `none` = legacy LLM-image carousel.
   */
  carouselDocumentMode: z.enum(CAROUSEL_DOCUMENT_MODES).optional(),
  /**
   * Optional cover branding placeholder (e.g. user/handle). When omitted, renderer
   * uses a neutral mark.
   */
  carouselDocumentAuthor: z.string().trim().max(80).optional(),
  /**
   * When true, allow richer carousel capture rows (still requires TRAINING_CAPTURE_ENABLED=true
   * server-side — see CarouselTrainingCaptureService). Does not grant third-party training rights.
   */
  trainingDataCaptureOptIn: z.boolean().optional(),
});

// Optional list fields: models frequently return null instead of omitting keys (handled in normalizeCustomTopicLlmPayload).
export const TextPostOutputSchema = z.object({
  caption: z.string(),
  hashtags: z.array(z.string()),
  /** May be omitted after parse; normalized LLM payloads coerce null to []. */
  bullets: z.array(z.string()).optional(),
  cta: z.string().optional(),
  keywords: z.array(z.string()),
});

export const ImagePostOutputSchema = TextPostOutputSchema.extend({
  imagePrompts: z.array(z.string()),
});

/**
 * One TOC entry. `pageNumber` is the absolute deck page number (1-indexed)
 * of the body slide it points to. The TOC slide itself is not listed here.
 */
export const TocEntrySchema = z.object({
  title: z.string().trim().min(1),
  pageNumber: z.number().int().min(1).max(40),
});
export type TocEntry = z.infer<typeof TocEntrySchema>;

export const CarouselSlideSchema = z.object({
  title: z.string(),
  body: z.string(),
  /** 3–5 teaching bullets; required for quality gate on 8+ slide decks (non-dense). */
  bullets: z.array(z.string()).optional(),
  imagePrompt: z.string(),
  /** Dense notebook mode: ruled-line content; preferred over title+bullets-only pages. */
  notebookSections: z.array(NotebookSectionSchema).optional(),
  /** Short margin callouts (LLM may emit as marginal_notes — normalized onto marginNotes pre-parse). */
  marginNotes: z.array(z.string()).optional(),
  /** Extra bullet lines for very full pages */
  denseBullets: z.array(z.string()).optional(),
  /** Short Java/code fragments for monospace bands. Backwards-compatible: legacy strings; prefer `codeSnippet` for rich rendering. */
  codeSnippets: z.array(z.string()).optional(),

  /* ---------- Rich content: cheatsheet/educational fields ---------- */
  /**
   * Flowing paragraph of prose explaining the concept (target 40–100 words).
   * Rendered above bullets in body slides for both notebook and clean themes.
   */
  paragraph: z.string().optional(),
  /** Single rich code block with language + code (used for syntax-styled rendering). */
  codeSnippet: CodeSnippetObjectSchema.optional(),
  /** Big-O / cost analysis line (e.g. `Time: O(n log n), Space: O(1)`). */
  complexity: z.string().optional(),
  /** Programmatic diagram spec rendered as hand-drawn SVG / clean SVG. */
  diagramSpec: DiagramSpecSchema.optional(),
  /** Tip / warning / mnemonic callout boxes. */
  tipBoxes: z.array(TipBoxSchema).optional(),

  /* ---------- Document-mode fields (handwritten_notes / structured_document) ---------- */
  /** Absolute deck page number; cover=1, TOC=2, body=3..N. Optional for legacy carousels. */
  pageNumber: z.number().int().min(1).max(40).optional(),
  /** Section role; renderer picks per-slide layout. Optional; defaults to `body` when omitted. */
  sectionType: z.enum(CAROUSEL_SECTION_TYPES).optional(),
  /**
   * Hint for body-page diagrammatic layout: `table`/`index` → ruled grid render;
   * `tree`/`graph`/`flow` → simple boxes + arrows. Renderer falls back to plain
   * notebook layout when unknown.
   */
  diagramHint: z.string().optional(),
  /**
   * 0-indexed bullet positions to highlight (yellow band on notebook,
   * accent bar on clean_document). Trimmed to actual bullet count at render time.
   */
  highlights: z.array(z.number().int().min(0)).optional(),
});
export type CarouselSlideOutput = z.infer<typeof CarouselSlideSchema>;

export const CarouselPostOutputSchema = TextPostOutputSchema.extend({
  /** Document-mode deck cover title (omitted on legacy decks). */
  coverTitle: z.string().optional(),
  /** Document-mode deck cover subtitle (omitted on legacy decks). */
  coverSubtitle: z.string().optional(),
  /** Optional author / handle placeholder shown on cover + footer. */
  author: z.string().optional(),
  /**
   * Authoritative TOC entries (one per body slide). Renderer pages 1..N use
   * pageNumber to align cover/TOC/body slides. Optional on legacy decks.
   */
  tocEntries: z.array(TocEntrySchema).optional(),
  slides: z.array(CarouselSlideSchema),
});

export const OffTopicOutputSchema = z.object({
  error: z.literal('off_topic'),
});

/** Full union (e.g. typing); prefer safeParseCustomTopicPostOutput at runtime. */
export const PostOutputSchema = z.union([
  TextPostOutputSchema,
  ImagePostOutputSchema,
  CarouselPostOutputSchema,
  OffTopicOutputSchema,
]);

export type PostGenerationInput = z.infer<typeof PostGenerationInputSchema>;
export type TextPostOutput = z.infer<typeof TextPostOutputSchema>;
export type ImagePostOutput = z.infer<typeof ImagePostOutputSchema>;
export type CarouselPostOutput = z.infer<typeof CarouselPostOutputSchema>;
export type NotebookSection = z.infer<typeof NotebookSectionSchema>;
export type PostOutput = z.infer<typeof PostOutputSchema>;

/** Coerce LLM JSON so Zod validation matches intended semantics (null → [] / undefined). */
export function normalizeCustomTopicLlmPayload(
  raw: unknown,
  contentType: 'text' | 'image' | 'carousel',
): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }

  const o = raw as Record<string, unknown>;

  if (o.error === 'off_topic') {
    return { error: 'off_topic' };
  }

  const n = { ...o };

  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];

  n.hashtags = asStringArray(n.hashtags);
  n.keywords = asStringArray(n.keywords);
  // Prompt allows omitting bullets; models often emit null instead of omitting.
  n.bullets = n.bullets == null ? [] : asStringArray(n.bullets);
  if (n.cta === null) {
    delete n.cta;
  }

  if (contentType === 'image') {
    n.imagePrompts = asStringArray(n.imagePrompts);
  }

  if (contentType === 'carousel') {
    if (n.coverTitle === null) delete n.coverTitle;
    if (n.coverSubtitle === null) delete n.coverSubtitle;
    if (n.author === null) delete n.author;

    if (!Array.isArray(n.tocEntries)) {
      delete n.tocEntries;
    } else {
      n.tocEntries = (n.tocEntries as unknown[])
        .map((entry) => {
          if (
            entry == null ||
            typeof entry !== 'object' ||
            Array.isArray(entry)
          )
            return null;
          const e = entry as Record<string, unknown>;
          const title = typeof e.title === 'string' ? e.title.trim() : '';
          const pn =
            typeof e.pageNumber === 'number'
              ? Math.round(e.pageNumber)
              : typeof e.page === 'number'
                ? Math.round(e.page)
                : NaN;
          if (!title || !Number.isFinite(pn) || pn < 1) return null;
          return { title, pageNumber: pn };
        })
        .filter(Boolean);
      if ((n.tocEntries as unknown[]).length === 0) delete n.tocEntries;
    }

    if (!Array.isArray(n.slides)) {
      n.slides = [];
    } else {
      n.slides = n.slides.map((slide: unknown) => {
        if (
          slide === null ||
          typeof slide !== 'object' ||
          Array.isArray(slide)
        ) {
          return slide;
        }
        const s = { ...(slide as Record<string, unknown>) };
        if (s.bullets == null || !Array.isArray(s.bullets)) {
          s.bullets = [];
        } else {
          s.bullets = (s.bullets as unknown[]).filter(
            (x) => typeof x === 'string',
          );
        }
        if (s.marginNotes == null || !Array.isArray(s.marginNotes)) {
          s.marginNotes = [];
        } else {
          s.marginNotes = (s.marginNotes as unknown[]).filter(
            (x) => typeof x === 'string',
          );
        }
        const marginalAlt = asStringArray(s.marginal_notes);
        if (marginalAlt.length) {
          s.marginNotes = [...(s.marginNotes as string[]), ...marginalAlt];
        }
        delete s.marginal_notes;

        if (s.denseBullets == null || !Array.isArray(s.denseBullets)) {
          s.denseBullets = [];
        } else {
          s.denseBullets = (s.denseBullets as unknown[]).filter(
            (x) => typeof x === 'string',
          );
        }
        if (s.codeSnippets == null || !Array.isArray(s.codeSnippets)) {
          s.codeSnippets = [];
        } else {
          s.codeSnippets = (s.codeSnippets as unknown[]).filter(
            (x) => typeof x === 'string',
          );
        }
        if (!Array.isArray(s.notebookSections)) {
          delete s.notebookSections;
        } else {
          s.notebookSections = (s.notebookSections as unknown[])
            .map((sec) => {
              if (sec == null || typeof sec !== 'object' || Array.isArray(sec))
                return null;
              const o = sec as Record<string, unknown>;
              const lines = Array.isArray(o.lines)
                ? (o.lines as unknown[]).filter((x) => typeof x === 'string')
                : [];
              const bulletItems = Array.isArray(o.bulletItems)
                ? (o.bulletItems as unknown[]).filter(
                    (x) => typeof x === 'string',
                  )
                : [];
              return {
                subheading:
                  typeof o.subheading === 'string' ? o.subheading : undefined,
                lines,
                bulletItems: bulletItems.length ? bulletItems : undefined,
              };
            })
            .filter(Boolean);
        }
        for (const key of ['title', 'body', 'imagePrompt'] as const) {
          if (s[key] === null) {
            s[key] = '';
          }
        }

        if (typeof s.page === 'number' && s.pageNumber == null) {
          s.pageNumber = Math.round(s.page);
        }
        if (
          typeof s.pageNumber === 'number' &&
          !Number.isFinite(s.pageNumber)
        ) {
          delete s.pageNumber;
        }
        if (s.sectionType === null) delete s.sectionType;
        if (typeof s.section === 'string' && s.sectionType == null) {
          const normalized = s.section.toString().trim().toLowerCase();
          if (
            normalized === 'cover' ||
            normalized === 'toc' ||
            normalized === 'body' ||
            normalized === 'outro'
          ) {
            s.sectionType = normalized;
          }
        }
        if (Array.isArray(s.highlights)) {
          s.highlights = (s.highlights as unknown[])
            .filter((x) => typeof x === 'number' && Number.isFinite(x))
            .map((n) => Math.max(0, Math.round(n as number)));
          if ((s.highlights as number[]).length === 0) delete s.highlights;
        } else if (s.highlights != null) {
          delete s.highlights;
        }
        if (typeof s.diagramHint !== 'string' || !s.diagramHint.trim()) {
          delete s.diagramHint;
        } else {
          s.diagramHint = s.diagramHint.trim().toLowerCase();
        }

        // Rich content normalization (defensive — never throw on bad shapes).
        if (typeof s.paragraph !== 'string' || !s.paragraph.trim()) {
          delete s.paragraph;
        }
        if (typeof s.complexity !== 'string' || !s.complexity.trim()) {
          delete s.complexity;
        }
        // codeSnippet: accept either a {language, code} object or a raw string
        // (some LLMs emit a string here even though the schema asks for an object).
        if (s.codeSnippet != null) {
          if (typeof s.codeSnippet === 'string') {
            const code = s.codeSnippet.trim();
            if (code) {
              s.codeSnippet = { language: 'text', code };
            } else {
              delete s.codeSnippet;
            }
          } else if (
            typeof s.codeSnippet === 'object' &&
            !Array.isArray(s.codeSnippet)
          ) {
            const cs = s.codeSnippet as Record<string, unknown>;
            const language =
              typeof cs.language === 'string' && cs.language.trim()
                ? cs.language.trim()
                : 'text';
            const code = typeof cs.code === 'string' ? cs.code : '';
            if (code.trim()) {
              s.codeSnippet = { language, code };
            } else {
              delete s.codeSnippet;
            }
          } else {
            delete s.codeSnippet;
          }
        }
        // tipBoxes: array of {title, body, accent?}
        if (s.tipBoxes != null) {
          if (!Array.isArray(s.tipBoxes)) {
            delete s.tipBoxes;
          } else {
            const cleaned = (s.tipBoxes as unknown[])
              .map((tb) => {
                if (tb == null || typeof tb !== 'object' || Array.isArray(tb))
                  return null;
                const o = tb as Record<string, unknown>;
                const title = typeof o.title === 'string' ? o.title.trim() : '';
                const body = typeof o.body === 'string' ? o.body.trim() : '';
                if (!title || !body) return null;
                const accent =
                  typeof o.accent === 'string' && o.accent.trim()
                    ? o.accent.trim()
                    : undefined;
                return accent ? { title, body, accent } : { title, body };
              })
              .filter(Boolean);
            if (cleaned.length === 0) delete s.tipBoxes;
            else s.tipBoxes = cleaned;
          }
        }
        // diagramSpec: validate type + elements; truncate excessive elements.
        if (s.diagramSpec != null) {
          const ds = s.diagramSpec;
          if (
            ds === null ||
            typeof ds !== 'object' ||
            Array.isArray(ds) ||
            typeof (ds as Record<string, unknown>).type !== 'string'
          ) {
            delete s.diagramSpec;
          } else {
            const obj = ds as Record<string, unknown>;
            const tRaw = String(obj.type).trim().toLowerCase();
            const knownTypes = new Set<string>([
              'flowchart',
              'tree',
              'array',
              'linked-list',
              'linked_list',
              'linkedlist',
              'hash-map',
              'hash_map',
              'hashmap',
              'graph',
              'comparison-table',
              'comparison_table',
              'comparisontable',
              'sequence',
            ]);
            const aliasMap: Record<string, string> = {
              linkedlist: 'linked-list',
              linked_list: 'linked-list',
              hashmap: 'hash-map',
              hash_map: 'hash-map',
              comparisontable: 'comparison-table',
              comparison_table: 'comparison-table',
            };
            const normalizedType = aliasMap[tRaw] ?? tRaw;
            if (!knownTypes.has(tRaw)) {
              delete s.diagramSpec;
            } else {
              const elementsRaw = Array.isArray(obj.elements)
                ? obj.elements
                : [];
              const elements = (elementsRaw as unknown[])
                .map((el) => {
                  if (el == null || typeof el !== 'object' || Array.isArray(el))
                    return null;
                  const eo = el as Record<string, unknown>;
                  const label =
                    typeof eo.label === 'string'
                      ? eo.label.trim()
                      : typeof eo.text === 'string'
                        ? eo.text.trim()
                        : '';
                  if (!label) return null;
                  const color =
                    typeof eo.color === 'string' && eo.color.trim()
                      ? eo.color.trim()
                      : undefined;
                  const shape =
                    typeof eo.shape === 'string' && eo.shape.trim()
                      ? eo.shape.trim()
                      : undefined;
                  return color || shape ? { label, color, shape } : { label };
                })
                .filter(Boolean)
                .slice(0, 10);
              if (elements.length === 0) {
                delete s.diagramSpec;
              } else {
                const edgesRaw = Array.isArray(obj.edges) ? obj.edges : null;
                const edges = edgesRaw
                  ? (edgesRaw as unknown[])
                      .map((e) => {
                        if (
                          e == null ||
                          typeof e !== 'object' ||
                          Array.isArray(e)
                        )
                          return null;
                        const eo = e as Record<string, unknown>;
                        const from =
                          typeof eo.from === 'string' ? eo.from.trim() : '';
                        const to =
                          typeof eo.to === 'string' ? eo.to.trim() : '';
                        if (!from || !to) return null;
                        const label =
                          typeof eo.label === 'string' && eo.label.trim()
                            ? eo.label.trim()
                            : undefined;
                        const color =
                          typeof eo.color === 'string' && eo.color.trim()
                            ? eo.color.trim()
                            : undefined;
                        const out: Record<string, string> = { from, to };
                        if (label) out.label = label;
                        if (color) out.color = color;
                        return out;
                      })
                      .filter(Boolean)
                  : undefined;
                const titleStr =
                  typeof obj.title === 'string' && obj.title.trim()
                    ? obj.title.trim()
                    : undefined;
                s.diagramSpec = {
                  type: normalizedType,
                  ...(titleStr ? { title: titleStr } : {}),
                  elements,
                  ...(edges && edges.length ? { edges } : {}),
                };
              }
            }
          }
        }
        return s;
      });
    }
  }

  return n;
}

/** Parse model output for the requested post shape, then off-topic object. Avoids brittle z.union on partial overlaps. */
export function safeParseCustomTopicPostOutput(
  raw: unknown,
  contentType: 'text' | 'image' | 'carousel',
) {
  const normalized = normalizeCustomTopicLlmPayload(raw, contentType);

  const off = OffTopicOutputSchema.safeParse(normalized);
  if (off.success) {
    return off;
  }

  switch (contentType) {
    case 'text':
      return TextPostOutputSchema.safeParse(normalized);
    case 'image':
      return ImagePostOutputSchema.safeParse(normalized);
    case 'carousel':
      return CarouselPostOutputSchema.safeParse(normalized);
  }
}
