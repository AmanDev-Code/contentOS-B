import {
  enrichCarouselDeckRichContent,
  scoreCarouselRichness,
  topicWantsCodeRichContent,
  topicWantsComparisonDiagram,
} from './carousel-rich-content-enrichment';
import type {
  CarouselPostOutput,
  CarouselSlideOutput,
} from './custom-topic.schemas';

function makeBodySlide(
  partial: Partial<CarouselSlideOutput> = {},
): CarouselSlideOutput {
  return {
    title: partial.title ?? 'Body slide',
    body: partial.body ?? 'Body summary text.',
    imagePrompt: partial.imagePrompt ?? 'rendered body page',
    sectionType: partial.sectionType ?? 'body',
    pageNumber: partial.pageNumber ?? 3,
    bullets: partial.bullets,
    denseBullets: partial.denseBullets,
    paragraph: partial.paragraph,
    notebookSections: partial.notebookSections,
    marginNotes: partial.marginNotes,
    codeSnippets: partial.codeSnippets,
    codeSnippet: partial.codeSnippet,
    complexity: partial.complexity,
    diagramSpec: partial.diagramSpec,
    tipBoxes: partial.tipBoxes,
    diagramHint: partial.diagramHint,
    highlights: partial.highlights,
  };
}

function makeDeck(
  slides: CarouselSlideOutput[],
): Pick<CarouselPostOutput, 'slides'> {
  return { slides };
}

describe('topic classifiers', () => {
  it('detects programming topics', () => {
    expect(topicWantsCodeRichContent('java dsa interview prep')).toBe(true);
    expect(topicWantsCodeRichContent('quicksort algorithm explained')).toBe(
      true,
    );
    expect(topicWantsCodeRichContent('how to bake bread')).toBe(false);
  });

  it('detects comparison topics', () => {
    expect(topicWantsComparisonDiagram('java vs kotlin')).toBe(true);
    expect(
      topicWantsComparisonDiagram('cheat sheet for sorting algorithms'),
    ).toBe(true);
    expect(topicWantsComparisonDiagram('story about my first job')).toBe(false);
  });
});

describe('enrichCarouselDeckRichContent', () => {
  it('lifts triple-backtick fenced code blocks into codeSnippet', () => {
    const slide = makeBodySlide({
      bullets: [
        'Quick Sort partitions around a pivot, not Bubble Sort.',
        'Reference implementation:',
        '```java\nvoid quickSort(int[] a, int lo, int hi) {\n  if (lo >= hi) return;\n  int p = partition(a, lo, hi);\n  quickSort(a, lo, p - 1);\n  quickSort(a, p + 1, hi);\n}\n```',
        'Average time complexity is O(n log n).',
      ],
    });
    const deck = makeDeck([slide]);
    const result = enrichCarouselDeckRichContent(deck, {
      topicLower: 'quick sort java dsa',
    });
    expect(result.fieldsAdded.codeSnippet).toBe(1);
    expect(slide.codeSnippet?.language).toBe('java');
    expect(slide.codeSnippet?.code).toMatch(/quickSort/);
  });

  it('extracts complexity strings from bullets', () => {
    const slide = makeBodySlide({
      bullets: [
        'Hash maps offer O(1) average lookups.',
        'Time: O(n) worst case · Space: O(n) bookkeeping.',
        'Java HashMap converts long chains to balanced trees.',
      ],
    });
    const deck = makeDeck([slide]);
    enrichCarouselDeckRichContent(deck, { topicLower: 'hashmap interview' });
    expect(slide.complexity).toContain('Time');
    expect(slide.complexity).toContain('Space');
  });

  it('synthesizes a comparison-table diagram from "Name — Detail" bullets', () => {
    const slide = makeBodySlide({
      bullets: [
        'Bubble Sort — O(n²) average, simple but slow on real data',
        'Insertion Sort — O(n²) but fast on nearly-sorted input',
        'Quick Sort — O(n log n) avg, in-place, default for most stdlibs',
        'Merge Sort — O(n log n) stable, requires O(n) extra memory',
      ],
    });
    const deck = makeDeck([slide]);
    const result = enrichCarouselDeckRichContent(deck, {
      topicLower: 'sorting algorithms cheat sheet',
    });
    expect(result.fieldsAdded.diagramSpec).toBe(1);
    expect(slide.diagramSpec?.type).toBe('comparison-table');
    expect(slide.diagramSpec?.elements.length).toBeGreaterThanOrEqual(3);
  });

  it('promotes "Pro tip:" bullets into tipBoxes', () => {
    const slide = makeBodySlide({
      bullets: [
        'Pro tip: prefer ArrayDeque over Stack — Stack is legacy and synchronized.',
        'Common mistake: mutating a hashCode key after put() leaks entries.',
        'Plain teaching point about the topic.',
      ],
    });
    const deck = makeDeck([slide]);
    enrichCarouselDeckRichContent(deck, { topicLower: 'java collections' });
    expect(slide.tipBoxes?.length).toBeGreaterThan(0);
    expect(slide.tipBoxes?.[0]?.title).toMatch(/tip/i);
  });

  it('does NOT overwrite existing rich fields', () => {
    const slide = makeBodySlide({
      codeSnippet: { language: 'python', code: 'def f(): pass' },
      complexity: 'Time: O(1)',
      diagramSpec: {
        type: 'array',
        title: 'Existing',
        elements: [{ label: 'a' }, { label: 'b' }],
      },
      tipBoxes: [{ title: 'Existing', body: 'Existing tip' }],
      bullets: [
        'Bubble Sort — O(n²)',
        'Insertion Sort — O(n²)',
        'Quick Sort — O(n log n)',
      ],
    });
    const deck = makeDeck([slide]);
    const result = enrichCarouselDeckRichContent(deck, {
      topicLower: 'sorting java',
    });
    expect(slide.codeSnippet?.language).toBe('python');
    expect(slide.complexity).toBe('Time: O(1)');
    expect(slide.diagramSpec?.title).toBe('Existing');
    expect(slide.tipBoxes?.[0]?.title).toBe('Existing');
    expect(result.fieldsAdded.codeSnippet).toBe(0);
    expect(result.fieldsAdded.complexity).toBe(0);
    expect(result.fieldsAdded.diagramSpec).toBe(0);
    expect(result.fieldsAdded.tipBoxes).toBe(0);
  });

  it('skips cover/toc/outro slides', () => {
    const cover = makeBodySlide({
      sectionType: 'cover',
      bullets: [
        'Bubble Sort — O(n²)',
        'Insertion Sort — O(n²)',
        'Quick Sort — O(n log n)',
      ],
    });
    const toc = makeBodySlide({ sectionType: 'toc' });
    const outro = makeBodySlide({ sectionType: 'outro' });
    const deck = makeDeck([cover, toc, outro]);
    const result = enrichCarouselDeckRichContent(deck, {
      topicLower: 'sorting cheatsheet',
    });
    expect(result.slidesEnriched).toBe(0);
    expect(cover.diagramSpec).toBeUndefined();
  });

  it('does not synthesize a diagram with fewer than 3 splittable bullets', () => {
    const slide = makeBodySlide({
      bullets: [
        'Bubble Sort — O(n²) but simple',
        'Plain narrative bullet without name-detail pattern',
        'Another plain narrative bullet',
      ],
    });
    const deck = makeDeck([slide]);
    enrichCarouselDeckRichContent(deck, { topicLower: 'sorting' });
    expect(slide.diagramSpec).toBeUndefined();
  });
});

describe('scoreCarouselRichness', () => {
  it('reports zero for empty decks', () => {
    expect(scoreCarouselRichness({ slides: [] }).averageRichScore).toBe(0);
  });

  it('rewards filled rich fields', () => {
    const slide = makeBodySlide({
      paragraph:
        'A flowing teaching paragraph that exceeds forty characters to count.',
      bullets: ['one bullet', 'two bullet', 'three bullet', 'four bullet'],
      codeSnippet: { language: 'java', code: 'System.out.println();' },
      complexity: 'Time: O(1)',
      diagramSpec: {
        type: 'array',
        elements: [{ label: 'a' }, { label: 'b' }],
      },
      tipBoxes: [{ title: 'Tip', body: 'Body' }],
      notebookSections: [{ subheading: 'x', lines: ['line one'] }],
    });
    const score = scoreCarouselRichness({ slides: [slide] });
    expect(score.averageRichScore).toBe(7);
    expect(score.bodySlides).toBe(1);
  });
});
