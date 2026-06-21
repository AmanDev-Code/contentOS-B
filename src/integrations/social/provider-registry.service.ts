import { Injectable, Logger } from '@nestjs/common';
import type { PlatformAuth } from './platform-auth.interface';
import type { PlatformPublisher } from './platform-publisher.interface';
import type { PlatformAnalytics } from './platform-analytics.interface';
import type { PlatformCapabilities } from './platform-capabilities.interface';
import type { Platform } from './types';

export interface ProviderBundle {
  readonly auth: PlatformAuth;
  readonly publisher: PlatformPublisher;
  readonly analytics?: PlatformAnalytics;
  readonly capabilities: PlatformCapabilities;
}

// Typed, in-process registry of social providers.
//
// Why a registry rather than direct DI lookups by token:
//   * Providers register themselves at module init via DI, but the publish
//     pipeline iterates over `Platform` values dynamically (e.g. when fanning
//     out a multi-channel post). A single keyed lookup is the cleanest seam.
//   * `getProvider` returns `undefined` for unknown platforms so callers must
//     handle the missing case explicitly — there is no `!`-assertion footgun
//     of the kind that bites manual array-with-`find()` registries.
//   * Re-registration is rejected: registering a `linkedin` provider twice is
//     almost always a wiring mistake, so we throw rather than silently shadow.
@Injectable()
export class ProviderRegistryService {
  private readonly logger = new Logger(ProviderRegistryService.name);
  private readonly providers = new Map<Platform, ProviderBundle>();

  public registerProvider(platform: Platform, bundle: ProviderBundle): void {
    if (this.providers.has(platform)) {
      throw new Error(
        `Provider for platform "${platform}" is already registered`,
      );
    }
    this.providers.set(platform, bundle);
    this.logger.log(`Registered social provider: ${platform}`);
  }

  public getProvider(platform: Platform): ProviderBundle | undefined {
    return this.providers.get(platform);
  }

  public hasProvider(platform: Platform): boolean {
    return this.providers.has(platform);
  }

  public listPlatforms(): readonly Platform[] {
    return Array.from(this.providers.keys());
  }
}
