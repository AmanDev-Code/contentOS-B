import { Logger } from '@nestjs/common';
import type { SocialHttpClient } from '../../social-http-client';
import type { MediaByteReader } from '../../media-byte-reader';
import { PlatformBadRequestError, type MediaAttachment } from '../../types';

// LinkedIn media upload (REST, LinkedIn-Version header required).
//
// Two-step pattern (Phase 0 deep-map, Recallium #1054):
//   1. POST /rest/{images|documents}?action=initializeUpload with the owner URN
//      -> returns { value: { uploadUrl, image|document: <assetUrn> } }
//   2. PUT the raw bytes to uploadUrl
//   3. Wait until media is AVAILABLE (LinkedIn processes asynchronously)
//   4. Reference <assetUrn> in the post payload
//
// Sprint 1.3 supports single image and single document (PDF). Video uses a
// chunked initialize/finalize flow and lands in Sprint 1.5.
//
// Sprint 1.4 addition: waitForReady() polls LinkedIn's GET /rest/{type}/{urn}
// until status=AVAILABLE. Organization tokens can poll; personal (w_member_social)
// tokens are write-only and must fall back to a fixed delay (Postiz pattern).

const REST_BASE = 'https://api.linkedin.com/rest';

export type LinkedInMediaType = 'images' | 'documents' | 'videos';

export interface LinkedInMediaUploadResult {
  readonly assetUrn: string;
  readonly mediaType: LinkedInMediaType;
}

interface InitializeUploadResponse {
  readonly value?: {
    readonly uploadUrl?: string;
    readonly image?: string;
    readonly document?: string;
  };
}

interface MediaStatusResponse {
  readonly status?: string;
  readonly processingFailureReason?: string;
}

const PERSONAL_TOKEN_FALLBACK_MS = 10_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 20;
const POLL_INTERVAL_IMAGE_MS = 5_000;
const POLL_INTERVAL_VIDEO_MS = 30_000;

export class LinkedInMediaService {
  private readonly logger = new Logger(LinkedInMediaService.name);
  private readonly sleepFn: (ms: number) => Promise<void>;

  public constructor(
    private readonly http: SocialHttpClient,
    private readonly apiVersion: string,
    private readonly byteReader: MediaByteReader,
    sleepFn?: (ms: number) => Promise<void>,
  ) {
    this.sleepFn =
      sleepFn ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  public async upload(
    ownerUrn: string,
    asset: MediaAttachment,
    accessToken: string,
  ): Promise<LinkedInMediaUploadResult> {
    const kind = this.resolveKind(asset);
    const endpoint = kind === 'image' ? 'images' : 'documents';
    const mediaType: LinkedInMediaType =
      kind === 'image' ? 'images' : 'documents';

    const initResponse = await this.http.request({
      method: 'POST',
      url: `${REST_BASE}/${endpoint}?action=initializeUpload`,
      headers: this.headers(accessToken, 'application/json'),
      body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
    });

    const init = (await initResponse.json()) as InitializeUploadResponse;
    const uploadUrl = init.value?.uploadUrl;
    const assetUrn =
      kind === 'image' ? init.value?.image : init.value?.document;
    if (!uploadUrl || !assetUrn) {
      throw new PlatformBadRequestError(
        'LinkedIn did not return an upload URL or asset URN.',
        {
          platform: 'linkedin',
          raw: init,
        },
      );
    }

    const bytes = await this.byteReader.read(asset);
    await this.http.request({
      method: 'PUT',
      url: uploadUrl,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': asset.mimeType,
      },
      body: new Uint8Array(bytes),
    });

    return { assetUrn, mediaType };
  }

  /**
   * Polls LinkedIn until the uploaded media reaches AVAILABLE status.
   *
   * Organization tokens can GET /rest/{images|documents|videos}/{urn} to check
   * processing status. Personal tokens (w_member_social) are write-only for
   * these endpoints — polling always returns 403 — so we fall back to a fixed
   * delay instead.
   */
  public async waitForReady(
    assetUrn: string,
    accessToken: string,
    mediaType: LinkedInMediaType,
    isPersonalToken: boolean,
    maxAttempts: number = DEFAULT_MAX_POLL_ATTEMPTS,
  ): Promise<void> {
    if (isPersonalToken) {
      this.logger.log(
        `Personal token — skipping media poll, waiting ${PERSONAL_TOKEN_FALLBACK_MS}ms for ${mediaType} ${assetUrn}`,
      );
      await this.sleepFn(PERSONAL_TOKEN_FALLBACK_MS);
      return;
    }

    const intervalMs =
      mediaType === 'videos' ? POLL_INTERVAL_VIDEO_MS : POLL_INTERVAL_IMAGE_MS;
    const label =
      mediaType === 'videos'
        ? 'video'
        : mediaType === 'documents'
          ? 'document'
          : 'image';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let json: MediaStatusResponse;
      try {
        const response = await this.http.request({
          method: 'GET',
          url: `${REST_BASE}/${mediaType}/${encodeURIComponent(assetUrn)}`,
          headers: this.headers(accessToken, 'application/json'),
        });
        json = (await response.json()) as MediaStatusResponse;
      } catch (err) {
        this.logger.warn(
          `Poll attempt ${attempt}/${maxAttempts} for ${label} ${assetUrn} failed: ${String(err)}`,
        );
        if (attempt === maxAttempts) {
          throw new PlatformBadRequestError(
            `Failed to check LinkedIn ${label} processing status after ${maxAttempts} attempts.`,
            { platform: 'linkedin' },
          );
        }
        await this.sleepFn(intervalMs);
        continue;
      }

      if (json.status === 'AVAILABLE') {
        this.logger.log(
          `LinkedIn ${label} ${assetUrn} is AVAILABLE (attempt ${attempt})`,
        );
        return;
      }

      if (json.status === 'PROCESSING_FAILED') {
        throw new PlatformBadRequestError(
          `LinkedIn ${label} processing failed${json.processingFailureReason ? `: ${json.processingFailureReason}` : ''}`,
          { platform: 'linkedin', raw: json },
        );
      }

      this.logger.debug(
        `LinkedIn ${label} ${assetUrn} status=${json.status ?? 'unknown'}, polling again (${attempt}/${maxAttempts})`,
      );
      await this.sleepFn(intervalMs);
    }

    throw new PlatformBadRequestError(
      `Timed out waiting for LinkedIn ${label} to be ready after ${maxAttempts} attempts`,
      { platform: 'linkedin' },
    );
  }

  private resolveKind(asset: MediaAttachment): 'image' | 'document' {
    if (asset.kind === 'image') return 'image';
    if (asset.kind === 'document' || asset.kind === 'pdf') return 'document';
    throw new PlatformBadRequestError(
      `LinkedIn (Sprint 1.3) supports image and PDF/document uploads only; got "${asset.kind}".`,
      { platform: 'linkedin' },
    );
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
