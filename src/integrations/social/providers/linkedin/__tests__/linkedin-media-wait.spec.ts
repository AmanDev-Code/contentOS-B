import { SocialHttpClient } from '../../../social-http-client';
import { LINKEDIN_ERROR_MAP } from '../linkedin-error-map';
import { LinkedInMediaService } from '../linkedin-media.service';
import type { MediaByteReader } from '../../../media-byte-reader';
import { PlatformBadRequestError } from '../../../types';

const noopSleep = () => Promise.resolve();
const fakeByteReader: MediaByteReader = {
  read: async () => Buffer.from('fake-bytes'),
};

interface FakeResponseSpec {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeResponse(spec: FakeResponseSpec) {
  const headers = spec.headers ?? {};
  return {
    status: spec.status,
    headers: {
      forEach: (cb: (value: string, key: string) => void) => {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      },
    },
    json: async () => spec.body ?? {},
    text: async () => JSON.stringify(spec.body ?? {}),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function routerFetch(
  routes: Array<{
    match: RegExp;
    method?: string;
    responses: FakeResponseSpec[];
  }>,
) {
  const calls: Array<{ url: string; method: string }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    const route = routes.find(
      (r) => r.match.test(url) && (!r.method || r.method === method),
    );
    if (!route) throw new Error(`No fake route for ${method} ${url}`);
    const next = route.responses.shift();
    if (!next) throw new Error(`No more queued responses for ${method} ${url}`);
    return makeResponse(next);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function buildService(fetchImpl: typeof fetch) {
  const http = new SocialHttpClient({
    errorMap: LINKEDIN_ERROR_MAP,
    fetchImpl,
    sleep: noopSleep,
  });
  return new LinkedInMediaService(http, '202604', fakeByteReader, noopSleep);
}

describe('LinkedInMediaService.waitForReady', () => {
  it('returns immediately for personal tokens (fixed delay fallback)', async () => {
    const { fn, calls } = routerFetch([]);
    const service = buildService(fn);

    await service.waitForReady('urn:li:image:42', 'token', 'images', true);

    expect(calls).toHaveLength(0);
  });

  it('polls until AVAILABLE for org tokens', async () => {
    const { fn, calls } = routerFetch([
      {
        match: /\/rest\/images\//,
        method: 'GET',
        responses: [
          { status: 200, body: { status: 'WAITING_UPLOAD' } },
          { status: 200, body: { status: 'PROCESSING' } },
          { status: 200, body: { status: 'AVAILABLE' } },
        ],
      },
    ]);
    const service = buildService(fn);

    await service.waitForReady('urn:li:image:42', 'token', 'images', false);

    expect(calls).toHaveLength(3);
  });

  it('throws PlatformBadRequestError on PROCESSING_FAILED', async () => {
    const { fn } = routerFetch([
      {
        match: /\/rest\/documents\//,
        method: 'GET',
        responses: [
          {
            status: 200,
            body: {
              status: 'PROCESSING_FAILED',
              processingFailureReason: 'CORRUPT_FILE',
            },
          },
        ],
      },
    ]);
    const service = buildService(fn);

    await expect(
      service.waitForReady('urn:li:document:99', 'token', 'documents', false),
    ).rejects.toThrow(/CORRUPT_FILE/);
  });

  it('PROCESSING_FAILED error is a PlatformBadRequestError', async () => {
    const { fn } = routerFetch([
      {
        match: /\/rest\/documents\//,
        method: 'GET',
        responses: [
          {
            status: 200,
            body: { status: 'PROCESSING_FAILED' },
          },
        ],
      },
    ]);
    const service = buildService(fn);

    await expect(
      service.waitForReady('urn:li:document:99', 'token', 'documents', false),
    ).rejects.toBeInstanceOf(PlatformBadRequestError);
  });

  it('throws after max poll attempts are exhausted', async () => {
    const { fn } = routerFetch([
      {
        match: /\/rest\/images\//,
        method: 'GET',
        responses: Array.from({ length: 3 }, () => ({
          status: 200,
          body: { status: 'PROCESSING' },
        })),
      },
    ]);
    const service = buildService(fn);

    await expect(
      service.waitForReady('urn:li:image:42', 'token', 'images', false, 3),
    ).rejects.toThrow(/Timed out/);
  });

  it('upload returns mediaType alongside assetUrn', async () => {
    const { fn } = routerFetch([
      {
        match: /\/rest\/images\?action=initializeUpload$/,
        method: 'POST',
        responses: [
          {
            status: 200,
            body: {
              value: {
                uploadUrl: 'https://upload.test/img',
                image: 'urn:li:image:42',
              },
            },
          },
        ],
      },
      {
        match: /upload\.test\/img$/,
        method: 'PUT',
        responses: [{ status: 201 }],
      },
    ]);
    const service = buildService(fn);

    const result = await service.upload(
      'urn:li:person:123',
      {
        id: 'm1',
        kind: 'image',
        mimeType: 'image/jpeg',
        sizeBytes: 16,
        storagePath: 'posts/m1.jpg',
      },
      'token',
    );

    expect(result.assetUrn).toBe('urn:li:image:42');
    expect(result.mediaType).toBe('images');
  });
});
