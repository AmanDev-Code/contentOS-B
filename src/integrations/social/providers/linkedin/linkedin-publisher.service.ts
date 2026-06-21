import { Logger } from '@nestjs/common';
import type { SocialHttpClient } from '../../social-http-client';
import type {
  PlatformPublisher,
  MediaUploadResult,
} from '../../platform-publisher.interface';
import { LinkedInMediaService } from './linkedin-media.service';
import {
  escapeLinkedInText,
  LINKEDIN_MAX_TEXT_LENGTH,
} from './linkedin-capabilities';
import {
  PlatformBadRequestError,
  type ConnectedAccount,
  type MediaAttachment,
  type OAuthTokenSet,
  type PostPayload,
  type PublishResult,
} from '../../types';

// Publishes posts to LinkedIn via POST /rest/posts (LinkedIn-Version header).
//
// Sprint 1.3 scope: text, single image, single PDF/document. The post id is
// read from the `x-restli-id` response header (LinkedIn does not echo it in the
// JSON body). Author URN is derived from the connected account:
//   personal      -> urn:li:person:{platformAccountId}
//   organization  -> urn:li:organization:{platformAccountId}
//
// Sprint 1.4: after uploading media we now wait until LinkedIn finishes async
// processing (status=AVAILABLE) before attaching it to the post payload.
// Organization tokens poll; personal tokens fall back to a fixed delay.

const REST_BASE = 'https://api.linkedin.com/rest';

export class LinkedInPublisherService implements PlatformPublisher {
  private readonly logger = new Logger(LinkedInPublisherService.name);

  public constructor(
    private readonly http: SocialHttpClient,
    private readonly media: LinkedInMediaService,
    private readonly apiVersion: string,
  ) {}

  public async publishPost(
    account: ConnectedAccount,
    payload: PostPayload,
    tokens: OAuthTokenSet,
  ): Promise<PublishResult> {
    if (payload.content.length > LINKEDIN_MAX_TEXT_LENGTH) {
      throw new PlatformBadRequestError(
        `Post exceeds LinkedIn's ${LINKEDIN_MAX_TEXT_LENGTH}-character limit (${payload.content.length}).`,
        { platform: 'linkedin' },
      );
    }
    if (payload.media.length > 1) {
      throw new PlatformBadRequestError(
        'LinkedIn (Sprint 1.3) supports at most one media attachment per post. Multi-image carousels arrive in Sprint 1.4.',
        { platform: 'linkedin' },
      );
    }

    const authorUrn = this.authorUrn(account);
    const isPersonal = account.accountType === 'personal';

    let content: Record<string, unknown> | undefined;
    if (payload.media.length === 1) {
      content = await this.buildMediaContent(
        authorUrn,
        payload.media[0],
        tokens.accessToken,
        isPersonal,
      );
    }

    const body: Record<string, unknown> = {
      author: authorUrn,
      commentary: escapeLinkedInText(payload.content),
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    if (content) {
      body.content = content;
    }

    const response = await this.http.request({
      method: 'POST',
      url: `${REST_BASE}/posts`,
      headers: this.headers(tokens.accessToken, 'application/json'),
      body: JSON.stringify(body),
    });

    const platformPostId =
      response.headers['x-restli-id'] ??
      response.headers['x-linkedin-id'] ??
      '';
    if (!platformPostId) {
      throw new PlatformBadRequestError(
        'LinkedIn accepted the post but returned no post id header (x-restli-id).',
        { platform: 'linkedin', httpStatus: response.status },
      );
    }

    return {
      platformPostId,
      platformPostUrl: `https://www.linkedin.com/feed/update/${platformPostId}`,
      publishedAt: new Date(),
      raw: { status: response.status },
    };
  }

  public async deletePost(
    account: ConnectedAccount,
    platformPostId: string,
    tokens: OAuthTokenSet,
  ): Promise<void> {
    const encoded = encodeURIComponent(platformPostId);
    try {
      await this.http.request({
        method: 'DELETE',
        url: `${REST_BASE}/posts/${encoded}`,
        headers: this.headers(tokens.accessToken, 'application/json'),
      });
    } catch (err) {
      this.logger.warn(
        `LinkedIn deletePost failed for ${platformPostId}: ${String(err)}`,
      );
      throw err;
    }
  }

  public async uploadMedia(
    account: ConnectedAccount,
    asset: MediaAttachment,
    tokens: OAuthTokenSet,
  ): Promise<MediaUploadResult> {
    const isPersonal = account.accountType === 'personal';
    const { assetUrn, mediaType } = await this.media.upload(
      this.authorUrn(account),
      asset,
      tokens.accessToken,
    );
    await this.media.waitForReady(
      assetUrn,
      tokens.accessToken,
      mediaType,
      isPersonal,
    );
    return { platformAssetId: assetUrn };
  }

  private async buildMediaContent(
    authorUrn: string,
    asset: MediaAttachment,
    accessToken: string,
    isPersonalToken: boolean,
  ): Promise<Record<string, unknown>> {
    const { assetUrn, mediaType } = await this.media.upload(
      authorUrn,
      asset,
      accessToken,
    );
    await this.media.waitForReady(
      assetUrn,
      accessToken,
      mediaType,
      isPersonalToken,
    );
    return {
      media: {
        id: assetUrn,
        ...(asset.altText ? { altText: asset.altText } : {}),
      },
    };
  }

  private authorUrn(account: ConnectedAccount): string {
    const prefix =
      account.accountType === 'organization' ? 'organization' : 'person';
    return `urn:li:${prefix}:${account.platformAccountId}`;
  }

  private headers(
    accessToken: string,
    contentType: string,
  ): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': contentType,
      'LinkedIn-Version': this.apiVersion,
      'X-Restli-Protocol-Version': '2.0.0',
    };
  }
}
