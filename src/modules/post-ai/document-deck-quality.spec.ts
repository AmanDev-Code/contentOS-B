import { analyzeDocumentDeckQuality } from './document-deck-quality';
import type { CarouselPostOutput } from './custom-topic.schemas';

function makeBodyBullet(label: string): string {
  return `${label}: substantive teaching point that fills the bullet width sufficiently for the gate.`;
}

function buildValidDeck(slideCount = 12): Pick<
  CarouselPostOutput,
  'slides' | 'tocEntries' | 'coverTitle' | 'coverSubtitle' | 'author'
> {
  const bodyTitles = Array.from(
    { length: slideCount - 3 },
    (_, i) => `Pillar ${i + 1}: focused teaching topic`,
  );
  const slides = [
    {
      title: 'DSA Mastery Notebook',
      body: 'Cover page summary for the deck and the audience.',
      imagePrompt: 'rendered handwritten cover page',
      pageNumber: 1,
      sectionType: 'cover' as const,
    },
    {
      title: 'Table of Contents',
      body: 'A guided overview of the topics covered in this deck.',
      imagePrompt: 'rendered table of contents page',
      pageNumber: 2,
      sectionType: 'toc' as const,
    },
    ...bodyTitles.map((title, i) => ({
      title,
      body:
        'Two-sentence body bridging this topic with the rest of the deck for the reader.',
      bullets: [
        makeBodyBullet('Definition'),
        makeBodyBullet('Mental model'),
        makeBodyBullet('Common pitfall'),
        makeBodyBullet('Big-O insight'),
      ],
      imagePrompt: 'rendered handwritten body page',
      pageNumber: 3 + i,
      sectionType: 'body' as const,
    })),
    {
      title: 'Next steps and study plan',
      body: 'Outro with study plan and next-step guidance for the learner.',
      imagePrompt: 'rendered handwritten outro page',
      pageNumber: slideCount,
      sectionType: 'outro' as const,
    },
  ];
  return {
    slides,
    coverTitle: 'DSA Mastery Notebook',
    coverSubtitle: 'A 12-page handwritten study deck',
    author: 'Trndinn Study Notes',
    tocEntries: bodyTitles.map((title, i) => ({
      title,
      pageNumber: 3 + i,
    })),
  };
}

describe('analyzeDocumentDeckQuality', () => {
  it('accepts a properly shaped 12-page deck', () => {
    const deck = buildValidDeck(12);
    const issues = analyzeDocumentDeckQuality({
      output: deck,
      expectedSlideCount: 12,
      documentMode: 'handwritten_notes',
    });
    expect(issues).toEqual([]);
  });

  it('rejects when slide count mismatches', () => {
    const deck = buildValidDeck(12);
    const issues = analyzeDocumentDeckQuality({
      output: deck,
      expectedSlideCount: 10,
      documentMode: 'handwritten_notes',
    });
    expect(issues.some((i) => i.code === 'documentdeck_slide_count')).toBe(true);
  });

  it('rejects when cover is missing', () => {
    const deck = buildValidDeck(12);
    deck.slides[0].sectionType = 'body';
    const issues = analyzeDocumentDeckQuality({
      output: deck,
      expectedSlideCount: 12,
      documentMode: 'handwritten_notes',
    });
    expect(issues.some((i) => i.code === 'documentdeck_cover_missing')).toBe(true);
  });

  it('rejects when TOC entries do not match body titles', () => {
    const deck = buildValidDeck(12);
    if (deck.tocEntries) {
      deck.tocEntries[0] = { title: 'Mismatched title', pageNumber: 3 };
    }
    const issues = analyzeDocumentDeckQuality({
      output: deck,
      expectedSlideCount: 12,
      documentMode: 'handwritten_notes',
    });
    expect(issues.some((i) => i.code === 'documentdeck_toc_title_mismatch')).toBe(true);
  });

  it('rejects when TOC length differs from body slide count', () => {
    const deck = buildValidDeck(12);
    if (deck.tocEntries) {
      deck.tocEntries.pop();
    }
    const issues = analyzeDocumentDeckQuality({
      output: deck,
      expectedSlideCount: 12,
      documentMode: 'handwritten_notes',
    });
    expect(issues.some((i) => i.code === 'documentdeck_toc_body_mismatch')).toBe(true);
  });

  it('rejects placeholder titles', () => {
    const deck = buildValidDeck(12);
    deck.slides[3].title = 'Slide 3';
    const issues = analyzeDocumentDeckQuality({
      output: deck,
      expectedSlideCount: 12,
      documentMode: 'handwritten_notes',
    });
    expect(issues.some((i) => i.code === 'documentdeck_placeholder_title')).toBe(true);
  });

  it('rejects body slides with too few substantive bullets', () => {
    const deck = buildValidDeck(12);
    deck.slides[3].bullets = [makeBodyBullet('Lonely')];
    const issues = analyzeDocumentDeckQuality({
      output: deck,
      expectedSlideCount: 12,
      documentMode: 'handwritten_notes',
    });
    expect(issues.some((i) => i.code === 'documentdeck_bullets_low')).toBe(true);
  });

  it('rejects out-of-order page numbers', () => {
    const deck = buildValidDeck(12);
    const tmp = deck.slides[2];
    deck.slides[2] = deck.slides[3];
    deck.slides[3] = tmp;
    const issues = analyzeDocumentDeckQuality({
      output: deck,
      expectedSlideCount: 12,
      documentMode: 'handwritten_notes',
    });
    expect(
      issues.some(
        (i) =>
          i.code === 'documentdeck_page_numbers_invalid' ||
          i.code === 'documentdeck_page_numbers_out_of_order',
      ),
    ).toBe(true);
  });
});
