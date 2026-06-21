import { Logger } from '@nestjs/common';
import {
  AuthFailedError,
  PlatformBadRequestError,
  PlatformInternalError,
  ProviderError,
  RateLimitError,
  RefreshRequiredError,
} from './types';
import type { Platform, ProviderErrorContext } from './types';

// Shared HTTP wrapper for every social platform.
//
// Design choices:
//   * NO string matching of error bodies. Each provider supplies a structured
//     `errorMap` keyed on `(httpStatus, platformErrorCode?)` and we resolve
//     deterministic typed errors. The architecture map explicitly flags
//     regex-over-error-text as an anti-pattern; we ban it at the seam.
//   * Single retry policy: 3 attempts, exponential backoff base 1s, capped 8s,
//     applied to 429 + 5xx. Other classes of error short-circuit immediately.
//   * 401 → `RefreshRequiredError`. The wrapper does NOT attempt refresh itself;
//     that decision lives one level up (publish worker) so it can coordinate
//     vault writes, retry budgets, and re-emit the request with fresh creds.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: BodyInit | null;
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: () => Promise<string>;
  readonly json: () => Promise<unknown>;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface PlatformErrorMapEntry {
  readonly classify: (
    httpStatus: number,
    platformErrorCode: string | undefined,
    rawBody: unknown,
  ) => ProviderError | undefined;
}

export interface PlatformErrorMap {
  readonly platform: Platform;
  readonly entries: readonly PlatformErrorMapEntry[];
}

export interface SocialHttpClientOptions {
  readonly errorMap: PlatformErrorMap;
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 8_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class SocialHttpClient {
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  public constructor(private readonly options: SocialHttpClientOptions) {
    this.logger = new Logger(
      `${SocialHttpClient.name}:${options.errorMap.platform}`,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  public async request(req: HttpRequest): Promise<HttpResponse> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < this.maxAttempts) {
      attempt += 1;
      try {
        const response = await this.executeOnce(req);
        if (response.status >= 200 && response.status < 300) {
          return response;
        }

        const handled = await this.classify(response, attempt);
        if (handled.kind === 'retry') {
          await this.sleep(handled.delayMs);
          continue;
        }
        throw handled.error;
      } catch (err) {
        lastError = err;
        if (
          err instanceof RateLimitError ||
          err instanceof PlatformInternalError
        ) {
          if (attempt < this.maxAttempts) {
            const delay = this.backoffFor(
              attempt,
              err.context.retryAfterSeconds,
            );
            await this.sleep(delay);
            continue;
          }
        }
        throw err;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new PlatformInternalError('Request failed after retries', {
          platform: this.options.errorMap.platform,
        });
  }

  private async executeOnce(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchResponse = await this.fetchImpl(req.url, {
        method: req.method,
        headers: req.headers as HeadersInit | undefined,
        body: req.body,
        signal: controller.signal,
      });

      const headers: Record<string, string> = {};
      fetchResponse.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: fetchResponse.status,
        headers,
        text: () => fetchResponse.text(),
        json: () => fetchResponse.json() as Promise<unknown>,
        arrayBuffer: () => fetchResponse.arrayBuffer(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async classify(
    response: HttpResponse,
    attempt: number,
  ): Promise<
    { kind: 'retry'; delayMs: number } | { kind: 'fail'; error: ProviderError }
  > {
    let parsedBody: unknown;
    try {
      parsedBody = await response.json();
    } catch {
      try {
        parsedBody = await response.text();
      } catch {
        parsedBody = undefined;
      }
    }

    const platformErrorCode = this.extractPlatformErrorCode(parsedBody);
    const context: ProviderErrorContext = {
      platform: this.options.errorMap.platform,
      httpStatus: response.status,
      platformErrorCode,
      retryAfterSeconds: this.parseRetryAfter(response.headers['retry-after']),
      raw: parsedBody,
    };

    for (const entry of this.options.errorMap.entries) {
      const mapped = entry.classify(
        response.status,
        platformErrorCode,
        parsedBody,
      );
      if (mapped) {
        return this.maybeRetry(mapped, attempt);
      }
    }

    if (response.status === 401) {
      return this.maybeRetry(
        new RefreshRequiredError(undefined, context),
        attempt,
      );
    }
    if (response.status === 403) {
      return {
        kind: 'fail',
        error: new AuthFailedError(`Forbidden (HTTP 403)`, context),
      };
    }
    if (response.status === 429) {
      return this.maybeRetry(
        new RateLimitError(`Rate limited (HTTP 429)`, context),
        attempt,
      );
    }
    if (response.status >= 500) {
      return this.maybeRetry(
        new PlatformInternalError(
          `Upstream error (HTTP ${response.status})`,
          context,
        ),
        attempt,
      );
    }
    if (response.status >= 400) {
      return {
        kind: 'fail',
        error: new PlatformBadRequestError(
          `Bad request (HTTP ${response.status})`,
          context,
        ),
      };
    }

    return {
      kind: 'fail',
      error: new PlatformInternalError(
        `Unhandled response status ${response.status}`,
        context,
      ),
    };
  }

  private maybeRetry(
    error: ProviderError,
    attempt: number,
  ):
    | { kind: 'retry'; delayMs: number }
    | { kind: 'fail'; error: ProviderError } {
    const isRetryable =
      error instanceof RateLimitError || error instanceof PlatformInternalError;
    if (isRetryable && attempt < this.maxAttempts) {
      return {
        kind: 'retry',
        delayMs: this.backoffFor(attempt, error.context.retryAfterSeconds),
      };
    }
    if (error instanceof RefreshRequiredError) {
      return { kind: 'fail', error };
    }
    return { kind: 'fail', error };
  }

  private backoffFor(attempt: number, retryAfterSeconds?: number): number {
    if (retryAfterSeconds && retryAfterSeconds > 0) {
      return Math.min(retryAfterSeconds * 1_000, this.maxBackoffMs);
    }
    const exp = this.baseBackoffMs * 2 ** (attempt - 1);
    return Math.min(exp, this.maxBackoffMs);
  }

  private parseRetryAfter(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const seconds = Number.parseInt(value, 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(value);
    if (Number.isFinite(date)) {
      return Math.max(0, Math.floor((date - Date.now()) / 1_000));
    }
    return undefined;
  }

  private extractPlatformErrorCode(body: unknown): string | undefined {
    if (body == null || typeof body !== 'object') return undefined;
    const candidate = body as Record<string, unknown>;
    const direct =
      candidate['code'] ?? candidate['errorCode'] ?? candidate['error_code'];
    if (typeof direct === 'string') return direct;
    if (typeof direct === 'number') return String(direct);
    const nested = candidate['error'];
    if (nested && typeof nested === 'object') {
      const nestedCode = (nested as Record<string, unknown>)['code'];
      if (typeof nestedCode === 'string') return nestedCode;
    }
    return undefined;
  }
}
