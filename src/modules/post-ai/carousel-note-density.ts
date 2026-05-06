import type { CarouselVisualStyle } from './carousel-visual-style';
import { isNotebookPaperCarouselStyle } from './carousel-visual-style';
import type { CarouselNoteDensityLevel } from './custom-topic.schemas';

export function resolveCarouselNoteDensity(params: {
  explicit?: CarouselNoteDensityLevel | undefined;
  resolvedVisualStyle: CarouselVisualStyle;
  wordLimitKind: string;
}): CarouselNoteDensityLevel {
  if (params.explicit) return params.explicit;
  if (params.wordLimitKind === 'short') return 'compact';
  if (isNotebookPaperCarouselStyle(params.resolvedVisualStyle)) return 'dense';
  return 'standard';
}
