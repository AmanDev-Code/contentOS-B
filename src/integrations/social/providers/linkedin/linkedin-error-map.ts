import {
  AuthFailedError,
  PlatformBadRequestError,
  PlatformInternalError,
  RateLimitError,
  RefreshRequiredError,
} from '../../types';
import type { ProviderError } from '../../types';
import type {
  PlatformErrorMap,
  PlatformErrorMapEntry,
} from '../../social-http-client';

// Maps LinkedIn HTTP responses to the shared typed error hierarchy.
//
// Design rule (from the architecture map): NO regex over error message text.
// LinkedIn's error bodies are unstable strings; we classify on
// (httpStatus, serviceErrorCode) only. The Phase 0 deep-map (Recallium #1054)
// documented these behaviours from the Postiz reference implementation:
//   * 401                       -> token rejected -> RefreshRequiredError
//   * 403                       -> scope/permission -> AuthFailedError (terminal)
//   * 429                       -> RateLimitError (retryable, honour Retry-After)
//   * 5xx                       -> handled by the SocialHttpClient default
//   * 422 serviceErrorCode      -> permanent content rejection -> PlatformBadRequestError
//
// The SocialHttpClient already provides sensible defaults for 401/403/429/5xx,
// so this map only needs to cover LinkedIn-specific service error codes that
// would otherwise be misclassified as generic 400s.

function buildContext(
  httpStatus: number,
  serviceErrorCode: string | undefined,
  rawBody: unknown,
) {
  return {
    platform: 'linkedin' as const,
    httpStatus,
    platformErrorCode: serviceErrorCode,
    raw: rawBody,
  };
}

const entries: readonly PlatformErrorMapEntry[] = [
  {
    // Expired or revoked access token. LinkedIn sometimes returns this as 401,
    // sometimes as 403 with a token-expired service code. Treat both as a
    // refresh trigger so the worker rotates the token instead of dead-lettering.
    classify: (httpStatus, serviceErrorCode, rawBody): ProviderError | undefined => {
      if (httpStatus === 401) {
        return new RefreshRequiredError(undefined, buildContext(httpStatus, serviceErrorCode, rawBody));
      }
      if (
        httpStatus === 403 &&
        (serviceErrorCode === 'REVOKED_ACCESS_TOKEN' ||
          serviceErrorCode === 'EXPIRED_ACCESS_TOKEN')
      ) {
        return new RefreshRequiredError(undefined, buildContext(httpStatus, serviceErrorCode, rawBody));
      }
      return undefined;
    },
  },
  {
    // Genuine permission problem (missing scope, not an org admin). Terminal —
    // refreshing won't help; the user must reconnect with the right scopes.
    classify: (httpStatus, serviceErrorCode, rawBody): ProviderError | undefined => {
      if (httpStatus === 403) {
        return new AuthFailedError(
          'LinkedIn rejected the request: insufficient permissions or scopes.',
          buildContext(httpStatus, serviceErrorCode, rawBody),
        );
      }
      return undefined;
    },
  },
  {
    classify: (httpStatus, serviceErrorCode, rawBody): ProviderError | undefined => {
      if (httpStatus === 429) {
        return new RateLimitError(
          'LinkedIn rate limit exceeded.',
          buildContext(httpStatus, serviceErrorCode, rawBody),
        );
      }
      return undefined;
    },
  },
  {
    // Content rejected (too long, malformed payload, policy). Permanent.
    classify: (httpStatus, serviceErrorCode, rawBody): ProviderError | undefined => {
      if (httpStatus === 422 || httpStatus === 400) {
        return new PlatformBadRequestError(
          'LinkedIn rejected the post content (invalid or policy-violating payload).',
          buildContext(httpStatus, serviceErrorCode, rawBody),
        );
      }
      return undefined;
    },
  },
  {
    // LinkedIn sometimes returns 503 "Service Unavailable" during temporary
    // outages. Treat as retryable (same as 5xx defaults in SocialHttpClient,
    // but this explicit entry ensures the retry path fires even if the body
    // doesn't parse as JSON). Learned from Postiz upstream commit 6784a283.
    classify: (httpStatus, serviceErrorCode, rawBody): ProviderError | undefined => {
      if (httpStatus === 503) {
        return new PlatformInternalError(
          'LinkedIn returned Service Unavailable (503). Retrying.',
          buildContext(httpStatus, serviceErrorCode, rawBody),
        );
      }
      return undefined;
    },
  },
];

export const LINKEDIN_ERROR_MAP: PlatformErrorMap = {
  platform: 'linkedin',
  entries,
};
