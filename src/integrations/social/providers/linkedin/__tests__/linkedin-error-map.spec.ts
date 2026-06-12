import { LINKEDIN_ERROR_MAP } from '../linkedin-error-map';
import {
  AuthFailedError,
  PlatformBadRequestError,
  PlatformInternalError,
  RateLimitError,
  RefreshRequiredError,
} from '../../../types';

function classify(httpStatus: number, code?: string, body: unknown = {}) {
  for (const entry of LINKEDIN_ERROR_MAP.entries) {
    const result = entry.classify(httpStatus, code, body);
    if (result) return result;
  }
  return undefined;
}

describe('LINKEDIN_ERROR_MAP', () => {
  it('maps 401 to RefreshRequiredError', () => {
    expect(classify(401)).toBeInstanceOf(RefreshRequiredError);
  });

  it('maps 403 with expired-token code to RefreshRequiredError', () => {
    expect(classify(403, 'EXPIRED_ACCESS_TOKEN')).toBeInstanceOf(RefreshRequiredError);
  });

  it('maps generic 403 to AuthFailedError (terminal)', () => {
    expect(classify(403, 'ACCESS_DENIED')).toBeInstanceOf(AuthFailedError);
  });

  it('maps 429 to RateLimitError', () => {
    expect(classify(429)).toBeInstanceOf(RateLimitError);
  });

  it('maps 422/400 content rejection to PlatformBadRequestError', () => {
    expect(classify(422)).toBeInstanceOf(PlatformBadRequestError);
    expect(classify(400)).toBeInstanceOf(PlatformBadRequestError);
  });

  it('maps 503 to PlatformInternalError (retryable)', () => {
    expect(classify(503)).toBeInstanceOf(PlatformInternalError);
  });

  it('returns undefined for success/other 5xx (handled by client defaults)', () => {
    expect(classify(200)).toBeUndefined();
    expect(classify(500)).toBeUndefined();
  });
});
