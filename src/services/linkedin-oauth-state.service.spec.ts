import { LinkedinOAuthStateService } from './linkedin-oauth-state.service';
import { CacheService } from './cache.service';

describe('LinkedinOAuthStateService', () => {
  let service: LinkedinOAuthStateService;
  let cache: Map<string, string>;

  beforeEach(() => {
    cache = new Map();
    const cacheService = {
      set: jest.fn(async (key: string, value: string) => {
        cache.set(key, value);
      }),
      get: jest.fn(async (key: string) => cache.get(key) ?? null),
      delete: jest.fn(async (key: string) => {
        cache.delete(key);
      }),
    } as unknown as CacheService;

    service = new LinkedinOAuthStateService(cacheService);
  });

  it('stores and returns returnTo metadata for company-page flow', async () => {
    const state = await service.createStateForUser('user-1', {
      flow: 'connect-pages',
      returnTo: '/dashboard',
    });

    const result = await service.consumeState(state);
    expect(result).toEqual({
      userId: 'user-1',
      metadata: {
        flow: 'connect-pages',
        returnTo: '/dashboard',
      },
    });
  });
});
