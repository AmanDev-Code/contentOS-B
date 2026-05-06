import {
  expandSparseCarouselSlides,
  reanalyzeCarouselAfterExpansion,
} from './carousel-sparse-expansion';
import { analyzeCarouselQuality } from './carousel-quality';

describe('carousel-sparse-expansion', () => {
  /** Avoid JAVA_DSA_DECK_TERMS gate; keep “filled handwriting” style topic. */
  const topic =
    'complete handwritten dense study notes for exam preparation and lecture recap';

  it('expands thin dense slides to pass quality without a second model call', () => {
    const thin = Array.from({ length: 12 }, (_, i) => ({
      title: `Exam prep focal point ${i + 1} lecture notes`,
      body: 'Short body placeholder for expansion pathway testing. '.repeat(2),
      imagePrompt:
        'overhead desk dotted notebook paper faint pencil shading study texture background',
      notebookSections: [
        {
          subheading: 'Notes',
          lines: ['thin'],
        },
      ],
      marginNotes: ['x'],
      bullets: [] as string[],
    }));

    const before = analyzeCarouselQuality({
      slides: thin,
      expectedCount: 12,
      topicLower: topic,
      resolvedVisualStyle: 'handwritten_notebook_dense',
      noteDensity: 'dense',
      programmingModeEffective: false,
    });
    expect(before.length).toBeGreaterThan(0);

    const { slides, issues } = reanalyzeCarouselAfterExpansion({
      slides: thin,
      expectedCount: 12,
      topicLower: topic,
      resolvedVisualStyle: 'handwritten_notebook_dense',
      noteDensity: 'dense',
      programmingModeEffective: false,
      scaffoldFullNotebookPages: true,
    });

    expect(issues).toHaveLength(0);
    expect(slides[0].notebookSections?.length).toBeGreaterThanOrEqual(2);
    expect(slides[0].marginNotes?.length).toBeGreaterThanOrEqual(2);
  });

  it('expandSparseCarouselSlides is a no-op for scaffold=false', () => {
    const slide = {
      title: 'T',
      body: 'B'.repeat(80),
      imagePrompt: 'notebook paper desk top-down study ruled texture',
      bullets: ['one two three four five six seven eight'],
    };
    const out = expandSparseCarouselSlides([slide], {
      topicLower: 'misc topic',
      programmingModeEffective: false,
      noteDensity: 'standard',
      scaffoldFullNotebookPages: false,
    });
    expect(out[0].notebookSections).toBeUndefined();
  });
});
