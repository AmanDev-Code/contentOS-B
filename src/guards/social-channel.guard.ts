import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProfileRepository } from '../repositories/profile.repository';
import { REQUIRE_SOCIAL_CHANNEL_KEY, SocialPlatform } from '../decorators/require-social-channel.decorator';

/**
 * Guard that checks if user has connected the required social channel.
 * 
 * Usage:
 * - Apply globally with @UseGuards(SocialChannelGuard)
 * - Or use with decorator: @RequireSocialChannel('linkedin')
 * 
 * When no decorator is present, defaults to checking LinkedIn for
 * generation and posting endpoints.
 */
@Injectable()
export class SocialChannelGuard implements CanActivate {
  constructor(
    private readonly profileRepository: ProfileRepository,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<any>();
    const userId: string | undefined = request?.user?.id;

    if (!userId) {
      return true;
    }

    const requiredPlatform = this.reflector.getAllAndOverride<SocialPlatform>(
      REQUIRE_SOCIAL_CHANNEL_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPlatform) {
      return true;
    }

    const isConnected = await this.checkPlatformConnected(userId, requiredPlatform);

    if (!isConnected) {
      const platformName = this.getPlatformDisplayName(requiredPlatform);
      throw new HttpException(
        {
          error: 'social_channel_not_connected',
          message: `${platformName} account not connected`,
          platform: requiredPlatform,
        },
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }

  private async checkPlatformConnected(
    userId: string,
    platform: SocialPlatform,
  ): Promise<boolean> {
    const profile = await this.profileRepository.findById(userId);
    if (!profile) {
      return false;
    }

    switch (platform) {
      case 'linkedin':
        return !!profile.linkedin_access_token;
      // Future platforms - not yet implemented
      // case 'x':
      //   return !!profile.x_access_token;
      // case 'youtube':
      //   return !!profile.youtube_access_token;
      // case 'facebook':
      //   return !!profile.facebook_access_token;
      // case 'instagram':
      //   return !!profile.instagram_access_token;
      default:
        return false;
    }
  }

  private getPlatformDisplayName(platform: SocialPlatform): string {
    const names: Record<SocialPlatform, string> = {
      linkedin: 'LinkedIn',
      x: 'X',
      youtube: 'YouTube',
      facebook: 'Facebook',
      instagram: 'Instagram',
    };
    return names[platform] || platform;
  }
}
