import { SetMetadata } from '@nestjs/common';

/**
 * Supported social platforms (expand as needed)
 * Currently only LinkedIn is implemented, but the structure supports future platforms.
 */
export type SocialPlatform =
  | 'linkedin'
  | 'x'
  | 'youtube'
  | 'facebook'
  | 'instagram';

export const REQUIRE_SOCIAL_CHANNEL_KEY = 'requireSocialChannel';

/**
 * Decorator to require a specific social channel to be connected.
 * Use with SocialChannelGuard.
 *
 * @example
 * ```typescript
 * @Post('publish')
 * @UseGuards(SocialChannelGuard)
 * @RequireSocialChannel('linkedin')
 * async publishPost() { ... }
 * ```
 */
export const RequireSocialChannel = (platform: SocialPlatform) =>
  SetMetadata(REQUIRE_SOCIAL_CHANNEL_KEY, platform);
