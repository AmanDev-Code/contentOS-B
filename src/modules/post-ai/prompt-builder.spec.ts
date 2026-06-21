import { buildCustomTopicPrompt } from './prompt-builder';
import { resolveWordLimit } from './word-limit';
import { getTonalityGuide } from './tonality';
import type { PostGenerationInput } from './custom-topic.schemas';

describe('buildCustomTopicPrompt / off-topic instructions', () => {
  const carouselInput = {
    platform: 'linkedin',
    contentType: 'carousel',
    topic: 'messy english college fest vibes got stickers',
    tonality: 'casual_friendly',
    wordLimit: { kind: 'medium' },
    slideCount: 5,
    carouselVisualStyle: 'auto',
  } as PostGenerationInput;

  it('tells the model to accept rough fragments and defer uncertain cases to generation', () => {
    const { system } = buildCustomTopicPrompt(
      carouselInput,
      resolveWordLimit(carouselInput.wordLimit),
      getTonalityGuide(carouselInput.tonality),
      {
        resolvedVisualStyle: 'stock_visual',
        noteDensity: 'standard',
        programmingSupplement: false,
        intentPlan: null,
      },
    );
    const low = system.toLowerCase();
    expect(low).toMatch(/rough|fragment|shorthand/);
    expect(low).toMatch(/prefer generating|when in doubt|downstream quality/);
  });

  it('narrows explicit off_topic refusal to assistant chatter and jailbreak patterns', () => {
    const { system } = buildCustomTopicPrompt(
      {
        platform: 'linkedin',
        contentType: 'text',
        topic: 'how are you today',
        tonality: 'professional',
        wordLimit: { kind: 'short' },
      },
      resolveWordLimit({ kind: 'short' }),
      getTonalityGuide('professional'),
      null,
    );
    const low = system.toLowerCase();
    expect(low).toContain('error": "off_topic"');
    expect(low).toMatch(/small talk|chit-chat|how are you|jailbreak/);
  });

  it('uses legible handwriting image hints when nativeHandwritingInImage is set', () => {
    const { system } = buildCustomTopicPrompt(
      {
        ...carouselInput,
        tonality: 'educational',
        topic: 'DSA study notes handwritten notebook java',
        carouselVisualStyle: 'handwritten_notebook',
      },
      resolveWordLimit(carouselInput.wordLimit),
      getTonalityGuide('educational'),
      {
        resolvedVisualStyle: 'handwritten_notebook',
        noteDensity: 'dense',
        programmingSupplement: true,
        intentPlan: null,
        nativeHandwritingInImage: true,
      },
    );
    expect(system).toContain('LEGIBLE handwritten');
  });

  it('embeds rich-slide worked examples + diagram playbook + self-check (carousel non-document mode)', () => {
    const { system } = buildCustomTopicPrompt(
      carouselInput,
      resolveWordLimit(carouselInput.wordLimit),
      getTonalityGuide(carouselInput.tonality),
      {
        resolvedVisualStyle: 'stock_visual',
        noteDensity: 'standard',
        programmingSupplement: false,
        intentPlan: null,
      },
    );
    expect(system).toContain('WORKED EXAMPLES');
    expect(system).toContain('DIAGRAM PLAYBOOK');
    expect(system).toContain('SELF-CHECK');
    expect(system).toMatch(/Quick Sort in Java/);
    expect(system).toMatch(/Hash Maps/);
  });

  it('embeds rich-slide worked examples + self-check for document-deck (handwritten_notes)', () => {
    const { system } = buildCustomTopicPrompt(
      {
        ...carouselInput,
        tonality: 'educational',
        topic: 'DSA cheatsheet for FAANG interviews',
        slideCount: 8,
        carouselVisualStyle: 'handwritten_notebook',
      } as any,
      resolveWordLimit({ kind: 'medium' }),
      getTonalityGuide('educational'),
      {
        resolvedVisualStyle: 'handwritten_notebook',
        noteDensity: 'dense',
        programmingSupplement: true,
        intentPlan: null,
        documentMode: 'handwritten_notes',
        documentSlideCount: 8,
      },
    );
    expect(system).toContain('SELF-CHECK BEFORE RETURNING');
    expect(system).toContain('DIAGRAM PLAYBOOK');
    expect(system).toContain('WORKED EXAMPLES');
    expect(system).toMatch(/codeSnippet/);
    expect(system).toMatch(/diagramSpec/);
    expect(system).toMatch(/tipBoxes/);
    expect(system).toMatch(/complexity/);
  });
});
