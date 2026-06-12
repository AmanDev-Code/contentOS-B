import { LinkedInAuthService, type LinkedInAuthConfig } from '../linkedin-auth.service';
import { AuthFailedError } from '../../../types';

const config: LinkedInAuthConfig = {
  clientId: 'client-123',
  clientSecret: 'secret-xyz',
  redirectUri: 'https://app.test/linkedin/callback',
};

interface FakeFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  handler: (url: string, init?: RequestInit) => { ok: boolean; status: number; body: unknown },
): { fn: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { ok, status, body } = handler(url, init);
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('LinkedInAuthService', () => {
  it('builds an authorization URL with required params', async () => {
    const svc = new LinkedInAuthService(config);
    const { url } = await svc.getAuthorizationUrl('state-abc', ['openid', 'w_member_social']);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(parsed.searchParams.get('client_id')).toBe('client-123');
    expect(parsed.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(parsed.searchParams.get('state')).toBe('state-abc');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe('openid w_member_social');
  });

  it('exchanges an auth code for tokens', async () => {
    const { fn, calls } = fakeFetch(() => ({
      ok: true,
      status: 200,
      body: {
        access_token: 'access-1',
        expires_in: 5184000,
        refresh_token: 'refresh-1',
        refresh_token_expires_in: 5184000,
        scope: 'openid profile w_member_social',
      },
    }));
    const svc = new LinkedInAuthService(config, fn);

    const tokens = await svc.exchangeCodeForTokens('the-code');
    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.scopes).toEqual(['openid', 'profile', 'w_member_social']);
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const sentBody = String(calls[0].init?.body);
    expect(sentBody).toContain('grant_type=authorization_code');
    expect(sentBody).toContain('code=the-code');
  });

  it('refreshes tokens using the refresh grant', async () => {
    const { fn, calls } = fakeFetch(() => ({
      ok: true,
      status: 200,
      body: { access_token: 'access-2', expires_in: 5184000, refresh_token: 'refresh-2' },
    }));
    const svc = new LinkedInAuthService(config, fn);

    const tokens = await svc.refreshTokens('old-refresh');
    expect(tokens.accessToken).toBe('access-2');
    const sentBody = String(calls[0].init?.body);
    expect(sentBody).toContain('grant_type=refresh_token');
    expect(sentBody).toContain('refresh_token=old-refresh');
  });

  it('throws AuthFailedError when the token endpoint rejects', async () => {
    const { fn } = fakeFetch(() => ({ ok: false, status: 400, body: { error: 'invalid_grant' } }));
    const svc = new LinkedInAuthService(config, fn);
    await expect(svc.refreshTokens('dead-token')).rejects.toBeInstanceOf(AuthFailedError);
  });

  it('never throws on revoke (best-effort contract)', async () => {
    const { fn } = fakeFetch(() => {
      throw new Error('network down');
    });
    const svc = new LinkedInAuthService(config, fn);
    await expect(svc.revokeTokens('token')).resolves.toBeUndefined();
  });

  it('validates granted vs required scopes', () => {
    const svc = new LinkedInAuthService(config);
    expect(svc.validateScopes(['openid', 'w_member_social'], ['openid'])).toEqual({
      ok: true,
      missing: [],
    });
    expect(svc.validateScopes(['openid'], ['openid', 'w_member_social'])).toEqual({
      ok: false,
      missing: ['w_member_social'],
    });
  });
});
