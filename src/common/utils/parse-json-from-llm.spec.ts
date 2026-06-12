import {
  parseJsonFromLlmPayload,
  repairUnescapedQuotesInJsonStrings,
  sanitizeJavascriptTokensInJson,
} from './parse-json-from-llm';

describe('sanitizeJavascriptTokensInJson', () => {
  it('replaces : undefined with : null', () => {
    const raw = '{"bullets": undefined, "cta": "x"}';
    expect(JSON.parse(sanitizeJavascriptTokensInJson(raw))).toEqual({
      bullets: null,
      cta: 'x',
    });
  });
});

describe('parseJsonFromLlmPayload', () => {
  it('parses real-world image post with undefined bullets', () => {
    const raw = `{"caption":"Instagram is the new résumé.","hashtags": [], "bullets": undefined, "cta": "Drop it", "keywords": ["a"], "imagePrompts": ["scene"]}`;
    const parsed = parseJsonFromLlmPayload(raw) as Record<string, unknown>;
    expect(parsed.caption).toContain('Instagram');
    expect(parsed.bullets).toBeNull();
    expect(parsed.imagePrompts).toEqual(['scene']);
  });

  it('parses markdown-fenced JSON', () => {
    const raw = '```json\n{"caption":"hi","hashtags":[]}\n```';
    expect(parseJsonFromLlmPayload(raw)).toEqual({
      caption: 'hi',
      hashtags: [],
    });
  });

  it('repairs unescaped double quotes inside caption strings', () => {
    const broken =
      '{"caption": "the difference between "we have an approval feature" and "approval is mandatory"", "hashtags": [], "keywords": ["a"], "imagePrompts": ["scene"]}';
    const parsed = parseJsonFromLlmPayload(broken) as Record<string, unknown>;
    expect(parsed.caption).toContain('we have an approval feature');
    expect(parsed.imagePrompts).toEqual(['scene']);
  });
});

describe('repairUnescapedQuotesInJsonStrings', () => {
  it('preserves JSON keys', () => {
    const raw = '{"caption": "hello"}';
    expect(repairUnescapedQuotesInJsonStrings(raw)).toBe(raw);
  });
});
