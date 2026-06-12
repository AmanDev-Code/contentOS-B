import { LinkedInPublishBridgeService } from '../linkedin-publish-bridge.service';
import type { ConnectedAccount, OAuthTokenSet, PostPayload } from '../../../types';

const account: ConnectedAccount = {
  id: 'acc-1',
  userId: 'user-1',
  platform: 'linkedin',
  platformAccountId: 'member-1',
  accountType: 'personal',
  displayName: 'Ada',
  profileUrl: null,
  avatarUrl: null,
  status: 'active',
  connectedAt: new Date(),
  lastUsedAt: null,
  metadata: {},
};

function validTokens(): OAuthTokenSet {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: ['w_member_social'],
  };
}

function make(overrides: {
  getConnectedLinkedIn?: jest.Mock;
  readTokens?: jest.Mock;
  rotateTokens?: jest.Mock;
  refreshTokens?: jest.Mock;
  publishPost?: jest.Mock;
}) {
  const connections = {
    getConnectedLinkedIn:
      overrides.getConnectedLinkedIn ?? jest.fn().mockResolvedValue(account),
  } as never;
  const tokenVault = {
    readTokens: overrides.readTokens ?? jest.fn().mockResolvedValue(validTokens()),
    rotateTokens: overrides.rotateTokens ?? jest.fn().mockResolvedValue(undefined),
  } as never;
  const auth = {
    refreshTokens: overrides.refreshTokens ?? jest.fn(),
  } as never;
  const publisher = {
    publishPost:
      overrides.publishPost ??
      jest.fn().mockResolvedValue({ platformPostId: 'urn:li:share:123' }),
  } as never;
  const service = new LinkedInPublishBridgeService(connections, tokenVault, auth, publisher);
  return { service, connections, tokenVault, auth, publisher };
}

describe('LinkedInPublishBridgeService.publish', () => {
  it('returns not_connected when the user has no new-model account', async () => {
    const { service } = make({ getConnectedLinkedIn: jest.fn().mockResolvedValue(null) });
    const result = await service.publish({
      userId: 'user-1',
      text: 'hello',
      mediaType: 'text',
    });
    expect(result).toEqual({ status: 'not_connected' });
  });

  it('returns not_connected when the account has no usable token', async () => {
    const { service } = make({ readTokens: jest.fn().mockResolvedValue(null) });
    const result = await service.publish({
      userId: 'user-1',
      text: 'hello',
      mediaType: 'text',
    });
    expect(result).toEqual({ status: 'not_connected' });
  });

  it('publishes a text post with no media', async () => {
    const publishPost = jest
      .fn()
      .mockResolvedValue({ platformPostId: 'urn:li:share:123' });
    const { service } = make({ publishPost });

    const result = await service.publish({
      userId: 'user-1',
      text: 'hello world',
      mediaType: 'text',
    });

    expect(result).toEqual({ status: 'published', postId: 'urn:li:share:123' });
    const payload = publishPost.mock.calls[0][1] as PostPayload;
    expect(payload.content).toBe('hello world');
    expect(payload.media).toHaveLength(0);
  });

  it('builds an image attachment from a MinIO public URL', async () => {
    const publishPost = jest
      .fn()
      .mockResolvedValue({ platformPostId: 'urn:li:share:9' });
    const { service } = make({ publishPost });

    await service.publish({
      userId: 'user-1',
      text: 'with image',
      mediaType: 'image',
      mediaUrl: 'https://media.trndinn.com/contentos-media/posts/pic.png',
    });

    const payload = publishPost.mock.calls[0][1] as PostPayload;
    expect(payload.media).toHaveLength(1);
    expect(payload.media[0].kind).toBe('image');
    expect(payload.media[0].mimeType).toBe('image/png');
    expect(payload.media[0].storagePath).toBe('contentos-media/posts/pic.png');
  });

  it('strips the /minio proxy prefix from a media URL when building the storage path', async () => {
    const publishPost = jest
      .fn()
      .mockResolvedValue({ platformPostId: 'urn:li:share:10' });
    const { service } = make({ publishPost });

    // Trndinn serves media through the MinIO proxy controller (`/minio/...`),
    // so generated URLs include that route prefix. The byte reader needs a
    // `bucket/key` path, NOT `minio/bucket/key`.
    await service.publish({
      userId: 'user-1',
      text: 'with proxied image',
      mediaType: 'image',
      mediaUrl:
        'https://api.trndinn.com/minio/contentos-media/user-1/123-custom-image.png',
    });

    const payload = publishPost.mock.calls[0][1] as PostPayload;
    expect(payload.media[0].storagePath).toBe(
      'contentos-media/user-1/123-custom-image.png',
    );
  });

  it('strips the /minio proxy prefix from a relative media path', async () => {
    const publishPost = jest
      .fn()
      .mockResolvedValue({ platformPostId: 'urn:li:share:11' });
    const { service } = make({ publishPost });

    await service.publish({
      userId: 'user-1',
      text: 'relative path',
      mediaType: 'image',
      mediaUrl: '/minio/contentos-media/user-1/456-pic.jpg',
    });

    const payload = publishPost.mock.calls[0][1] as PostPayload;
    expect(payload.media[0].storagePath).toBe(
      'contentos-media/user-1/456-pic.jpg',
    );
  });

  it('refreshes + rotates an expired token before publishing', async () => {
    const expired: OAuthTokenSet = {
      accessToken: 'old',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() - 1000),
      scopes: ['w_member_social'],
    };
    const refreshed: OAuthTokenSet = {
      accessToken: 'new',
      refreshToken: 'rt2',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['w_member_social'],
    };
    const refreshTokens = jest.fn().mockResolvedValue(refreshed);
    const rotateTokens = jest.fn().mockResolvedValue(undefined);
    const publishPost = jest
      .fn()
      .mockResolvedValue({ platformPostId: 'urn:li:share:55' });
    const { service } = make({
      readTokens: jest.fn().mockResolvedValue(expired),
      refreshTokens,
      rotateTokens,
      publishPost,
    });

    await service.publish({ userId: 'user-1', text: 'hi', mediaType: 'text' });

    expect(refreshTokens).toHaveBeenCalledWith('rt');
    expect(rotateTokens).toHaveBeenCalledWith('acc-1', refreshed);
    expect(publishPost.mock.calls[0][2]).toBe(refreshed);
  });

  it('returns not_connected when token expired and no refresh token exists', async () => {
    const expiredNoRefresh: OAuthTokenSet = {
      accessToken: 'old',
      expiresAt: new Date(Date.now() - 1000),
      scopes: ['w_member_social'],
    };
    const { service } = make({
      readTokens: jest.fn().mockResolvedValue(expiredNoRefresh),
    });
    const result = await service.publish({
      userId: 'user-1',
      text: 'hi',
      mediaType: 'text',
    });
    expect(result).toEqual({ status: 'not_connected' });
  });
});
