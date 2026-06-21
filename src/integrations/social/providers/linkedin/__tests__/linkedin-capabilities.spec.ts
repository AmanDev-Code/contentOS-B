import {
  LinkedInCapabilities,
  escapeLinkedInText,
  LINKEDIN_MAX_TEXT_LENGTH,
} from '../linkedin-capabilities';

describe('LinkedInCapabilities', () => {
  it('reports Sprint 1.3 scope: images yes, video/carousel no', () => {
    const caps = new LinkedInCapabilities().getCapabilities();
    expect(caps.supportsImages).toBe(true);
    expect(caps.supportsVideo).toBe(false);
    expect(caps.supportsCarousel).toBe(false);
    expect(caps.maxImagesPerPost).toBe(1);
    expect(caps.maxTextLength).toBe(LINKEDIN_MAX_TEXT_LENGTH);
    expect(caps.supportsScheduling).toBe(true);
  });

  it('exposes a stable frozen capabilities object', () => {
    const provider = new LinkedInCapabilities();
    expect(provider.getCapabilities()).toBe(provider.getCapabilities());
    expect(Object.isFrozen(provider.getCapabilities())).toBe(true);
  });
});

describe('escapeLinkedInText', () => {
  it('escapes reserved characters with a backslash', () => {
    expect(escapeLinkedInText('Hello (world)')).toBe('Hello \\(world\\)');
    expect(escapeLinkedInText('a@b#c')).toBe('a\\@b\\#c');
  });

  it('leaves plain text untouched', () => {
    expect(escapeLinkedInText('Just a normal sentence.')).toBe(
      'Just a normal sentence.',
    );
  });

  it('is the same function referenced by capabilities (WYSIWYG parity)', () => {
    const caps = new LinkedInCapabilities().getCapabilities();
    expect(caps.characterEscape).toBe(escapeLinkedInText);
  });
});
