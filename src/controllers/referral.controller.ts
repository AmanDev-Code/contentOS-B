import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  Req,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { ReferralService } from '../services/referral.service';
import { ProfileRepository } from '../repositories/profile.repository';

@ApiTags('referral')
@Controller('referral')
@UseGuards(AuthGuard, PaywallGuard)
@ApiBearerAuth()
export class ReferralController {
  constructor(
    private readonly referralService: ReferralService,
    private readonly profileRepository: ProfileRepository,
  ) {}

  @Get('my-code')
  @ApiOperation({ summary: "Get or generate user's referral code" })
  async getMyCode(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    try {
      // Get user's username for code generation
      const profile = await this.profileRepository.findById(userId);
      const username = profile?.username || undefined;

      const code = await this.referralService.getOrCreateReferralCode(
        userId,
        username,
      );
      const settings = await this.referralService.getSettings();

      return {
        success: true,
        data: {
          code: code.code,
          referralLink: `${process.env.FRONTEND_URL || 'https://trndinn.com'}/auth?ref=${code.code}`,
          isActive: code.is_active,
          usageCount: code.usage_count,
          creditsPerReferral: settings.credits_per_referral,
          isProgramActive: settings.is_program_active,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get referral code',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('my-referrals')
  @ApiOperation({ summary: "List users I've referred with status" })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async getMyReferrals(
    @Req() req: any,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    try {
      const result = await this.referralService.getUserReferrals(userId, {
        limit: limit ? parseInt(limit, 10) : 20,
        offset: offset ? parseInt(offset, 10) : 0,
      });

      return {
        success: true,
        data: result.referrals,
        total: result.total,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get referrals',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get my referral stats' })
  async getMyStats(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    try {
      const stats = await this.referralService.getUserReferralStats(userId);
      const settings = await this.referralService.getSettings();

      return {
        success: true,
        data: {
          ...stats,
          creditsPerReferral: settings.credits_per_referral,
          isProgramActive: settings.is_program_active,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get stats',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('settings')
  @ApiOperation({ summary: 'Get referral program settings (public info)' })
  async getSettings() {
    try {
      const settings = await this.referralService.getSettings();

      return {
        success: true,
        data: {
          creditsPerReferral: settings.credits_per_referral,
          minActionsToComplete: settings.min_actions_to_complete,
          isProgramActive: settings.is_program_active,
          termsAndConditions: settings.terms_and_conditions,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get settings',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('banners')
  @ApiOperation({ summary: 'Get active promotional banners' })
  async getBanners() {
    try {
      const banners = await this.referralService.getActiveBanners();

      return {
        success: true,
        data: banners,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get banners',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('validate/:code')
  @ApiOperation({ summary: 'Validate a referral code (for signup)' })
  async validateCode(@Param('code') code: string) {
    if (!code || code.trim().length < 3) {
      return {
        success: true,
        data: {
          valid: false,
          message: 'Invalid referral code format',
        },
      };
    }

    try {
      const result = await this.referralService.validateReferralCode(
        code.trim(),
      );

      return {
        success: true,
        data: {
          valid: result.valid,
          referrer: result.referrer
            ? {
                name:
                  result.referrer.full_name ||
                  result.referrer.username ||
                  'A Trndinn user',
              }
            : undefined,
          message: result.message,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to validate code',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

/**
 * Public referral controller for unauthenticated endpoints
 */
@ApiTags('referral-public')
@Controller('public/referral')
export class PublicReferralController {
  constructor(private readonly referralService: ReferralService) {}

  @Post('validate/:code')
  @ApiOperation({ summary: 'Validate a referral code (public, for signup)' })
  async validateCode(@Param('code') code: string) {
    if (!code || code.trim().length < 3) {
      return {
        success: true,
        data: {
          valid: false,
          message: 'Invalid referral code format',
        },
      };
    }

    try {
      const result = await this.referralService.validateReferralCode(
        code.trim(),
      );

      return {
        success: true,
        data: {
          valid: result.valid,
          referrer: result.referrer
            ? {
                name:
                  result.referrer.full_name ||
                  result.referrer.username ||
                  'A Trndinn user',
              }
            : undefined,
          message: result.message,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to validate code',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('settings')
  @ApiOperation({ summary: 'Get referral program public settings' })
  async getSettings() {
    try {
      const settings = await this.referralService.getSettings();

      return {
        success: true,
        data: {
          isProgramActive: settings.is_program_active,
          creditsPerReferral: settings.credits_per_referral,
          termsAndConditions: settings.terms_and_conditions,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get settings',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
