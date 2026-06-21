import { MissedPostSweeperCronService } from '../missed-post-sweeper.cron';

const now = Date.now();

function makePost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sp-1',
    job_id: 'post-abc-123',
    content_id: 'content-1',
    user_id: 'user-1',
    platform: 'linkedin',
    actor_type: null,
    organization_urn: null,
    retry_count: 0,
    ...overrides,
  };
}

function buildFakeSupabase(rows: unknown[] = [], updateError?: string) {
  const updateCalls: Array<{ data: unknown; filter: unknown }> = [];
  const selectQuery = {
    in: jest.fn().mockReturnThis(),
    lt: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({
      data: rows,
      error: null,
    }),
  };
  const updateQuery = {
    eq: jest.fn().mockResolvedValue({
      data: null,
      error: updateError ? { message: updateError } : null,
    }),
  };
  const client = {
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue(selectQuery),
      update: jest.fn((data: unknown) => {
        updateCalls.push({ data, filter: null });
        return updateQuery;
      }),
    }),
  };
  return {
    getServiceClient: () => client,
    _client: client,
    _updateCalls: updateCalls,
    _selectQuery: selectQuery,
  };
}

function buildFakeQueue() {
  const addCalls: Array<{ name: string; data: unknown; opts: unknown }> = [];
  return {
    add: jest.fn(async (name: string, data: unknown, opts: unknown) => {
      addCalls.push({ name, data, opts });
    }),
    _addCalls: addCalls,
  };
}

describe('MissedPostSweeperCronService', () => {
  it('does nothing when no overdue posts exist', async () => {
    const supabase = buildFakeSupabase([]);
    const queue = buildFakeQueue();
    const service = new MissedPostSweeperCronService(
      queue as any,
      supabase as any,
    );

    await service.sweep();

    expect(queue._addCalls).toHaveLength(0);
  });

  it('re-enqueues an overdue pending post', async () => {
    const post = makePost();
    const supabase = buildFakeSupabase([post]);
    const queue = buildFakeQueue();
    const service = new MissedPostSweeperCronService(
      queue as any,
      supabase as any,
    );

    await service.sweep();

    expect(queue._addCalls).toHaveLength(1);
    expect(queue._addCalls[0].name).toBe('publish-scheduled-post');
    expect(queue._addCalls[0].data).toEqual(
      expect.objectContaining({
        contentId: 'content-1',
        userId: 'user-1',
        platform: 'linkedin',
      }),
    );
  });

  it('re-enqueues with org actor info read from the scheduled_posts row', async () => {
    const post = makePost({
      actor_type: 'organization',
      organization_urn: 'urn:li:organization:888',
    });
    const supabase = buildFakeSupabase([post]);
    const queue = buildFakeQueue();
    const service = new MissedPostSweeperCronService(
      queue as any,
      supabase as any,
    );

    await service.sweep();

    expect(queue._addCalls).toHaveLength(1);
    expect(queue._addCalls[0].data).toEqual(
      expect.objectContaining({
        contentId: 'content-1',
        userId: 'user-1',
        platform: 'linkedin',
        actorType: 'organization',
        organizationUrn: 'urn:li:organization:888',
      }),
    );
  });

  it('marks a post failed after exceeding MAX_SWEEP_RETRIES', async () => {
    const post = makePost({ retry_count: 3 });
    const supabase = buildFakeSupabase([post]);
    const queue = buildFakeQueue();
    const service = new MissedPostSweeperCronService(
      queue as any,
      supabase as any,
    );

    await service.sweep();

    expect(queue._addCalls).toHaveLength(0);

    const fromCalls = supabase._client.from.mock.calls;
    const updateCalls = fromCalls.filter(
      (c: string[]) => c[0] === 'scheduled_posts',
    );
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it('does not double-enqueue — sets status to retrying before add', async () => {
    const post = makePost({ retry_count: 1 });
    const supabase = buildFakeSupabase([post]);
    const queue = buildFakeQueue();
    const service = new MissedPostSweeperCronService(
      queue as any,
      supabase as any,
    );

    await service.sweep();

    expect(queue._addCalls).toHaveLength(1);
    const updateData = supabase._updateCalls[0]?.data as Record<
      string,
      unknown
    >;
    expect(updateData?.status).toBe('retrying');
    expect(updateData?.retry_count).toBe(2);
  });
});
