import {
  buildFrontendOAuthRedirect,
  sanitizeReturnTo,
} from './sanitize-return-to';

describe('sanitizeReturnTo', () => {
  it('accepts valid relative paths', () => {
    expect(sanitizeReturnTo('/dashboard')).toBe('/dashboard');
    expect(sanitizeReturnTo('/settings')).toBe('/settings');
  });

  it('rejects external and protocol-relative URLs', () => {
    expect(sanitizeReturnTo('https://evil.com')).toBe('/settings');
    expect(sanitizeReturnTo('//evil.com')).toBe('/settings');
  });

  it('falls back for invalid input', () => {
    expect(sanitizeReturnTo(undefined)).toBe('/settings');
    expect(sanitizeReturnTo('')).toBe('/settings');
    expect(sanitizeReturnTo('dashboard')).toBe('/settings');
  });
});

describe('buildFrontendOAuthRedirect', () => {
  it('builds redirect URL with query params', () => {
    expect(
      buildFrontendOAuthRedirect('https://app.test', '/dashboard', {
        linkedin: 'connected',
        flow: 'connect-pages',
      }),
    ).toBe(
      'https://app.test/dashboard?linkedin=connected&flow=connect-pages',
    );
  });

  it('uses sanitized path on unsafe returnTo', () => {
    expect(
      buildFrontendOAuthRedirect('https://app.test', 'https://evil.com', {
        linkedin: 'error',
        reason: 'oauth_denied',
      }),
    ).toBe('https://app.test/settings?linkedin=error&reason=oauth_denied');
  });
});
