import { UserPublishedPostRepository } from '../user-published-post.repository';

/**
 * A chainable, awaitable PostgREST query-builder stand-in. Every method returns
 * the same builder; awaiting it (at any point in the chain) resolves to the
 * provided `{ data, error }` result. This lets us assert how the repository
 * composes a query (filters, ordering) without a live Supabase.
 */
function buildQuery(result: { data: unknown; error: unknown }) {
  const builder: any = {};
  const methods = [
    'select',
    'eq',
    'is',
    'not',
    'lt',
    'order',
    'limit',
    'update',
    'insert',
    'upsert',
    'single',
  ];
  for (const m of methods) builder[m] = jest.fn(() => builder);
  builder.then = (resolve: any, reject: any) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function buildSupabase(result: { data: unknown; error: unknown }) {
  const query = buildQuery(result);
  const client = { from: jest.fn(() => query) };
  return {
    supabaseService: { getServiceClient: () => client } as any,
    client,
    query,
  };
}

describe('UserPublishedPostRepository', () => {
  describe('getTopPerformingSamples', () => {
    it('orders by engagement_score DESC NULLS LAST, then recency', async () => {
      const { supabaseService, client, query } = buildSupabase({
        data: [
          {
            caption: 'a top post',
            visual_type: 'text',
            char_count: 10,
            published_at: '2026-06-01T00:00:00Z',
            engagement_score: 42,
          },
        ],
        error: null,
      });
      const repo = new UserPublishedPostRepository(supabaseService);

      const samples = await repo.getTopPerformingSamples(
        'user-1',
        'linkedin',
        12,
      );

      expect(client.from).toHaveBeenCalledWith('user_published_posts');
      expect(query.order).toHaveBeenCalledWith('engagement_score', {
        ascending: false,
        nullsFirst: false,
      });
      expect(query.order).toHaveBeenCalledWith('published_at', {
        ascending: false,
      });
      expect(samples[0]).toEqual({
        caption: 'a top post',
        visualType: 'text',
        charCount: 10,
        publishedAt: '2026-06-01T00:00:00Z',
        engagementScore: 42,
      });
    });

    it('throws on a query error', async () => {
      const { supabaseService } = buildSupabase({
        data: null,
        error: { message: 'boom' },
      });
      const repo = new UserPublishedPostRepository(supabaseService);

      await expect(
        repo.getTopPerformingSamples('user-1', 'linkedin'),
      ).rejects.toBeDefined();
    });
  });

  describe('getPostsAwaitingEngagement', () => {
    it('filters to unscored, post-id-bearing rows before the cutoff', async () => {
      const cutoff = '2026-06-06T00:00:00Z';
      const { supabaseService, query } = buildSupabase({
        data: [
          {
            id: 'upp-1',
            user_id: 'user-1',
            platform: 'linkedin',
            linkedin_post_id: 'urn:li:share:1',
          },
          // Defensive: a null post id slipping through is dropped by the repo.
          {
            id: 'upp-2',
            user_id: 'user-1',
            platform: 'linkedin',
            linkedin_post_id: null,
          },
        ],
        error: null,
      });
      const repo = new UserPublishedPostRepository(supabaseService);

      const pending = await repo.getPostsAwaitingEngagement(cutoff, 100);

      expect(query.is).toHaveBeenCalledWith('engagement_score', null);
      expect(query.not).toHaveBeenCalledWith('linkedin_post_id', 'is', null);
      expect(query.lt).toHaveBeenCalledWith('published_at', cutoff);
      expect(pending).toEqual([
        {
          id: 'upp-1',
          userId: 'user-1',
          platform: 'linkedin',
          linkedinPostId: 'urn:li:share:1',
        },
      ]);
    });
  });

  describe('updateEngagement', () => {
    it('writes reactions, comments, and engagement_score by id', async () => {
      const { supabaseService, client, query } = buildSupabase({
        data: null,
        error: null,
      });
      const repo = new UserPublishedPostRepository(supabaseService);

      await repo.updateEngagement({
        id: 'upp-1',
        reactions: 5,
        comments: 2,
        engagementScore: 9,
      });

      expect(client.from).toHaveBeenCalledWith('user_published_posts');
      const updatePayload = query.update.mock.calls[0][0];
      expect(updatePayload).toEqual(
        expect.objectContaining({
          reactions: 5,
          comments: 2,
          engagement_score: 9,
        }),
      );
      expect(query.eq).toHaveBeenCalledWith('id', 'upp-1');
    });

    it('throws on update error', async () => {
      const { supabaseService } = buildSupabase({
        data: null,
        error: { message: 'nope' },
      });
      const repo = new UserPublishedPostRepository(supabaseService);

      await expect(
        repo.updateEngagement({
          id: 'upp-1',
          reactions: 1,
          comments: 1,
          engagementScore: 3,
        }),
      ).rejects.toBeDefined();
    });
  });
});
