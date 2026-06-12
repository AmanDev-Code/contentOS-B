import {
  buildResearchPromptContext,
  detectResearchIntent,
} from './web-research-intent';

describe('web-research-intent', () => {
  it('detects meta prompts that need live research first', () => {
    expect(
      detectResearchIntent('find latest trends and create post around it'),
    ).toBe(true);
    expect(detectResearchIntent('Java DSA arrays interview tips')).toBe(false);
  });

  it('builds a trend search query instead of the raw instruction', () => {
    const ctx = buildResearchPromptContext(
      'find latest trends in AI and create post around it',
      'linkedin',
    );
    expect(ctx.isResearchIntent).toBe(true);
    expect(ctx.searchQuery.toLowerCase()).toContain('ai');
    expect(ctx.searchQuery.toLowerCase()).not.toContain('create post');
    expect(ctx.tavilyTopic).toBe('news');
    expect(ctx.timeRange).toBe('week');
  });

  it('uses platform context for vague trend requests', () => {
    const ctx = buildResearchPromptContext(
      'find latest trends and create post around it',
      'linkedin',
    );
    expect(ctx.isResearchIntent).toBe(true);
    expect(ctx.searchQuery.toLowerCase()).toContain('linkedin');
  });
});
