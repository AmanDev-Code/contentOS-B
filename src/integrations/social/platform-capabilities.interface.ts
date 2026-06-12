// Static, declarative platform capabilities. Surfaces UI gating (disable the
// "video" toggle when `supportsVideo === false`) and pre-flight validation
// (reject a 4500-char LinkedIn draft before the worker ever starts).
//
// `characterEscape` is intentionally on capabilities rather than the publisher
// because the composer/preview UI also needs to apply the same escaping for
// what-you-see-is-what-you-post fidelity.

export interface PlatformCapabilities {
  readonly supportsImages: boolean;
  readonly supportsVideo: boolean;
  readonly supportsCarousel: boolean;
  readonly maxTextLength: number;
  readonly maxImagesPerPost: number;
  readonly supportsScheduling: boolean;
  readonly supportsThreads: boolean;
  readonly supportsComments: boolean;
  readonly characterEscape?: (text: string) => string;
}

export interface PlatformCapabilitiesProvider {
  getCapabilities(): PlatformCapabilities;
}
