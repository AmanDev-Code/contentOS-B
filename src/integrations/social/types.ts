// Core domain types for the Trndinn social integrations layer.
//
// Design notes:
//   * `ConnectedAccount` is a domain DTO mapped from the `social_accounts` row at
//     the service boundary. Provider implementations must NEVER receive a raw
//     database row; that keeps providers free of persistence concerns and makes
//     them trivially unit-testable.
//   * The error hierarchy distinguishes between recoverable conditions
//     (`RateLimitError`, `RefreshRequiredError`) and terminal ones
//     (`AuthFailedError`, `ScopeInsufficientError`, `PlatformBadRequestError`).
//     The publish pipeline uses these classes — not strings — to decide whether
//     to retry, refresh tokens, or surface a re-auth banner to the user.
//   * Token transport uses `OAuthTokenSet`, never the raw vault rows. Persistence
//     of secrets stays inside the token-vault service (Sprint 1.3) and out of
//     the provider surface.

export type Platform =
  | 'linkedin'
  | 'x'
  | 'instagram'
  | 'threads'
  | 'facebook'
  | 'youtube'
  | 'tiktok';

export const SUPPORTED_PLATFORMS: readonly Platform[] = ['linkedin'] as const;

export type IntegrationStatus =
  | 'active'
  | 'reauth_required'
  | 'disabled'
  | 'deleted';

export type AccountType = 'personal' | 'organization';

export type MediaKind = 'image' | 'video' | 'document' | 'pdf';

export interface ConnectedAccount {
  readonly id: string;
  readonly userId: string;
  readonly platform: Platform;
  readonly platformAccountId: string;
  readonly accountType: AccountType;
  readonly displayName: string | null;
  readonly profileUrl: string | null;
  readonly avatarUrl: string | null;
  readonly status: IntegrationStatus;
  readonly connectedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface OAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: Date;
  readonly refreshExpiresAt?: Date;
  readonly scopes: readonly string[];
}

export type OAuthScope = string;

export interface MediaAttachment {
  readonly id: string;
  readonly kind: MediaKind;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly storagePath: string;
  readonly originalFilename?: string;
  readonly altText?: string;
}

export interface PostPayload {
  readonly content: string;
  readonly media: readonly MediaAttachment[];
  readonly threadParentPlatformPostId?: string;
  readonly reshareOfPlatformPostId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PublishResult {
  readonly platformPostId: string;
  readonly platformPostUrl?: string;
  readonly publishedAt: Date;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface AccountAnalytics {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly metrics: Readonly<Record<string, number>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface PostAnalytics {
  readonly platformPostId: string;
  readonly capturedAt: Date;
  readonly metrics: Readonly<Record<string, number>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface ScopeValidation {
  readonly ok: boolean;
  readonly missing: readonly string[];
}

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

export interface ProviderErrorContext {
  readonly platform?: Platform;
  readonly platformErrorCode?: string;
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;
  readonly correlationId?: string;
  readonly raw?: unknown;
}

export abstract class ProviderError extends Error {
  public readonly context: Readonly<ProviderErrorContext>;

  protected constructor(message: string, context: ProviderErrorContext = {}) {
    super(message);
    this.name = new.target.name;
    this.context = Object.freeze({ ...context });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AuthFailedError extends ProviderError {
  public constructor(message: string, context: ProviderErrorContext = {}) {
    super(message, context);
  }
}

export class ScopeInsufficientError extends ProviderError {
  public readonly missingScopes: readonly string[];

  public constructor(
    message: string,
    missingScopes: readonly string[],
    context: ProviderErrorContext = {},
  ) {
    super(message, context);
    this.missingScopes = Object.freeze([...missingScopes]);
  }
}

export class RateLimitError extends ProviderError {
  public constructor(message: string, context: ProviderErrorContext = {}) {
    super(message, context);
  }
}

export class RefreshRequiredError extends ProviderError {
  public constructor(
    message: string = 'Access token expired or rejected; refresh required',
    context: ProviderErrorContext = {},
  ) {
    super(message, context);
  }
}

export class PlatformBadRequestError extends ProviderError {
  public constructor(message: string, context: ProviderErrorContext = {}) {
    super(message, context);
  }
}

export class PlatformInternalError extends ProviderError {
  public constructor(message: string, context: ProviderErrorContext = {}) {
    super(message, context);
  }
}

// Thrown when a user attempts to OAuth-connect a platform account that is
// already linked to a different Trndinn user. Enforces the founder-mandated
// global uniqueness of social-account ownership (see migration
// 20260601000014_social_accounts_global_unique.sql).
//
// HTTP semantics: callers MUST translate this to HTTP 409 Conflict and surface
// the message verbatim so the connecting user understands the resolution path
// (the existing owner must disconnect before re-claiming the account).
export class SocialAccountAlreadyConnectedError extends ProviderError {
  public readonly platform: Platform;
  public readonly platformAccountId: string;

  public constructor(
    platform: Platform,
    platformAccountId: string,
    context: ProviderErrorContext = {},
  ) {
    super(
      `This ${platform} account is already connected to another Trndinn user. Ask them to disconnect first, or contact support.`,
      { ...context, platform, httpStatus: context.httpStatus ?? 409 },
    );
    this.platform = platform;
    this.platformAccountId = platformAccountId;
  }
}
