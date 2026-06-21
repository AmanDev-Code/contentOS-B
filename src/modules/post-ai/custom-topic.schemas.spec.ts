import {
  normalizeCustomTopicLlmPayload,
  safeParseCustomTopicPostOutput,
} from './custom-topic.schemas';

describe('custom-topic LLM normalization and parse', () => {
  it('coerces null bullets/keywords/hashtags and parses text output', () => {
    const raw = {
      caption: 'Hello world',
      hashtags: null,
      bullets: null,
      cta: null,
      keywords: null,
    };

    const normalized = normalizeCustomTopicLlmPayload(raw, 'text') as Record<
      string,
      unknown
    >;

    expect(normalized.bullets).toEqual([]);
    expect(normalized.keywords).toEqual([]);
    expect(normalized.hashtags).toEqual([]);
    expect('cta' in normalized).toBe(false);

    const parsed = safeParseCustomTopicPostOutput(raw, 'text');
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('error' in parsed.data).toBe(false);
      expect(parsed.data).toMatchObject({
        caption: 'Hello world',
        keywords: [],
        hashtags: [],
        bullets: [],
      });
    }
  });

  it('parses off_topic without union ambiguity', () => {
    const parsed = safeParseCustomTopicPostOutput(
      { error: 'off_topic' },
      'text',
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ error: 'off_topic' });
    }
  });

  it('null imagePrompts becomes empty array for image content type', () => {
    const raw = {
      caption: 'Cap',
      hashtags: [],
      keywords: ['a', 'b'],
      imagePrompts: null,
    };
    const parsed = safeParseCustomTopicPostOutput(raw, 'image');
    expect(parsed.success).toBe(true);
    if (parsed.success && !('error' in parsed.data)) {
      expect((parsed.data as any).imagePrompts).toEqual([]);
    }
  });
});
