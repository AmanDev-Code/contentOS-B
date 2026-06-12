import { PostEngagementSyncCronService } from '../post-engagement-sync.cron';
import type { PendingEngagementPost } from '../../repositories/user-published-post.repository';

function makePending(
  overrides: Partial<PendingEngagementPost> = {},
): PendingEngagementPost {
  return {
    id: 'upp-1',
    userId: 'user-1',
    platform: 'linkedin',
    linkedinPostId: 'urn:li:share:111',
    ...overrides,
  };
}

function buildFakeRepo(pending: PendingEngagementPost[] = []) {
  return {
    getPostsAwaitingEngagement: jest.fn().mockResolvedValue(pending),
    updateEngagement: jest.fn().mockResolvedValue(undefined),
  };
}

function buildFakeLinkedin(opts: {
  identities?: Array<{
    actorType: 'member' | 'organization';
    organizationUrn?: string;
    id: string;
    label: string;
  }>;
  orgAnalytics?: Array<{ id: string; likes: number; comments: number }>;
  member?: {
    available: boolean;
    byPostId: Map<string, { reactions: number; comments: number }>;
  };
} = {}) {
  return {
    getPostingIdentities: jest.fn().mockResolvedValue({
      defaultIdentityId: 'member:self',
      identities: opts.identities ?? [],
    }),
    getPostAnalytics: jest.fn().mockResolvedValue(opts.orgAnalytics ?? []),
    getMemberPostEngagement: jest.fn().mockResolvedValue(
      opts.member ?? { available: true, byPostId: new Map() },
    ),
  };
}

describe('PostEngagementSyncCronService', () => {
  it('does nothing when no posts await engagement', async () => {
    const repo = buildFakeRepo([]);
    const linkedin = buildFakeLinkedin();
    const service = new PostEngagementSyncCronService(
      repo as any,
      linkedin as any,
    );

    await service.sync();

    expect(repo.updateEngagement).not.toHaveBeenCalled();
    expect(linkedin.getMemberPostEngagement).not.toHaveBeenCalled();
  });

  it('queries with a ~24h cutoff', async () => {
    const repo = buildFakeRepo([]);
    const linkedin = buildFakeLinkedin();
    const service = new PostEngagementSyncCronService(
      repo as any,
      linkedin as any,
    );

    const before = Date.now();
    await service.sync();
    const after = Date.now();

    const cutoffIso = repo.getPostsAwaitingEngagement.mock.calls[0][0] as string;
    const cutoffMs = new Date(cutoffIso).getTime();
    const elapsed24h = 24 * 60 * 60 * 1000;
    expect(cutoffMs).toBeGreaterThanOrEqual(before - elapsed24h - 5000);
    expect(cutoffMs).toBeLessThanOrEqual(after - elapsed24h + 5000);
  });

  it('scores an ORG post from org analytics (reactions + comments*2)', async () => {
    const post = makePending({ linkedinPostId: 'urn:li:share:111' });
    const repo = buildFakeRepo([post]);
    const linkedin = buildFakeLinkedin({
      identities: [
        {
          actorType: 'organization',
          organizationUrn: 'urn:li:organization:42',
          id: 'org:urn:li:organization:42',
          label: 'Acme',
        },
      ],
      orgAnalytics: [{ id: 'urn:li:share:111', likes: 10, comments: 3 }],
    });
    const service = new PostEngagementSyncCronService(
      repo as any,
      linkedin as any,
    );

    await service.sync();

    expect(repo.updateEngagement).toHaveBeenCalledTimes(1);
    expect(repo.updateEngagement).toHaveBeenCalledWith({
      id: 'upp-1',
      reactions: 10,
      comments: 3,
      engagementScore: 16,
    });
    // Org match should NOT fall through to the personal path.
    expect(linkedin.getMemberPostEngagement).not.toHaveBeenCalled();
  });

  it('scores a PERSONAL post when member analytics are available', async () => {
    const post = makePending({ linkedinPostId: 'urn:li:share:222' });
    const repo = buildFakeRepo([post]);
    const member = {
      available: true,
      byPostId: new Map([
        ['urn:li:share:222', { reactions: 5, comments: 2 }],
      ]),
    };
    const linkedin = buildFakeLinkedin({ identities: [], member });
    const service = new PostEngagementSyncCronService(
      repo as any,
      linkedin as any,
    );

    await service.sync();

    expect(linkedin.getMemberPostEngagement).toHaveBeenCalledTimes(1);
    expect(repo.updateEngagement).toHaveBeenCalledWith({
      id: 'upp-1',
      reactions: 5,
      comments: 2,
      engagementScore: 9,
    });
  });

  it('degrades gracefully when personal scope (r_member_social) is missing', async () => {
    const post = makePending({ linkedinPostId: 'urn:li:share:333' });
    const repo = buildFakeRepo([post]);
    const linkedin = buildFakeLinkedin({
      identities: [],
      member: { available: false, byPostId: new Map() },
    });
    const service = new PostEngagementSyncCronService(
      repo as any,
      linkedin as any,
    );

    // Must not throw, and must not write any engagement (keeps recency ranking).
    await expect(service.sync()).resolves.toBeUndefined();
    expect(repo.updateEngagement).not.toHaveBeenCalled();
  });

  it('leaves a personal post unscored when member analytics has no reading for it', async () => {
    const post = makePending({ linkedinPostId: 'urn:li:share:444' });
    const repo = buildFakeRepo([post]);
    const linkedin = buildFakeLinkedin({
      identities: [],
      member: { available: true, byPostId: new Map() },
    });
    const service = new PostEngagementSyncCronService(
      repo as any,
      linkedin as any,
    );

    await service.sync();

    expect(repo.updateEngagement).not.toHaveBeenCalled();
  });

  it('isolates a failing user from the rest of the batch', async () => {
    const postA = makePending({ id: 'a', userId: 'user-A', linkedinPostId: 'urn:li:share:A' });
    const postB = makePending({ id: 'b', userId: 'user-B', linkedinPostId: 'urn:li:share:B' });
    const repo = buildFakeRepo([postA, postB]);
    const linkedin = buildFakeLinkedin({
      identities: [],
      member: { available: true, byPostId: new Map([['urn:li:share:b', { reactions: 1, comments: 1 }]]) },
    });
    // user-A blows up during posting-identity lookup; user-B must still process.
    linkedin.getPostingIdentities.mockImplementation(async (userId: string) => {
      if (userId === 'user-A') throw new Error('boom');
      return { defaultIdentityId: 'member:self', identities: [] };
    });
    const service = new PostEngagementSyncCronService(
      repo as any,
      linkedin as any,
    );

    await expect(service.sync()).resolves.toBeUndefined();
    // getPostingIdentities throwing is caught inside fetchOrganizationEngagement,
    // so user-A still proceeds to the personal path (no reading -> no write);
    // user-B gets scored. Net: exactly one write, for user-B.
    expect(repo.updateEngagement).toHaveBeenCalledTimes(1);
    expect(repo.updateEngagement).toHaveBeenCalledWith({
      id: 'b',
      reactions: 1,
      comments: 1,
      engagementScore: 3,
    });
  });
});
