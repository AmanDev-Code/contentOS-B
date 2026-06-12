import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PostSchedulingService } from '../post-scheduling.service';

/**
 * Unit tests for the no-charge reschedule path
 * (PostSchedulingService.reschedulePost). The credit charge lives entirely in
 * the POST /posts/schedule controller — this service has NO quota dependency at
 * all, so a successful reschedule is structurally incapable of charging credits.
 * These tests assert ownership, status/published guards, char-limit
 * revalidation, and BullMQ job re-enqueue (with preserved actor info).
 */

const FUTURE = new Date(Date.now() + 60 * 60 * 1000); // +1h

function buildSupabase(opts: {
  scheduledPost: Record<string, unknown> | null;
  content: Record<string, unknown> | null;
  updateError?: string;
}) {
  const updates: Array<{ table: string; data: Record<string, unknown> }> = [];

  const client = {
    from: jest.fn((table: string) => ({
      select: jest.fn(() => {
        const q: any = {
          eq: jest.fn(() => q),
          single: jest.fn(async () => {
            if (table === 'scheduled_posts') {
              return {
                data: opts.scheduledPost,
                error: opts.scheduledPost ? null : { message: 'not found' },
              };
            }
            if (table === 'generated_content') {
              return {
                data: opts.content,
                error: opts.content ? null : { message: 'not found' },
              };
            }
            return { data: null, error: null };
          }),
        };
        return q;
      }),
      update: jest.fn((data: Record<string, unknown>) => {
        updates.push({ table, data });
        const q: any = {
          eq: jest.fn(() => q),
          then: (resolve: (v: { error: unknown }) => unknown) =>
            resolve({
              error:
                opts.updateError && table === 'scheduled_posts'
                  ? { message: opts.updateError }
                  : null,
            }),
        };
        return q;
      }),
    })),
  };

  return { getServiceClient: () => client, _client: client, _updates: updates };
}

function buildQueue(oldJobData?: Record<string, unknown> | null) {
  const removed: string[] = [];
  const added: Array<{ name: string; data: any; opts: any }> = [];
  return {
    getJob: jest.fn(async (id: string) =>
      oldJobData === null
        ? null
        : {
            id,
            data: oldJobData ?? {},
            remove: jest.fn(async () => {
              removed.push(id);
            }),
          },
    ),
    add: jest.fn(async (name: string, data: any, opts: any) => {
      added.push({ name, data, opts });
      return { id: 'new-job-456' };
    }),
    _removed: removed,
    _added: added,
  };
}

function makeService(supabase: any, queue: any) {
  // Only publishQueue + supabaseService are exercised by reschedulePost; the
  // remaining constructor deps are unused on this path.
  return new PostSchedulingService(
    queue as any,
    supabase as any,
    {} as any, // mediaGenerationService
    {} as any, // linkedinService
    {} as any, // cacheService
    {} as any, // publishedPostRepo
  );
}

describe('PostSchedulingService.reschedulePost (no-charge)', () => {
  it('re-enqueues at the new time, updates the row in place, and charges nothing', async () => {
    const supabase = buildSupabase({
      scheduledPost: {
        id: 'sp-1',
        content_id: 'content-1',
        job_id: 'old-job-1',
        status: 'scheduled',
        scheduled_for: new Date().toISOString(),
        platform: 'linkedin',
      },
      content: {
        id: 'content-1',
        user_id: 'user-1',
        content: 'A short, valid caption.',
        hashtags: ['#ai'],
        linkedin_post_id: null,
        publish_status: 'scheduled',
      },
    });
    const queue = buildQueue({
      actorType: 'organization',
      organizationUrn: 'urn:li:organization:999',
    });
    const service = makeService(supabase, queue);

    const result = await service.reschedulePost({
      scheduledPostId: 'sp-1',
      userId: 'user-1',
      newScheduledFor: FUTURE,
    });

    // Old delayed job removed, new one enqueued.
    expect(queue._removed).toEqual(['old-job-1']);
    expect(queue._added).toHaveLength(1);
    expect(queue._added[0].name).toBe('publish-scheduled-post');
    expect(queue._added[0].data).toEqual(
      expect.objectContaining({
        contentId: 'content-1',
        userId: 'user-1',
        platform: 'linkedin',
        // actor info recovered from the old job (no schema change needed).
        actorType: 'organization',
        organizationUrn: 'urn:li:organization:999',
      }),
    );
    expect(queue._added[0].opts.delay).toBeGreaterThan(0);

    // Existing scheduled_posts row updated IN PLACE (not a new insert).
    const spUpdate = supabase._updates.find(
      (u: any) => u.table === 'scheduled_posts',
    );
    expect(spUpdate?.data).toEqual(
      expect.objectContaining({
        job_id: 'new-job-456',
        status: 'scheduled',
        scheduled_for: FUTURE.toISOString(),
      }),
    );

    expect(result).toEqual({
      jobId: 'new-job-456',
      contentId: 'content-1',
      scheduledFor: FUTURE.toISOString(),
    });
  });

  it('uses the scheduled_posts row as the source of truth for actor info (org) even when the BullMQ job is gone', async () => {
    const supabase = buildSupabase({
      scheduledPost: {
        id: 'sp-1',
        content_id: 'content-1',
        job_id: 'old-job-1',
        status: 'scheduled',
        scheduled_for: new Date().toISOString(),
        platform: 'linkedin',
        // DB carries the org actor; this is now authoritative.
        actor_type: 'organization',
        organization_urn: 'urn:li:organization:777',
      },
      content: {
        id: 'content-1',
        user_id: 'user-1',
        content: 'A short, valid caption.',
        hashtags: ['#ai'],
        linkedin_post_id: null,
        publish_status: 'scheduled',
      },
    });
    // Redis evicted the old delayed job (null) — the old code would have lost
    // the org actor here and fallen back to member.
    const queue = buildQueue(null);
    const service = makeService(supabase, queue);

    await service.reschedulePost({
      scheduledPostId: 'sp-1',
      userId: 'user-1',
      newScheduledFor: FUTURE,
    });

    expect(queue._added).toHaveLength(1);
    expect(queue._added[0].data).toEqual(
      expect.objectContaining({
        actorType: 'organization',
        organizationUrn: 'urn:li:organization:777',
      }),
    );

    // Actor info re-persisted on the in-place row update.
    const spUpdate = supabase._updates.find(
      (u: any) => u.table === 'scheduled_posts',
    );
    expect(spUpdate?.data).toEqual(
      expect.objectContaining({
        actor_type: 'organization',
        organization_urn: 'urn:li:organization:777',
      }),
    );
  });

  it('falls back to the old BullMQ job actor only when the row columns are null (pre-migration rows)', async () => {
    const supabase = buildSupabase({
      scheduledPost: {
        id: 'sp-1',
        content_id: 'content-1',
        job_id: 'old-job-1',
        status: 'scheduled',
        scheduled_for: new Date().toISOString(),
        platform: 'linkedin',
        // Pre-migration row: no actor persisted.
        actor_type: null,
        organization_urn: null,
      },
      content: {
        id: 'content-1',
        user_id: 'user-1',
        content: 'A short, valid caption.',
        hashtags: ['#ai'],
        linkedin_post_id: null,
        publish_status: 'scheduled',
      },
    });
    const queue = buildQueue({
      actorType: 'organization',
      organizationUrn: 'urn:li:organization:555',
    });
    const service = makeService(supabase, queue);

    await service.reschedulePost({
      scheduledPostId: 'sp-1',
      userId: 'user-1',
      newScheduledFor: FUTURE,
    });

    expect(queue._added[0].data).toEqual(
      expect.objectContaining({
        actorType: 'organization',
        organizationUrn: 'urn:li:organization:555',
      }),
    );
    // The recovered actor is back-filled onto the row.
    const spUpdate = supabase._updates.find(
      (u: any) => u.table === 'scheduled_posts',
    );
    expect(spUpdate?.data).toEqual(
      expect.objectContaining({
        actor_type: 'organization',
        organization_urn: 'urn:li:organization:555',
      }),
    );
  });

  it('throws NotFound when the scheduled post is missing / not owned', async () => {
    const supabase = buildSupabase({ scheduledPost: null, content: null });
    const queue = buildQueue();
    const service = makeService(supabase, queue);

    await expect(
      service.reschedulePost({
        scheduledPostId: 'missing',
        userId: 'user-1',
        newScheduledFor: FUTURE,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(queue._added).toHaveLength(0);
  });

  it('rejects rescheduling a post already published to LinkedIn', async () => {
    const supabase = buildSupabase({
      scheduledPost: {
        id: 'sp-1',
        content_id: 'content-1',
        job_id: 'old-job-1',
        status: 'scheduled',
        platform: 'linkedin',
      },
      content: {
        id: 'content-1',
        user_id: 'user-1',
        content: 'caption',
        hashtags: [],
        linkedin_post_id: 'urn:li:share:123',
        publish_status: 'published',
      },
    });
    const queue = buildQueue();
    const service = makeService(supabase, queue);

    await expect(
      service.reschedulePost({
        scheduledPostId: 'sp-1',
        userId: 'user-1',
        newScheduledFor: FUTURE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(queue._added).toHaveLength(0);
  });

  it('rejects rescheduling a non-active (e.g. processing) entry', async () => {
    const supabase = buildSupabase({
      scheduledPost: {
        id: 'sp-1',
        content_id: 'content-1',
        job_id: 'old-job-1',
        status: 'processing',
        platform: 'linkedin',
      },
      content: {
        id: 'content-1',
        user_id: 'user-1',
        content: 'caption',
        hashtags: [],
        linkedin_post_id: null,
        publish_status: 'processing',
      },
    });
    const queue = buildQueue();
    const service = makeService(supabase, queue);

    await expect(
      service.reschedulePost({
        scheduledPostId: 'sp-1',
        userId: 'user-1',
        newScheduledFor: FUTURE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queue._added).toHaveLength(0);
  });

  it('re-validates the LinkedIn 3000-char limit before re-enqueueing', async () => {
    const supabase = buildSupabase({
      scheduledPost: {
        id: 'sp-1',
        content_id: 'content-1',
        job_id: 'old-job-1',
        status: 'scheduled',
        platform: 'linkedin',
      },
      content: {
        id: 'content-1',
        user_id: 'user-1',
        content: 'x'.repeat(3100),
        hashtags: [],
        linkedin_post_id: null,
        publish_status: 'scheduled',
      },
    });
    const queue = buildQueue();
    const service = makeService(supabase, queue);

    await expect(
      service.reschedulePost({
        scheduledPostId: 'sp-1',
        userId: 'user-1',
        newScheduledFor: FUTURE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queue._added).toHaveLength(0);
  });
});
