/**
 * Preview generator for the new educational document-deck carousel presets.
 *
 * Renders a 12-slide deck for both `handwritten_notes` (notebook theme) and
 * `structured_document` (clean_document theme), writes JPEG previews + a JSON
 * skeleton to /tmp/document-deck-preview/ and a single composite PDF for each
 * theme via the existing carousel PDF helper.
 *
 * Usage:
 *   cd backend && npx ts-node --transpile-only tools/document-deck-preview.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PassThrough } from 'stream';
import PDFDocument from 'pdfkit';
import {
  renderDocumentDeckSlide,
  type DocumentDeckMeta,
} from '../src/modules/post-ai/document-deck-renderer';
import { planDocumentDeckPages } from '../src/modules/post-ai/carousel-document-mode';
import type {
  CarouselSlideOutput,
  TocEntry,
  CarouselDocumentTheme,
} from '../src/modules/post-ai/custom-topic.schemas';

function buildPdfFromImages(images: Buffer[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, compress: true });
    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    doc.pipe(stream);
    for (const image of images) {
      doc.addPage({ size: [1024, 1024], margin: 0 });
      doc.image(image, 0, 0, { width: 1024, height: 1024 });
    }
    doc.end();
  });
}

const OUT_DIR = '/tmp/document-deck-preview';
mkdirSync(OUT_DIR, { recursive: true });

const TOPIC = 'DSA in Java — From Arrays to Graphs';
const COVER_TITLE = 'DSA in Java';
const COVER_SUBTITLE = 'A 12-page handwritten study deck for interview prep';
const AUTHOR = 'Trndinn Study Notes';

const BODY_TITLES: string[] = [
  'Arrays & Two-Pointer Patterns',
  'Linked Lists in Java',
  'Stacks, Queues & Deques',
  'HashMap & HashSet Internals',
  'Trees & Tree Traversals',
  'Binary Search Trees vs Heaps',
  'Graphs: BFS & DFS',
  'Dynamic Programming Foundations',
  'Recursion & Backtracking',
  'Big-O Cheat Sheet',
];

const SLIDE_COUNT = 12;
const plan = planDocumentDeckPages(SLIDE_COUNT);
const BODY_COUNT = plan.bodyPages.length;

const tocEntries: TocEntry[] = BODY_TITLES.slice(0, BODY_COUNT).map(
  (title, idx) => ({ title, pageNumber: plan.bodyPages[idx] }),
);

function buildBodySlide(idx: number): CarouselSlideOutput {
  const title = BODY_TITLES[idx];
  const pageNumber = plan.bodyPages[idx];
  return {
    title,
    body: `Page ${pageNumber} — ${title}: a focused single-page study sheet with the must-know patterns and pitfalls for interviews.`,
    imagePrompt: `notebook page about ${title}`,
    bullets: [
      `Definition: when and why "${title}" matters in interviews`,
      `Core operations + their time complexity (e.g. push/pop O(1), search O(log n))`,
      `Java standard library hooks (java.util.* shortcuts that map cleanly to the concept)`,
      `Common gotcha or off-by-one mistake to avoid under pressure`,
      `Worked example showing input → algorithm → output in three steps`,
    ],
    pageNumber,
    sectionType: 'body',
    highlights: [0, 2],
    diagramHint: idx === 6 ? 'flow' : idx === 3 ? 'table' : undefined,
    codeSnippets:
      idx === 1
        ? ['ListNode head = new ListNode(0); head.next = new ListNode(1);']
        : undefined,
    marginNotes: [
      'Mutable keys break hashCode contracts; always store immutable identifiers.',
    ],
  };
}

const coverSlide: CarouselSlideOutput = {
  title: COVER_TITLE,
  body: COVER_SUBTITLE,
  imagePrompt: 'cover',
  bullets: [],
  pageNumber: 1,
  sectionType: 'cover',
};

const tocSlide: CarouselSlideOutput = {
  title: 'Table of Contents',
  body: '',
  imagePrompt: 'toc',
  bullets: [],
  pageNumber: 2,
  sectionType: 'toc',
};

const bodySlides: CarouselSlideOutput[] = Array.from(
  { length: BODY_COUNT },
  (_, idx) => buildBodySlide(idx),
);

const outroSlide: CarouselSlideOutput | null = plan.outroPage
  ? {
      title: 'Thanks for studying',
      body: 'Save and share to reinforce.',
      imagePrompt: 'outro',
      bullets: [],
      pageNumber: plan.outroPage,
      sectionType: 'outro',
    }
  : null;

const allSlides: CarouselSlideOutput[] = [
  coverSlide,
  tocSlide,
  ...bodySlides,
  ...(outroSlide ? [outroSlide] : []),
];

const sampleSkeleton = {
  topic: TOPIC,
  slideCount: SLIDE_COUNT,
  documentMode: 'handwritten_notes',
  documentTheme: 'notebook',
  coverTitle: COVER_TITLE,
  coverSubtitle: COVER_SUBTITLE,
  author: AUTHOR,
  tocEntries,
  slides: allSlides.map((s) => ({
    pageNumber: s.pageNumber,
    sectionType: s.sectionType,
    title: s.title,
  })),
};

writeFileSync(
  join(OUT_DIR, 'sample-12-slide-skeleton.json'),
  JSON.stringify(sampleSkeleton, null, 2),
  'utf8',
);

const meta: DocumentDeckMeta = {
  coverTitle: COVER_TITLE,
  coverSubtitle: COVER_SUBTITLE,
  author: AUTHOR,
  brand: 'Trndinn',
};

async function renderTheme(theme: CarouselDocumentTheme, prefix: string) {
  const buffers: Buffer[] = [];
  for (const slide of allSlides) {
    const buf = await renderDocumentDeckSlide({
      slide,
      pageNumber: slide.pageNumber || 1,
      totalPages: SLIDE_COUNT,
      theme,
      meta,
      tocEntries,
    });
    buffers.push(buf);
    const out = join(
      OUT_DIR,
      `${prefix}-${String(slide.pageNumber).padStart(2, '0')}-${slide.sectionType}.jpg`,
    );
    writeFileSync(out, buf);
  }
  return buffers;
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('[preview] rendering handwritten_notes (notebook theme) ...');
  const notebookBuffers = await renderTheme('notebook', 'notebook');
  // eslint-disable-next-line no-console
  console.log('[preview] rendering structured_document (clean_document theme) ...');
  const cleanBuffers = await renderTheme('clean_document', 'clean');

  const notebookPdf = await buildPdfFromImages(notebookBuffers);
  writeFileSync(join(OUT_DIR, 'notebook-deck.pdf'), notebookPdf);
  const cleanPdf = await buildPdfFromImages(cleanBuffers);
  writeFileSync(join(OUT_DIR, 'clean-deck.pdf'), cleanPdf);
  // eslint-disable-next-line no-console
  console.log('[preview] wrote', OUT_DIR);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
