import { SocialHttpClient } from '../../../social-http-client';
import { LINKEDIN_ERROR_MAP } from '../linkedin-error-map';
import { LinkedInMediaService } from '../linkedin-media.service';
import { LinkedInPublisherService } from '../linkedin-publisher.service';
import type { MediaByteReader } from '../../../media-byte-reader';
import {
  PlatformBadRequestError,
  RefreshRequiredError,
  type ConnectedAccount,
  type MediaAttachment,
  type OAuthTokenSet,
  type PostPayload,
} from '../../../types';

const ACCOUNT: ConnectedAccount = {
  id: 'acc-1',
  userId: 'user-1',
  platform: 'linkedin',
  platformAccountId: 'PERSON123',
  accountType: 'personal',
  displayName: 'Test User',
  profileUrl: null,
  avatarUrl: null,
  status: 'active',
  connectedAt: new Date(),
  lastUsedAt: null,
  metadata: {},
};

const TOKENS: OAuthTokenSet = {
  accessToken: 'access-token',
  expiresAt: new Date(Date.now() + 3_600_000),
  scopes: ['w_member_social'],
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

// Routes fake fetch calls by URL + method, returning queued responses.
function routerFetch(routes: Array<{ match: RegExp; method?: string; responses: FakeResponseSpec[] }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body });
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

const noopSleep = () => Promise.resolve();

function buildPublisher(fetchImpl: typeof fetch, byteReader: MediaByteReader) {
  const http = new SocialHttpClient({
    errorMap: LINKEDIN_ERROR_MAP,
    fetchImpl,
    sleep: noopSleep,
  });
  const media = new LinkedInMediaService(http, '202604', byteReader);
  return new LinkedInPublisherService(http, media, '202604');
}

const fakeByteReader: MediaByteReader = { read: async () => Buffer.from('fake-image-bytes') };

describe('LinkedInPublisherService', () => {
  it('publishes a text-only post and returns the post id from x-restli-id', async () => {
    const { fn, calls } = routerFetch([
      {
        match: /\/rest\/posts$/,
        method: 'POST',
        responses: [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:999' } }],
      },
    ]);
    const publisher = buildPublisher(fn, fakeByteReader);

    const payload: PostPayload = { content: 'Hello LinkedIn', media: [], metadata: {} };
    const result = await publisher.publishPost(ACCOUNT, payload, TOKENS);

    expect(result.platformPostId).toBe('urn:li:share:999');
    expect(result.platformPostUrl).toContain('urn:li:share:999');
    const postBody = JSON.parse(String(calls[0].body));
    expect(postBody.author).toBe('urn:li:person:PERSON123');
    expect(postBody.commentary).toBe('Hello LinkedIn');
    expect(postBody.content).toBeUndefined();
  });

  it('publishes a single-image post (initialize -> upload -> waitForReady -> post)', async () => {
    const { fn, calls } = routerFetch([
      {
        match: /\/rest\/images\?action=initializeUpload$/,
        method: 'POST',
        responses: [
          {
            status: 200,
            body: { value: { uploadUrl: 'https://upload.test/img', image: 'urn:li:image:42' } },
          },
        ],
      },
      { match: /upload\.test\/img$/, method: 'PUT', responses: [{ status: 201 }] },
      {
        match: /\/rest\/images\/urn/,
        method: 'GET',
        responses: [{ status: 200, body: { status: 'AVAILABLE' } }],
      },
      {
        match: /\/rest\/posts$/,
        method: 'POST',
        responses: [{ status: 201, headers: { 'x-restli-id': 'urn:li:share:777' } }],
      },
    ]);
    const publisher = buildPublisher(fn, fakeByteReader);

    const orgAccount: ConnectedAccount = { ...ACCOUNT, accountType: 'organization' };
    const image: MediaAttachment = {
      id: 'm1',
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 16,
      storagePath: 'posts/m1.jpg',
      altText: 'A chart',
    };
    const payload: PostPayload = { content: 'With image', media: [image], metadata: {} };
    const result = await publisher.publishPost(orgAccount, payload, TOKENS);

    expect(result.platformPostId).toBe('urn:li:share:777');
    const postCall = calls.find((c) => /\/rest\/posts$/.test(c.url));
    const postBody = JSON.parse(String(postCall?.body));
    expect(postBody.content.media.id).toBe('urn:li:image:42');
    expect(postBody.content.media.altText).toBe('A chart');
  });

  it('retries on 429 then succeeds', async () => {
    const { fn } = routerFetch([
      {
        match: /\/rest\/posts$/,
        method: 'POST',
        responses: [
          { status: 429, body: { message: 'slow down' } },
          { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } },
        ],
      },
    ]);
    const publisher = buildPublisher(fn, fakeByteReader);
    const result = await publisher.publishPost(
      ACCOUNT,
      { content: 'retry me', media: [], metadata: {} },
      TOKENS,
    );
    expect(result.platformPostId).toBe('urn:li:share:1');
  });

  it('surfaces RefreshRequiredError on 401', async () => {
    const { fn } = routerFetch([
      {
        match: /\/rest\/posts$/,
        method: 'POST',
        responses: [{ status: 401, body: { message: 'token expired' } }],
      },
    ]);
    const publisher = buildPublisher(fn, fakeByteReader);
    await expect(
      publisher.publishPost(ACCOUNT, { content: 'x', media: [], metadata: {} }, TOKENS),
    ).rejects.toBeInstanceOf(RefreshRequiredError);
  });

  it('rejects posts over the character limit before calling LinkedIn', async () => {
    const { fn, calls } = routerFetch([{ match: /.*/, responses: [{ status: 201 }] }]);
    const publisher = buildPublisher(fn, fakeByteReader);
    const tooLong = 'a'.repeat(3001);
    await expect(
      publisher.publishPost(ACCOUNT, { content: tooLong, media: [], metadata: {} }, TOKENS),
    ).rejects.toBeInstanceOf(PlatformBadRequestError);
    expect(calls).toHaveLength(0);
  });

  it('rejects multi-image posts (Sprint 1.3 single-media only)', async () => {
    const { fn } = routerFetch([{ match: /.*/, responses: [{ status: 201 }] }]);
    const publisher = buildPublisher(fn, fakeByteReader);
    const img: MediaAttachment = {
      id: 'm',
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 1,
      storagePath: 'a.jpg',
    };
    await expect(
      publisher.publishPost(ACCOUNT, { content: 'x', media: [img, img], metadata: {} }, TOKENS),
    ).rejects.toBeInstanceOf(PlatformBadRequestError);
  });
});
