import { LinkedinService } from '../../../../../services/linkedin.service';

/**
 * Focused tests for LinkedinService.getMemberPostEngagement — the personal-post
 * engagement reader behind Sprint 1.6 engagement ranking. The key behavior is
 * graceful degradation when the restricted `r_member_social` scope is not
 * granted (LinkedIn answers 401/403): it must NOT throw and must report
 * `available: false` so the cron falls back to recency ranking.
 */
function fakeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function buildService(token: string | null) {
  const configService = { get: () => undefined } as any;
  const profileRepository = {
    findById: jest.fn().mockResolvedValue(
      token ? { linkedin_access_token: token } : null,
    ),
  } as any;
  const generatedContentRepository = {} as any;
  const scraperCredentialsService = {} as any;
  return new LinkedinService(
    configService,
    profileRepository,
    generatedContentRepository,
    scraperCredentialsService,
  );
}

describe('LinkedinService.getMemberPostEngagement', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns available=true with empty map for no post ids (no network call)', async () => {
    const service = buildService('tok');
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const result = await service.getMemberPostEngagement('user-1', []);

    expect(result.available).toBe(true);
    expect(result.byPostId.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades gracefully (available=false) on 403 — scope not granted', async () => {
    const service = buildService('tok');
    global.fetch = jest.fn().mockResolvedValue(fakeResponse(403, {})) as any;

    const result = await service.getMemberPostEngagement('user-1', [
      'urn:li:share:1',
    ]);

    expect(result.available).toBe(false);
    expect(result.byPostId.size).toBe(0);
  });

  it('parses reactions + comments on 200', async () => {
    const service = buildService('tok');
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse(200, {
        likesSummary: { totalLikes: 7 },
        commentsSummary: { aggregatedTotalComments: 2 },
      }),
    ) as any;

    const result = await service.getMemberPostEngagement('user-1', [
      'urn:li:share:1',
    ]);

    expect(result.available).toBe(true);
    expect(result.byPostId.get('urn:li:share:1')).toEqual({
      reactions: 7,
      comments: 2,
    });
  });

  it('skips a single 404 post without flipping availability', async () => {
    const service = buildService('tok');
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(fakeResponse(404, {}))
      .mockResolvedValueOnce(
        fakeResponse(200, {
          likesSummary: { totalLikes: 3 },
          commentsSummary: { count: 1 },
        }),
      ) as any;

    const result = await service.getMemberPostEngagement('user-1', [
      'urn:li:share:gone',
      'urn:li:share:ok',
    ]);

    expect(result.available).toBe(true);
    expect(result.byPostId.has('urn:li:share:gone')).toBe(false);
    expect(result.byPostId.get('urn:li:share:ok')).toEqual({
      reactions: 3,
      comments: 1,
    });
  });

  it('reports unavailable when LinkedIn is not connected', async () => {
    const service = buildService(null);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const result = await service.getMemberPostEngagement('user-1', [
      'urn:li:share:1',
    ]);

    expect(result.available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
