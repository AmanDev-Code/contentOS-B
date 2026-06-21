import {
  assertLinkedInCommentaryWithinLimit,
  buildLinkedInCommentary,
  linkedInCommentaryLength,
  LINKEDIN_MAX_TEXT_LENGTH,
} from './linkedin-publish-text';

describe('linkedin-publish-text length validation', () => {
  it('counts appended hashtags in final commentary length', () => {
    const body = 'a'.repeat(LINKEDIN_MAX_TEXT_LENGTH - 10);
    const hashtags = ['#AI', '#Tech'];

    const length = linkedInCommentaryLength(body, hashtags);
    const text = buildLinkedInCommentary(body, hashtags);

    expect(length).toBe(text.length);
    expect(length).toBeGreaterThan(LINKEDIN_MAX_TEXT_LENGTH);
  });

  it('assertLinkedInCommentaryWithinLimit throws when body + hashtags exceed cap', () => {
    const body = 'b'.repeat(LINKEDIN_MAX_TEXT_LENGTH);
    const hashtags = ['#Overflow'];

    expect(() => assertLinkedInCommentaryWithinLimit(body, hashtags)).toThrow(
      /3000-character limit/,
    );
  });

  it('assertLinkedInCommentaryWithinLimit passes when within cap', () => {
    const body = 'Short post about AI agents.';
    const hashtags = ['#AI'];

    const text = assertLinkedInCommentaryWithinLimit(body, hashtags);
    expect(text).toContain('#AI');
    expect(text.length).toBeLessThanOrEqual(LINKEDIN_MAX_TEXT_LENGTH);
  });
});
