import { PostSchedulingService } from '../post-scheduling.service';

/**
 * Unit tests for actor-info persistence on the schedule path
 * (PostSchedulingService.schedulePost). The publishing actor
 * (actorType = 'member' | 'organization' + organizationUrn) must be written
 * into the scheduled_posts row so the DB — not the (evictable) BullMQ job — is
 * the source of truth for reschedule and the missed-post sweeper.
 */

const FUTURE = new Date(Date.now() + 60 * 60 * 1000); // +1h

function buildSupabase(content: Record<string, unknown>) {
  const inserts: Array<{ table: string; data: Record<string, unknown> }> = [];

  function makeQuery(table: string, op: 'select' | 'update'): any {
    const q: any = {
      eq: jest.fn(() => q),
      in: jest.fn(() => q),
      lt: jest.fn(() => q),
      is: jest.fn(() => q),
      single: jest.fn(async () => {
        if (table === 'generated_content' && op === 'select') {
          return { data: content, error: null };
        }
        return { data: null, error: null };
      }),
      // Awaiting the chain (e.g. .in() / .lt() / .eq()) resolves to no rows.
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        resolve({ data: [], error: null }),
    };
    return q;
  }

  const client = {
    from: jest.fn((table: string) => ({
      select: jest.fn(() => makeQuery(table, 'select')),
      update: jest.fn(() => makeQuery(table, 'update')),
      insert: jest.fn((data: Record<string, unknown>) => {
        inserts.push({ table, data });
        return {
          select: jest.fn(() => ({
            single: jest.fn(async () => ({
              data: { id: 'sp-new', ...data },
              error: null,
            })),
          })),
        };
      }),
    })),
  };

  return { getServiceClient: () => client, _inserts: inserts };
}

function buildQueue() {
  const added: Array<{ name: string; data: any; opts: any }> = [];
  return {
    getJob: jest.fn(async () => null),
    add: jest.fn(async (name: string, data: any, opts: any) => {
      added.push({ name, data, opts });
      return { id: 'job-1' };
    }),
    _added: added,
  };
}

function makeService(supabase: any, queue: any) {
  return new PostSchedulingService(
    queue,
    supabase,
    { checkRateLimit: jest.fn().mockResolvedValue(true) } as any, // mediaGenerationService
    {} as any, // linkedinService
    {} as any, // cacheService
    {} as any, // publishedPostRepo
  );
}

describe('PostSchedulingService.schedulePost (actor persistence)', () => {
  it('persists actor_type + organization_urn into the scheduled_posts row for org posts', async () => {
    const supabase = buildSupabase({
      id: 'content-1',
      user_id: 'user-1',
      content: 'A short, valid caption.',
      hashtags: ['#ai'],
      linkedin_post_id: null,
      publish_status: 'ready',
    });
    const queue = buildQueue();
    const service = makeService(supabase, queue);

    await service.schedulePost({
      contentId: 'content-1',
      userId: 'user-1',
      scheduledFor: FUTURE,
      platform: 'linkedin',
      actorType: 'organization',
      organizationUrn: 'urn:li:organization:42',
    });

    const insert = supabase._inserts.find(
      (i: any) => i.table === 'scheduled_posts',
    );
    expect(insert?.data).toEqual(
      expect.objectContaining({
        content_id: 'content-1',
        user_id: 'user-1',
        actor_type: 'organization',
        organization_urn: 'urn:li:organization:42',
      }),
    );
    // Job payload still carries the actor too (consumed by the processor).
    expect(queue._added[0].data).toEqual(
      expect.objectContaining({
        actorType: 'organization',
        organizationUrn: 'urn:li:organization:42',
      }),
    );
  });

  it('writes null actor columns for a personal/member post (no actor supplied)', async () => {
    const supabase = buildSupabase({
      id: 'content-2',
      user_id: 'user-2',
      content: 'Another valid caption.',
      hashtags: [],
      linkedin_post_id: null,
      publish_status: 'ready',
    });
    const queue = buildQueue();
    const service = makeService(supabase, queue);

    await service.schedulePost({
      contentId: 'content-2',
      userId: 'user-2',
      scheduledFor: FUTURE,
      platform: 'linkedin',
    });

    const insert = supabase._inserts.find(
      (i: any) => i.table === 'scheduled_posts',
    );
    expect(insert?.data).toEqual(
      expect.objectContaining({
        content_id: 'content-2',
        actor_type: null,
        organization_urn: null,
      }),
    );
  });
});
