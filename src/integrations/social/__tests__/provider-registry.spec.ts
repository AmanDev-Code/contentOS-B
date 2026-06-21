import { Test } from '@nestjs/testing';
import { ProviderRegistryService } from '../provider-registry.service';
import type {
  PlatformAuth,
  AuthorizationUrlResult,
} from '../platform-auth.interface';
import type {
  PlatformPublisher,
  MediaUploadResult,
} from '../platform-publisher.interface';
import type { PlatformAnalytics } from '../platform-analytics.interface';
import type { PlatformCapabilities } from '../platform-capabilities.interface';
import type {
  AccountAnalytics,
  ConnectedAccount,
  MediaAttachment,
  OAuthTokenSet,
  Platform,
  PostAnalytics,
  PostPayload,
  PublishResult,
  ScopeValidation,
} from '../types';

class StubAuth implements PlatformAuth {
  public async getAuthorizationUrl(): Promise<AuthorizationUrlResult> {
    return { url: 'https://example.test/auth' };
  }
  public async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    return { accessToken: 'a', expiresAt: new Date(), scopes: [] };
  }
  public async refreshTokens(): Promise<OAuthTokenSet> {
    return { accessToken: 'b', expiresAt: new Date(), scopes: [] };
  }
  public async revokeTokens(): Promise<void> {}
  public validateScopes(): ScopeValidation {
    return { ok: true, missing: [] };
  }
  public getRequiredScopes(): readonly string[] {
    return [];
  }
}

class StubPublisher implements PlatformPublisher {
  public async publishPost(
    _account: ConnectedAccount,
    _payload: PostPayload,
    _tokens: OAuthTokenSet,
  ): Promise<PublishResult> {
    return {
      platformPostId: 'p_1',
      publishedAt: new Date(),
      raw: {},
    };
  }
  public async deletePost(): Promise<void> {}
  public async uploadMedia(
    _account: ConnectedAccount,
    _asset: MediaAttachment,
    _tokens: OAuthTokenSet,
  ): Promise<MediaUploadResult> {
    return { platformAssetId: 'asset_1' };
  }
}

class StubAnalytics implements PlatformAnalytics {
  public async getAccountAnalytics(): Promise<AccountAnalytics> {
    return {
      windowStart: new Date(),
      windowEnd: new Date(),
      metrics: {},
      raw: {},
    };
  }
  public async getPostAnalytics(): Promise<PostAnalytics> {
    return {
      platformPostId: 'p_1',
      capturedAt: new Date(),
      metrics: {},
      raw: {},
    };
  }
}

const stubCaps: PlatformCapabilities = {
  supportsImages: true,
  supportsVideo: false,
  supportsCarousel: true,
  maxTextLength: 3000,
  maxImagesPerPost: 9,
  supportsScheduling: true,
  supportsThreads: false,
  supportsComments: true,
};

describe('ProviderRegistryService', () => {
  let registry: ProviderRegistryService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ProviderRegistryService],
    }).compile();
    registry = moduleRef.get(ProviderRegistryService);
  });

  it('returns undefined for an unknown platform', () => {
    expect(registry.getProvider('linkedin')).toBeUndefined();
    expect(registry.hasProvider('linkedin')).toBe(false);
  });

  it('registers and retrieves a provider bundle', () => {
    const bundle = {
      auth: new StubAuth(),
      publisher: new StubPublisher(),
      capabilities: stubCaps,
    };
    registry.registerProvider('linkedin', bundle);

    const retrieved = registry.getProvider('linkedin');
    expect(retrieved).toBe(bundle);
    expect(registry.hasProvider('linkedin')).toBe(true);
    expect(registry.listPlatforms()).toEqual(['linkedin']);
  });

  it('preserves optional analytics when supplied', () => {
    const analytics = new StubAnalytics();
    registry.registerProvider('linkedin', {
      auth: new StubAuth(),
      publisher: new StubPublisher(),
      analytics,
      capabilities: stubCaps,
    });

    const retrieved = registry.getProvider('linkedin');
    expect(retrieved?.analytics).toBe(analytics);
  });

  it('rejects double registration for the same platform', () => {
    const bundle = {
      auth: new StubAuth(),
      publisher: new StubPublisher(),
      capabilities: stubCaps,
    };
    registry.registerProvider('linkedin', bundle);

    expect(() => registry.registerProvider('linkedin', bundle)).toThrow(
      /already registered/i,
    );
  });

  it('treats different platforms independently', () => {
    const a = {
      auth: new StubAuth(),
      publisher: new StubPublisher(),
      capabilities: stubCaps,
    };
    const b = {
      auth: new StubAuth(),
      publisher: new StubPublisher(),
      capabilities: { ...stubCaps, supportsVideo: true },
    };
    registry.registerProvider('linkedin', a);
    registry.registerProvider('x', b);

    expect(registry.getProvider('linkedin')).toBe(a);
    expect(registry.getProvider('x')).toBe(b);
    expect([...registry.listPlatforms()].sort()).toEqual(['linkedin', 'x']);
  });
});
