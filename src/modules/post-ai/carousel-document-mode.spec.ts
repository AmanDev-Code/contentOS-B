import {
  resolveCarouselDocumentMode,
  documentThemeForMode,
  isDocumentDeckPreset,
  planDocumentDeckPages,
} from './carousel-document-mode';

describe('resolveCarouselDocumentMode', () => {
  it('returns none + default when tonality is not educational', () => {
    expect(
      resolveCarouselDocumentMode({
        topic: 'handwritten notebook DSA pages',
        tonality: 'professional',
        contentType: 'carousel',
      }),
    ).toEqual({ resolved: 'none', source: 'default' });
  });

  it('returns none + default when contentType is not carousel', () => {
    expect(
      resolveCarouselDocumentMode({
        topic: 'study notes',
        tonality: 'educational',
        contentType: 'image',
      }),
    ).toEqual({ resolved: 'none', source: 'default' });
  });

  it('honors explicit overrides', () => {
    expect(
      resolveCarouselDocumentMode({
        topic: 'something off-topic',
        tonality: 'educational',
        contentType: 'carousel',
        override: 'handwritten_notes',
      }),
    ).toEqual({ resolved: 'handwritten_notes', source: 'explicit' });

    expect(
      resolveCarouselDocumentMode({
        topic: 'something off-topic',
        tonality: 'educational',
        contentType: 'carousel',
        override: 'structured_document',
      }),
    ).toEqual({ resolved: 'structured_document', source: 'explicit' });

    expect(
      resolveCarouselDocumentMode({
        topic: 'study notes for DSA',
        tonality: 'educational',
        contentType: 'carousel',
        override: 'none',
      }),
    ).toEqual({ resolved: 'none', source: 'explicit' });
  });

  it('infers handwritten_notes from notebook cues', () => {
    for (const topic of [
      'DSA handwritten notes carousel',
      'Linear algebra study notes 12 pages',
      'My lecture notes notebook for OS',
      'Cram sheet for biology',
    ]) {
      const r = resolveCarouselDocumentMode({
        topic,
        tonality: 'educational',
        contentType: 'carousel',
        override: 'auto',
      });
      expect(r.source).toBe('inferred');
      expect(r.resolved).toBe('handwritten_notes');
    }
  });

  it('infers structured_document from ebook/pdf/document cues', () => {
    for (const topic of [
      'Build a JavaScript ebook 10 pages',
      'Whitepaper-style document on RAG architectures',
      'Interview prep guide PDF style',
      'Reference manual for DSA in Java',
      'Study guide curriculum overview',
    ]) {
      const r = resolveCarouselDocumentMode({
        topic,
        tonality: 'educational',
        contentType: 'carousel',
        override: 'auto',
      });
      expect(r.source).toBe('inferred');
      expect(r.resolved).toBe('structured_document');
    }
  });

  it('falls back to none when topic gives no clue and override is auto', () => {
    const r = resolveCarouselDocumentMode({
      topic: 'A neutral topic with no preset hint',
      tonality: 'educational',
      contentType: 'carousel',
      override: 'auto',
    });
    expect(r.resolved).toBe('none');
    expect(r.source).toBe('default');
  });
});

describe('documentThemeForMode + isDocumentDeckPreset', () => {
  it('maps modes to themes', () => {
    expect(documentThemeForMode('handwritten_notes')).toBe('notebook');
    expect(documentThemeForMode('structured_document')).toBe('clean_document');
  });

  it('isDocumentDeckPreset narrows correctly', () => {
    expect(isDocumentDeckPreset('handwritten_notes')).toBe(true);
    expect(isDocumentDeckPreset('structured_document')).toBe(true);
    expect(isDocumentDeckPreset('none')).toBe(false);
  });
});

describe('planDocumentDeckPages', () => {
  it('reserves cover, TOC, body, and outro for ≥6-slide decks', () => {
    const plan = planDocumentDeckPages(12);
    expect(plan.coverPage).toBe(1);
    expect(plan.tocPage).toBe(2);
    expect(plan.outroPage).toBe(12);
    expect(plan.bodyPages).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(plan.totalPages).toBe(12);
  });

  it('skips outro on tiny decks (<6 slides)', () => {
    const plan = planDocumentDeckPages(5);
    expect(plan.coverPage).toBe(1);
    expect(plan.tocPage).toBe(2);
    expect(plan.outroPage).toBeNull();
    expect(plan.bodyPages).toEqual([3, 4, 5]);
    expect(plan.totalPages).toBe(5);
  });

  it('clamps to 2 when given absurdly small input', () => {
    const plan = planDocumentDeckPages(1);
    expect(plan.totalPages).toBe(2);
    expect(plan.bodyPages).toEqual([]);
  });

  it('clamps to 40 when given absurdly large input', () => {
    const plan = planDocumentDeckPages(100);
    expect(plan.totalPages).toBe(40);
  });
});
