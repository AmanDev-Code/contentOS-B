import { Logger } from '@nestjs/common';
import type { PlatformAuth, AuthorizationUrlResult } from '../../platform-auth.interface';
import {
  AuthFailedError,
  type OAuthTokenSet,
  type ScopeValidation,
} from '../../types';

// LinkedIn OAuth 2.0 (authorization code grant).
//
// Built as a plain, dependency-light class (not a Nest @Injectable) so it is
// trivially unit-testable: tests construct it with a fake `fetchImpl` and assert
// on the exact requests sent. The Nest module wires the real config + global
// fetch via a factory provider.
//
// LinkedIn specifics (Phase 0 deep-map, Recallium #1054):
//   * NOT PKCE — LinkedIn's authorization-code flow uses a client secret, not a
//     code verifier. `codeVerifier` stays optional on the interface for other
//     platforms (e.g. Twitter) but LinkedIn ignores it.
//   * Access token ~60 days; refresh token rolling 60-day window.
//   * Token endpoint is form-urlencoded, NOT JSON.

export interface LinkedInAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

const AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const REVOKE_URL = 'https://www.linkedin.com/oauth/v2/revoke';
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

// Identity of the connected LinkedIn member, derived from the OIDC userinfo
// endpoint. `memberId` is the OIDC `sub` — the stable per-member id used as
// `social_accounts.platform_account_id` and to enforce global-unique ownership.
export interface LinkedInUserIdentity {
  readonly memberId: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly profileUrl?: string;
}

export interface LinkedInOrgPage {
  readonly organizationUrn: string;
  readonly organizationId: string;
  readonly name: string;
  readonly logoUrl?: string;
  readonly vanityName?: string;
}

// REQUIRED_SCOPES are the must-have set to publish as a personal profile —
// `validateScopes` fails the connection if any are missing.
const REQUIRED_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'w_member_social'];

// UNIFIED_SCOPES: Single OAuth flow requesting ALL approved scopes at once.
// This eliminates the "double OAuth" pattern where users had to re-authenticate
// for company pages. After OAuth, the frontend auto-shows a page picker if the
// user admins any organization pages.
//
// Approved scopes from LinkedIn Developer Portal:
// - openid, profile, email: OIDC identity
// - w_member_social: publish as personal profile
// - w_organization_social, r_organization_social: publish to / read from company pages
// - rw_organization_admin: list pages user admins
const UNIFIED_SCOPES: readonly string[] = [
  'openid',
  'profile',
  'email',
  'w_member_social',
  'w_organization_social',
  'r_organization_social',
  'rw_organization_admin',
];

// @deprecated - Use UNIFIED_SCOPES. Kept for backward compatibility during migration.
const PERSONAL_REQUESTED_SCOPES: readonly string[] = UNIFIED_SCOPES;

// @deprecated - Use UNIFIED_SCOPES. No longer needed; single flow handles both.
const ORG_PAGE_REQUESTED_SCOPES: readonly string[] = UNIFIED_SCOPES;

// Back-compat alias pointing to unified scopes.
const REQUESTED_SCOPES: readonly string[] = UNIFIED_SCOPES;

interface LinkedInTokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly refresh_token_expires_in?: number;
  readonly scope?: string;
}

export class LinkedInAuthService implements PlatformAuth {
  private readonly logger = new Logger(LinkedInAuthService.name);

  public constructor(
    private readonly config: LinkedInAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  public getRequiredScopes(): readonly string[] {
    return REQUIRED_SCOPES;
  }

  // The unified scope set we request at authorize time — includes both
  // personal profile and organization page scopes in a single OAuth flow.
  public getRequestedScopes(): readonly string[] {
    return UNIFIED_SCOPES;
  }

  // Unified scopes: single OAuth flow for both personal and org pages.
  public getUnifiedScopes(): readonly string[] {
    return UNIFIED_SCOPES;
  }

  // @deprecated - Use getUnifiedScopes(). Kept for backward compatibility.
  public getPersonalRequestedScopes(): readonly string[] {
    return UNIFIED_SCOPES;
  }

  // @deprecated - Use getUnifiedScopes(). No longer needed; single flow handles both.
  public getOrgPageRequestedScopes(): readonly string[] {
    return UNIFIED_SCOPES;
  }

  public async getAuthorizationUrl(
    state: string,
    scopes: readonly string[],
  ): Promise<AuthorizationUrlResult> {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      state,
      scope: (scopes.length > 0 ? scopes : REQUESTED_SCOPES).join(' '),
    });
    return { url: `${AUTHORIZE_URL}?${params.toString()}` };
  }

  public async exchangeCodeForTokens(code: string): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    return this.postToken(body, 'authorization_code');
  }

  public async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    return this.postToken(body, 'refresh_token');
  }

  public async revokeTokens(accessToken: string): Promise<void> {
    try {
      const body = new URLSearchParams({
        token: accessToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      });
      await this.fetchImpl(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      // Best-effort per the PlatformAuth contract: never throw on revoke.
      this.logger.warn(`LinkedIn token revoke failed (ignored): ${String(err)}`);
    }
  }

  // Fetch the connected member's identity. Used by the connection bridge to set
  // `platform_account_id` and enforce global-unique ownership.
  public async fetchUserIdentity(accessToken: string): Promise<LinkedInUserIdentity> {
    const response = await this.fetchImpl(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new AuthFailedError(
        `LinkedIn userinfo request failed (HTTP ${response.status}).`,
        { platform: 'linkedin', httpStatus: response.status },
      );
    }
    const data = (await response.json()) as {
      sub?: string;
      name?: string;
      picture?: string;
    };
    if (!data.sub) {
      throw new AuthFailedError('LinkedIn userinfo returned no member id (sub).', {
        platform: 'linkedin',
      });
    }
    return {
      memberId: data.sub,
      displayName: data.name,
      avatarUrl: data.picture,
    };
  }

  public validateScopes(
    granted: readonly string[],
    required: readonly string[],
  ): ScopeValidation {
    const grantedSet = new Set(granted);
    const missing = required.filter((scope) => !grantedSet.has(scope));
    return { ok: missing.length === 0, missing };
  }

  public async fetchAdminOrgPages(accessToken: string): Promise<LinkedInOrgPage[]> {
    const url =
      'https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR' +
      '&projection=(elements*(organization~(id,localizedName,vanityName,logoV2)))';
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Restli-Protocol-Version': '2.0.0',
      },
    });
    if (!response.ok) {
      this.logger.warn(`LinkedIn organizationAcls failed (HTTP ${response.status}).`);
      return [];
    }
    const data = (await response.json()) as {
      elements?: Array<{
        organization?: string;
        'organization~'?: {
          id?: number;
          localizedName?: string;
          vanityName?: string;
          logoV2?: unknown;
        };
      }>;
    };
    const elements = data.elements ?? [];
    return elements
      .filter((el) => el.organization)
      .map((el) => {
        const orgUrn = el.organization!;
        const resolved = el['organization~'];
        const orgId = orgUrn.split(':').pop() ?? '';
        const logoUrl = this.extractLogoUrl(resolved?.logoV2);
        return {
          organizationUrn: orgUrn,
          organizationId: orgId,
          name: resolved?.localizedName ?? orgUrn,
          logoUrl,
          vanityName: resolved?.vanityName,
        };
      });
  }

  private extractLogoUrl(logoV2: unknown): string | undefined {
    if (!logoV2 || typeof logoV2 !== 'object') return undefined;
    const stack: unknown[] = [logoV2];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (const child of node) stack.push(child);
        continue;
      }
      const record = node as Record<string, unknown>;
      if (typeof record.identifier === 'string' && record.identifier.startsWith('http')) {
        return record.identifier;
      }
      for (const child of Object.values(record)) {
        if (child && typeof child === 'object') stack.push(child);
      }
    }
    return undefined;
  }

  private async postToken(
    body: URLSearchParams,
    grant: 'authorization_code' | 'refresh_token',
  ): Promise<OAuthTokenSet> {
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const detail = await safeText(response);
      // A failed token exchange/refresh is terminal: the code is spent or the
      // refresh token is invalid. The caller must surface a reconnect prompt.
      throw new AuthFailedError(
        `LinkedIn ${grant} token request failed (HTTP ${response.status}).`,
        { platform: 'linkedin', httpStatus: response.status, raw: detail },
      );
    }

    const json = (await response.json()) as LinkedInTokenResponse;
    const now = Date.now();
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(now + json.expires_in * 1000),
      refreshExpiresAt:
        json.refresh_token_expires_in != null
          ? new Date(now + json.refresh_token_expires_in * 1000)
          : undefined,
      scopes: json.scope ? json.scope.split(/[\s,]+/).filter(Boolean) : [],
    };
  }
}

async function safeText(response: { text: () => Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}
