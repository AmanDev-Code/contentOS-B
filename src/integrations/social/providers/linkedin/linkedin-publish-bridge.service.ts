import { Injectable, Logger } from '@nestjs/common';
import { SocialConnectionBridgeService } from '../../social-connection-bridge.service';
import { TokenVaultService } from '../../token-vault.service';
import { LinkedInAuthService } from './linkedin-auth.service';
import { LinkedInPublisherService } from './linkedin-publisher.service';
import type { MediaAttachment, OAuthTokenSet, PostPayload } from '../../types';

// Sprint 1.4 queue bridge. Adapts Trndinn's existing publish call-shape
// (userId + text + a MinIO media URL) onto the new provider engine:
//   1. resolve the connected account from social_accounts (new model)
//   2. read + refresh the Vault-encrypted OAuth token
//   3. translate the MinIO public URL into a storage path the byte reader reads
//   4. delegate to LinkedInPublisherService
//
// If the user has NOT been migrated into the new model yet (no social_accounts
// row), publish() returns { status: 'not_connected' } so the caller can safely
// fall back to the legacy linkedin.service.ts path. This keeps the rollout
// non-breaking: only users connected under FEATURE_SOCIAL_PROVIDER_V2 use it.

const TOKEN_EXPIRY_SKEW_MS = 60_000;

export type LinkedInPublishMediaType = 'text' | 'image' | 'document';

export interface LinkedInPublishBridgeParams {
  readonly userId: string;
  readonly text: string;
  readonly mediaType: LinkedInPublishMediaType;
  readonly mediaUrl?: string;
}

export type LinkedInPublishBridgeResult =
  | { readonly status: 'published'; readonly postId: string }
  | { readonly status: 'not_connected' };

@Injectable()
export class LinkedInPublishBridgeService {
  private readonly logger = new Logger(LinkedInPublishBridgeService.name);

  public constructor(
    private readonly connections: SocialConnectionBridgeService,
    private readonly tokenVault: TokenVaultService,
    private readonly auth: LinkedInAuthService,
    private readonly publisher: LinkedInPublisherService,
  ) {}

  public async publish(
    params: LinkedInPublishBridgeParams,
  ): Promise<LinkedInPublishBridgeResult> {
    const account = await this.connections.getConnectedLinkedIn(params.userId);
    if (!account) {
      return { status: 'not_connected' };
    }

    const tokens = await this.getValidTokens(account.id);
    if (!tokens) {
      // Account row exists but no usable token — treat as not migrated so the
      // legacy path (which has its own token store) can still publish.
      this.logger.warn(
        `LinkedIn account ${account.id} has no usable Vault token; falling back to legacy.`,
      );
      return { status: 'not_connected' };
    }

    const media =
      params.mediaType === 'text' || !params.mediaUrl
        ? []
        : [this.buildAttachment(params.mediaType, params.mediaUrl)];

    const payload: PostPayload = {
      content: params.text,
      media,
      metadata: {},
    };

    const result = await this.publisher.publishPost(account, payload, tokens);
    return { status: 'published', postId: result.platformPostId };
  }

  private async getValidTokens(accountId: string): Promise<OAuthTokenSet | null> {
    const tokens = await this.tokenVault.readTokens(accountId);
    if (!tokens) return null;

    const stillValid = tokens.expiresAt.getTime() > Date.now() + TOKEN_EXPIRY_SKEW_MS;
    if (stillValid) return tokens;

    if (!tokens.refreshToken) return null;

    const refreshed = await this.auth.refreshTokens(tokens.refreshToken);
    await this.tokenVault.rotateTokens(accountId, refreshed);
    return refreshed;
  }

  // The byte reader accepts a bare object key or a "bucket/key" path. Trndinn
  // serves media through the MinIO proxy controller mounted at `/minio`, so its
  // public URLs look like `https://host/minio/<bucket>/<key>` (or the relative
  // `/minio/<bucket>/<key>`). The `/minio/` segment is the proxy ROUTE prefix,
  // NOT part of the object key — it must be stripped or the byte reader builds a
  // bogus key (`minio/<bucket>/<key>`) and MinIO returns "key does not exist".
  private buildAttachment(
    mediaType: Exclude<LinkedInPublishMediaType, 'text'>,
    mediaUrl: string,
  ): MediaAttachment {
    const storagePath = this.toStoragePath(mediaUrl);
    const kind = mediaType === 'document' ? 'document' : 'image';
    const mimeType =
      mediaType === 'document' ? 'application/pdf' : this.guessImageMime(storagePath);
    return {
      id: storagePath,
      kind,
      mimeType,
      sizeBytes: 0,
      storagePath,
    };
  }

  private toStoragePath(mediaUrl: string): string {
    let path: string;
    try {
      const u = new URL(mediaUrl);
      path = u.pathname;
    } catch {
      // Not a URL — assume it is already a path/object key.
      path = mediaUrl;
    }
    // Drop leading slashes, then strip the MinIO proxy route prefix (`minio/`)
    // if present. What remains is a `bucket/key` path that the byte reader
    // resolves against the default bucket.
    return path.replace(/^\/+/, '').replace(/^minio\//, '');
  }

  private guessImageMime(path: string): string {
    const lower = path.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
  }
}
