import type {
  PlatformCapabilities,
  PlatformCapabilitiesProvider,
} from '../../platform-capabilities.interface';

// LinkedIn posting limits, sourced from the LinkedIn Marketing API (rest/posts,
// LinkedIn-Version 202604) and the Phase 0 deep-map (Recallium #1054).
//
// Sprint 1.3 scope is text + single image + single document (PDF). Multi-image
// carousels (Sprint 1.4) and video (Sprint 1.5) are intentionally reported as
// unsupported here so the composer UI greys those controls out until the
// publisher actually implements them. Lying in capabilities = a draft the
// worker can never publish, so these flags must track the publisher exactly.
export const LINKEDIN_MAX_TEXT_LENGTH = 3000;

// Characters LinkedIn's "little text" format treats as reserved. Unescaped, a
// stray '(' or '@' can truncate the post or break rendering. We escape them
// with a leading backslash. Organization @mentions of the form
// `@[Label](urn:li:organization:123)` are deliberately preserved (Sprint 1.4
// adds mention parsing); for Sprint 1.3 we escape defensively and round-trip
// the visible text 1:1 in the composer preview.
const RESERVED_CHARACTERS = /([\\<>@|{}\[\]()#*_~])/g;

export function escapeLinkedInText(text: string): string {
  return text.replace(RESERVED_CHARACTERS, '\\$1');
}

export class LinkedInCapabilities implements PlatformCapabilitiesProvider {
  private static readonly CAPABILITIES: PlatformCapabilities = Object.freeze({
    supportsImages: true,
    supportsVideo: false,
    supportsCarousel: false,
    maxTextLength: LINKEDIN_MAX_TEXT_LENGTH,
    maxImagesPerPost: 1,
    supportsScheduling: true,
    supportsThreads: false,
    supportsComments: false,
    characterEscape: escapeLinkedInText,
  });

  public getCapabilities(): PlatformCapabilities {
    return LinkedInCapabilities.CAPABILITIES;
  }
}
