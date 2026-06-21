import {
  inferCarouselVisualStyleFromTopic,
  resolveCarouselVisualStyle,
  overlayProfileForCarouselStyle,
} from './carousel-visual-style';

describe('carousel visual style', () => {
  describe('inferCarouselVisualStyleFromTopic', () => {
    it('maps multi-page note requests to dense notebook style and other notebook phrases to handwritten_notebook', () => {
      expect(
        inferCarouselVisualStyleFromTopic(
          '12-page handwritten notes for java collections interview prep'.toLowerCase(),
        ),
      ).toBe('handwritten_notebook_dense');
      expect(
        inferCarouselVisualStyleFromTopic(
          'carousel with study notes style on dotted paper'.toLowerCase(),
        ),
      ).toBe('handwritten_notebook');
    });

    it('maps whiteboard phrases', () => {
      expect(
        inferCarouselVisualStyleFromTopic('explain b-trees whiteboard style'),
      ).toBe('whiteboard_notes');
    });

    it('forces notebook mood for DSA / LeetCode / interview prep without explicit notebook words', () => {
      expect(
        inferCarouselVisualStyleFromTopic('java dsa cheatsheet carousel'),
      ).toBe('handwritten_notebook');
      expect(
        inferCarouselVisualStyleFromTopic('leetcode roadmap for FAANG'),
      ).toBe('handwritten_notebook');
    });

    it('defaults to stock_visual when no cues', () => {
      expect(
        inferCarouselVisualStyleFromTopic('product launch teaser q4'),
      ).toBe('stock_visual');
    });
  });

  describe('resolveCarouselVisualStyle', () => {
    it('respects explicit override over topic inference', () => {
      const r = resolveCarouselVisualStyle(
        'handwritten notes java',
        'diagram_clean',
      );
      expect(r.resolved).toBe('diagram_clean');
      expect(r.source).toBe('explicit');
    });

    it('uses inference when auto', () => {
      const r = resolveCarouselVisualStyle('pages of interview prep', 'auto');
      expect(r.resolved).toBe('handwritten_notebook');
      expect(r.source).toBe('inferred');
    });
  });

  describe('overlayProfileForCarouselStyle', () => {
    it('maps notebook + whiteboard styles to distinct overlay compositors', () => {
      expect(overlayProfileForCarouselStyle('handwritten_notebook')).toBe(
        'notebook_paper',
      );
      expect(overlayProfileForCarouselStyle('whiteboard_notes')).toBe(
        'whiteboard',
      );
      expect(overlayProfileForCarouselStyle('diagram_clean')).toBe(
        'linkedin_panel',
      );
    });
  });
});
