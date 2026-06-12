import { PostStyleLearningService } from './post-style-learning.service';
import type { PublishedPostStyleSample } from '../../repositories/user-published-post.repository';

const LONG_A =
  'Stop optimizing your resume and start optimizing your network. ' +
  'Here is the exact 3-step system I used to land 4 offers in 6 weeks.';
const LONG_B =
  'Nobody tells you this about fundraising: the deck barely matters. ' +
  'What actually moves investors is a tight narrative and real traction.';

function sample(
  caption: string,
  engagementScore: number | null = null,
): PublishedPostStyleSample {
  return {
    caption,
    visualType: 'text',
    charCount: caption.length,
    publishedAt: '2026-06-01T00:00:00.000Z',
    engagementScore,
  };
}

function buildFakeRepo(opts: {
  top?: PublishedPostStyleSample[];
  fallback?: PublishedPostStyleSample[];
  topThrows?: boolean;
}) {
  return {
    getTopPerformingSamples: jest.fn(async () => {
      if (opts.topThrows) throw new Error('db down');
      return opts.top ?? [];
    }),
    getFallbackFromGeneratedContent: jest.fn(async () => opts.fallback ?? []),
    // Present so we can assert the service no longer relies on it.
    getRecentSamples: jest.fn(async () => []),
  };
}

describe('PostStyleLearningService', () => {
  it('prefers top-performing samples (engagement ranking) over recency', async () => {
    const repo = buildFakeRepo({
      top: [sample(LONG_A, 42), sample(LONG_B, 17)],
    });
    const service = new PostStyleLearningService(repo as any);

    const block = await service.buildStyleProfileBlock('user-1', 'linkedin');

    expect(repo.getTopPerformingSamples).toHaveBeenCalledWith(
      'user-1',
      'linkedin',
      12,
    );
    expect(repo.getRecentSamples).not.toHaveBeenCalled();
    expect(block).toContain('YOUR PAST POSTS');
    expect(block).toContain('Stop optimizing your resume');
    expect(block).toContain('Nobody tells you this about fundraising');
  });

  it('falls back to generated_content when too few published samples', async () => {
    const repo = buildFakeRepo({
      top: [sample(LONG_A, null)],
      fallback: [sample(LONG_A, null), sample(LONG_B, null)],
    });
    const service = new PostStyleLearningService(repo as any);

    const block = await service.buildStyleProfileBlock('user-1', 'linkedin');

    expect(repo.getFallbackFromGeneratedContent).toHaveBeenCalled();
    expect(block).toContain('YOUR PAST POSTS');
  });

  it('returns undefined when there are not enough usable samples', async () => {
    const repo = buildFakeRepo({ top: [sample('too short', null)] });
    const service = new PostStyleLearningService(repo as any);

    const block = await service.buildStyleProfileBlock('user-1', 'linkedin');

    expect(block).toBeUndefined();
  });

  it('returns undefined for anonymous users without hitting the repo', async () => {
    const repo = buildFakeRepo({ top: [sample(LONG_A, 5), sample(LONG_B, 5)] });
    const service = new PostStyleLearningService(repo as any);

    const block = await service.buildStyleProfileBlock('anonymous', 'linkedin');

    expect(block).toBeUndefined();
    expect(repo.getTopPerformingSamples).not.toHaveBeenCalled();
  });

  it('never throws into the generation path — swallows repo errors', async () => {
    const repo = buildFakeRepo({ topThrows: true });
    const service = new PostStyleLearningService(repo as any);

    await expect(
      service.buildStyleProfileBlock('user-1', 'linkedin'),
    ).resolves.toBeUndefined();
  });
});
