import type {
  ConnectedAccount,
  MediaAttachment,
  OAuthTokenSet,
  PostPayload,
  PublishResult,
} from './types';

export interface MediaUploadResult {
  readonly platformAssetId: string;
  readonly durableUrl?: string;
}

// Publishing operations only. Auth, analytics, and capability metadata live in
// sibling interfaces so each provider can mix-and-match implementations without
// inheriting unrelated surface area.
export interface PlatformPublisher {
  publishPost(
    account: ConnectedAccount,
    payload: PostPayload,
    tokens: OAuthTokenSet,
  ): Promise<PublishResult>;

  deletePost(
    account: ConnectedAccount,
    platformPostId: string,
    tokens: OAuthTokenSet,
  ): Promise<void>;

  uploadMedia(
    account: ConnectedAccount,
    asset: MediaAttachment,
    tokens: OAuthTokenSet,
  ): Promise<MediaUploadResult>;
}
