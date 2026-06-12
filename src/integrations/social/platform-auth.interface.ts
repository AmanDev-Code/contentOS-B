import type { OAuthTokenSet, ScopeValidation } from './types';

// OAuth lifecycle for a single social platform.
//
// Why this is a separate interface from `PlatformPublisher`:
//   Auth and publishing have very different testing, rate-limit, and rotation
//   surfaces. Splitting them lets us mock auth in publish tests, swap auth
//   strategies (e.g. add PKCE to a platform later) without touching publishers,
//   and gate token-vault access at a single seam (Sprint 1.3).

export interface AuthorizationUrlResult {
  readonly url: string;
  readonly codeVerifier?: string;
}

export interface PlatformAuth {
  getAuthorizationUrl(state: string, scopes: readonly string[]): Promise<AuthorizationUrlResult>;

  exchangeCodeForTokens(code: string, codeVerifier?: string): Promise<OAuthTokenSet>;

  refreshTokens(refreshToken: string): Promise<OAuthTokenSet>;

  // Best-effort: implementations MUST swallow platform errors and resolve.
  // Local revocation of stored tokens is the caller's responsibility.
  revokeTokens(accessToken: string): Promise<void>;

  validateScopes(granted: readonly string[], required: readonly string[]): ScopeValidation;

  getRequiredScopes(): readonly string[];
}
