import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SocialModule } from '../../social.module';
import { ProviderRegistryService } from '../../provider-registry.service';
import { SupabaseService } from '../../../../services/supabase.service';
import { MinioService } from '../../../../services/minio.service';
import { SocialHttpClient } from '../../social-http-client';
import { TokenVaultService } from '../../token-vault.service';
import { MinioMediaByteReader } from '../../media-byte-reader';
import { SocialConnectionBridgeService } from '../../social-connection-bridge.service';
import { LinkedInPublishBridgeService } from './linkedin-publish-bridge.service';
import { LINKEDIN_ERROR_MAP } from './linkedin-error-map';
import { LinkedInAuthService } from './linkedin-auth.service';
import { LinkedInCapabilities } from './linkedin-capabilities';
import { LinkedInMediaService } from './linkedin-media.service';
import { LinkedInPublisherService } from './linkedin-publisher.service';

const DEFAULT_LINKEDIN_API_VERSION = '202604';

// Wires the LinkedIn provider bundle and registers it into the shared registry
// at module init. Adding another platform later is the same shape: a sibling
// module that imports SocialModule and registers its bundle.
@Module({
  imports: [SocialModule],
  providers: [
    SupabaseService,
    MinioService,
    TokenVaultService,
    MinioMediaByteReader,
    SocialConnectionBridgeService,
    LinkedInPublishBridgeService,
    LinkedInCapabilities,
    {
      provide: LinkedInAuthService,
      useFactory: (config: ConfigService) =>
        new LinkedInAuthService({
          clientId: config.get<string>('linkedin.clientId') ?? '',
          clientSecret: config.get<string>('linkedin.clientSecret') ?? '',
          redirectUri: config.get<string>('linkedin.redirectUri') ?? '',
        }),
      inject: [ConfigService],
    },
    {
      provide: LinkedInPublisherService,
      useFactory: (config: ConfigService, byteReader: MinioMediaByteReader) => {
        const apiVersion =
          config.get<string>('LINKEDIN_API_VERSION') ??
          DEFAULT_LINKEDIN_API_VERSION;
        const httpClient = new SocialHttpClient({
          errorMap: LINKEDIN_ERROR_MAP,
        });
        const mediaService = new LinkedInMediaService(
          httpClient,
          apiVersion,
          byteReader,
        );
        return new LinkedInPublisherService(
          httpClient,
          mediaService,
          apiVersion,
        );
      },
      inject: [ConfigService, MinioMediaByteReader],
    },
  ],
  exports: [
    LinkedInAuthService,
    LinkedInPublisherService,
    TokenVaultService,
    SocialConnectionBridgeService,
    LinkedInPublishBridgeService,
  ],
})
export class LinkedinModule implements OnModuleInit {
  private readonly logger = new Logger(LinkedinModule.name);

  public constructor(
    private readonly registry: ProviderRegistryService,
    private readonly auth: LinkedInAuthService,
    private readonly publisher: LinkedInPublisherService,
    private readonly capabilities: LinkedInCapabilities,
  ) {}

  public onModuleInit(): void {
    if (this.registry.hasProvider('linkedin')) {
      return;
    }
    this.registry.registerProvider('linkedin', {
      auth: this.auth,
      publisher: this.publisher,
      capabilities: this.capabilities.getCapabilities(),
    });
    this.logger.log(
      'LinkedIn provider registered into social provider registry.',
    );
  }
}
