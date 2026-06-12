import { Module } from '@nestjs/common';
import { ProviderRegistryService } from './provider-registry.service';

// Wires the social-integrations primitives into the Nest DI graph.
//
// Concrete provider bundles (e.g. the LinkedIn provider) are intentionally NOT
// registered here yet — that lands in Sprint 1.3. This module ships the seam
// so that adding a new platform later is a one-line `providers: [...]` change
// in a feature-specific submodule that imports `SocialModule` and pulls in the
// `ProviderRegistryService`.
@Module({
  providers: [ProviderRegistryService],
  exports: [ProviderRegistryService],
})
export class SocialModule {}
