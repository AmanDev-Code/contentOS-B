import { resolveCustomTopicTextModel } from './custom-topic-text-model';

describe('resolveCustomTopicTextModel', () => {
  const env = {
    customTopicModel: 'gpt-4o-mini',
    customTopicCarouselModel: 'gpt-4.1',
  };

  it('uses CUSTOM_TOPIC_CAROUSEL_MODEL for heavy handwritten carousel when set', () => {
    const m = resolveCustomTopicTextModel({
      ...env,
      contentType: 'carousel',
      noteDensity: 'dense',
      resolvedVisualStyle: 'handwritten_notebook_dense',
      slideCount: 12,
    });
    expect(m).toBe('gpt-4.1');
  });

  it('falls back to CUSTOM_TOPIC_MODEL when carousel override is unset', () => {
    const m = resolveCustomTopicTextModel({
      customTopicModel: 'gpt-4o-mini',
      customTopicCarouselModel: undefined,
      contentType: 'carousel',
      noteDensity: 'dense',
      resolvedVisualStyle: 'handwritten_notebook',
      slideCount: 12,
    });
    expect(m).toBe('gpt-4o-mini');
  });

  it('uses base model for short non-notebook carousels', () => {
    const m = resolveCustomTopicTextModel({
      ...env,
      contentType: 'carousel',
      noteDensity: 'standard',
      resolvedVisualStyle: 'stock_visual',
      slideCount: 6,
    });
    expect(m).toBe('gpt-4o-mini');
  });

  it('uses base model for text posts', () => {
    expect(
      resolveCustomTopicTextModel({
        ...env,
        contentType: 'text',
        slideCount: undefined,
      }),
    ).toBe('gpt-4o-mini');
  });
});
