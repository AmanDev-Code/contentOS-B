import type { CarouselNoteDensityLevel } from './custom-topic.schemas';
import type { CarouselVisualStyle } from './carousel-visual-style';
import { isNotebookPaperCarouselStyle } from './carousel-visual-style';

/**
 * Text model selection for custom-topic OpenAI calls.
 *
 * - `CUSTOM_TOPIC_MODEL` — default for all custom-topic JSON (text, image prompts, carousel).
 * - `CUSTOM_TOPIC_CAROUSEL_MODEL` — optional stronger model for heavy handwritten / dense
 *   carousel slide JSON (same chat-completions API). Image generation uses the media pipeline,
 *   not this setting.
 *
 * When unset, carousel heavy jobs reuse `CUSTOM_TOPIC_MODEL` (or gpt-4o default in service).
 */
export function resolveCustomTopicTextModel(params: {
  contentType: 'text' | 'image' | 'carousel';
  noteDensity?: CarouselNoteDensityLevel;
  resolvedVisualStyle?: CarouselVisualStyle;
  slideCount?: number;
  /** Base model (from CUSTOM_TOPIC_MODEL or service default) */
  customTopicModel: string;
  /** Optional override (CUSTOM_TOPIC_CAROUSEL_MODEL) */
  customTopicCarouselModel?: string;
}): string {
  const {
    contentType,
    noteDensity,
    resolvedVisualStyle,
    slideCount,
    customTopicModel,
    customTopicCarouselModel,
  } = params;

  if (contentType !== 'carousel') {
    return customTopicModel;
  }

  const slides = slideCount ?? 0;
  const denseOrNotebookDense =
    noteDensity === 'dense' || resolvedVisualStyle === 'handwritten_notebook_dense';
  const longHandwrittenNotebook = resolvedVisualStyle === 'handwritten_notebook' && slides >= 10;
  const twelveSlideNotebook =
    resolvedVisualStyle != null &&
    isNotebookPaperCarouselStyle(resolvedVisualStyle) &&
    slides >= 12;

  const heavyCarousel = denseOrNotebookDense || longHandwrittenNotebook || twelveSlideNotebook;

  if (!heavyCarousel) {
    return customTopicModel;
  }

  return customTopicCarouselModel?.trim() || customTopicModel;
}
