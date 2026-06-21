import {
  buildDocumentDeckSlideSvg,
  renderDocumentDeckSlide,
  DOCUMENT_DECK_CANVAS,
} from './document-deck-renderer';
import type { CarouselSlideOutput, TocEntry } from './custom-topic.schemas';

const META = {
  coverTitle: 'DSA Mastery Notebook',
  coverSubtitle: 'A 12-page handwritten study deck',
  author: 'Trndinn Study Notes',
  brand: 'Trndinn',
};

const TOC: TocEntry[] = [
  { title: 'Arrays in Java', pageNumber: 3 },
  { title: 'Linked Lists', pageNumber: 4 },
  { title: 'Hash Maps', pageNumber: 5 },
];

function makeSlide(partial: Partial<CarouselSlideOutput>): CarouselSlideOutput {
  return {
    title: partial.title ?? 'Body slide',
    body: partial.body ?? 'Body sentence describing the slide topic.',
    imagePrompt: partial.imagePrompt ?? 'rendered body page',
    bullets: partial.bullets ?? [
      'First teaching bullet that has substance and clarity for the reader',
      'Second teaching bullet covering an example or pitfall in detail',
      'Third teaching bullet about the trade-offs and when to apply it',
      'Fourth teaching bullet rehearsing the verbal explanation aloud',
    ],
    pageNumber: partial.pageNumber ?? 3,
    sectionType: partial.sectionType ?? 'body',
    ...partial,
  };
}

describe('buildDocumentDeckSlideSvg', () => {
  it('produces an SVG of the right canvas size for a notebook cover', () => {
    const svg = buildDocumentDeckSlideSvg({
      slide: makeSlide({
        sectionType: 'cover',
        pageNumber: 1,
        title: META.coverTitle,
      }),
      pageNumber: 1,
      totalPages: 12,
      theme: 'notebook',
      meta: META,
    });
    expect(svg).toContain(`width="${DOCUMENT_DECK_CANVAS}"`);
    expect(svg).toContain(`height="${DOCUMENT_DECK_CANVAS}"`);
    expect(svg).toContain('<svg');
    expect(svg).toContain('study notes');
  });

  it('renders TOC entries with page numbers in the notebook theme', () => {
    const svg = buildDocumentDeckSlideSvg({
      slide: makeSlide({
        sectionType: 'toc',
        pageNumber: 2,
        title: 'Table of Contents',
      }),
      pageNumber: 2,
      totalPages: 12,
      theme: 'notebook',
      meta: META,
      tocEntries: TOC,
    });
    expect(svg).toContain('Table of Contents');
    for (const entry of TOC) {
      expect(svg).toContain(`pg ${entry.pageNumber}`);
    }
  });

  it('renders body bullets and page badge in notebook theme', () => {
    const svg = buildDocumentDeckSlideSvg({
      slide: makeSlide({ pageNumber: 4, title: 'Linked Lists' }),
      pageNumber: 4,
      totalPages: 12,
      theme: 'notebook',
      meta: META,
    });
    expect(svg).toContain('Linked Lists');
    expect(svg).toMatch(/4 \/ 12/);
  });

  it('renders clean_document footer with page numbers', () => {
    const svg = buildDocumentDeckSlideSvg({
      slide: makeSlide({
        sectionType: 'cover',
        pageNumber: 1,
        title: META.coverTitle,
      }),
      pageNumber: 1,
      totalPages: 12,
      theme: 'clean_document',
      meta: META,
    });
    // The cover title is rendered word-wrapped across multiple <text> nodes; verify the
    // first wrapped segment is present + footer pagination renders correctly.
    expect(svg).toContain('DSA Mastery');
    expect(svg).toMatch(/1 \/ 12/);
  });

  it('renders clean_document body with KEY TAKEAWAY callout when marginNotes provided', () => {
    const svg = buildDocumentDeckSlideSvg({
      slide: makeSlide({
        title: 'Hash Maps',
        marginNotes: [
          'Avoid mutable keys to keep hashCode stable across operations',
        ],
      }),
      pageNumber: 5,
      totalPages: 12,
      theme: 'clean_document',
      meta: META,
    });
    expect(svg).toContain('KEY TAKEAWAY');
  });
});

describe('renderDocumentDeckSlide', () => {
  it('produces a JPEG buffer for a body page', async () => {
    const buffer = await renderDocumentDeckSlide({
      slide: makeSlide({ pageNumber: 4, title: 'Linked Lists' }),
      pageNumber: 4,
      totalPages: 12,
      theme: 'notebook',
      meta: META,
    });
    expect(buffer.length).toBeGreaterThan(2000);
    // JPEG SOI marker
    expect(buffer.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('renders all four section types end to end without crashing', async () => {
    for (const section of ['cover', 'toc', 'body', 'outro'] as const) {
      const buffer = await renderDocumentDeckSlide({
        slide: makeSlide({
          sectionType: section,
          pageNumber: section === 'cover' ? 1 : section === 'toc' ? 2 : 3,
        }),
        pageNumber: section === 'cover' ? 1 : section === 'toc' ? 2 : 3,
        totalPages: 12,
        theme: 'clean_document',
        meta: META,
        tocEntries: TOC,
      });
      expect(buffer.length).toBeGreaterThan(2000);
    }
  });
});
