import {
  Controller,
  Get,
  Patch,
  Body,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { OptionalAuthGuard } from '../guards/optional-auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { GetUser } from '../decorators/get-user.decorator';
import { ProfileRepository } from '../repositories/profile.repository';

@Controller('profile')
export class ProfileController {
  constructor(private readonly profileRepository: ProfileRepository) {}

  /**
   * Check if a username is available (unique). Public for signup; when authenticated, excludes current user.
   */
  @Get('check-username')
  @UseGuards(OptionalAuthGuard)
  async checkUsername(
    @Query('username') username: string,
    @GetUser() user?: { id: string },
  ) {
    if (!username || typeof username !== 'string') {
      return { available: false, error: 'Username is required' };
    }

    const trimmed = username.trim().toLowerCase();
    if (trimmed.length < 2) {
      return {
        available: false,
        error: 'Username must be at least 2 characters',
      };
    }
    if (!/^[a-z0-9_-]+$/.test(trimmed)) {
      return {
        available: false,
        error:
          'Username can only contain letters, numbers, underscores, and hyphens',
      };
    }

    const excludeUserId = user?.id;
    const taken = await this.profileRepository.isUsernameTaken(
      trimmed,
      excludeUserId,
    );
    return { available: !taken };
  }

  /**
   * Update profile (username, full_name, avatar_url, blog author defaults)
   */
  @Patch()
  @UseGuards(AuthGuard, PaywallGuard)
  async updateProfile(
    @Body()
    body: {
      username?: string;
      full_name?: string | null;
      avatar_url?: string | null;
      author_bio?: string | null;
      author_role?: string | null;
      author_avatar_url?: string | null;
      author_linkedin_url?: string | null;
    },
    @GetUser() user: { id: string },
  ) {
    const updates: {
      username?: string;
      full_name?: string | null;
      avatar_url?: string | null;
      author_bio?: string | null;
      author_role?: string | null;
      author_avatar_url?: string | null;
      author_linkedin_url?: string | null;
    } = {};

    if (body.username !== undefined) {
      const trimmed = body.username.trim().toLowerCase();
      if (trimmed.length < 2) {
        throw new BadRequestException('Username must be at least 2 characters');
      }
      if (!/^[a-z0-9_-]+$/.test(trimmed)) {
        throw new BadRequestException(
          'Username can only contain letters, numbers, underscores, and hyphens',
        );
      }
      const taken = await this.profileRepository.isUsernameTaken(
        trimmed,
        user.id,
      );
      if (taken) {
        throw new BadRequestException('Username is already taken');
      }
      updates.username = trimmed;
    }

    if (body.full_name !== undefined) {
      if (body.full_name === null || body.full_name === '') {
        updates.full_name = null;
      } else {
        updates.full_name = String(body.full_name).trim() || null;
      }
    }

    if (body.avatar_url !== undefined) {
      updates.avatar_url = body.avatar_url?.trim() || null;
    }

    if (body.author_bio !== undefined) {
      updates.author_bio = body.author_bio?.trim() || null;
    }
    if (body.author_role !== undefined) {
      updates.author_role = body.author_role?.trim() || null;
    }
    if (body.author_avatar_url !== undefined) {
      updates.author_avatar_url = body.author_avatar_url?.trim() || null;
    }
    if (body.author_linkedin_url !== undefined) {
      updates.author_linkedin_url = body.author_linkedin_url?.trim() || null;
    }

    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('No valid updates provided');
    }

    const profile = await this.profileRepository.updateProfile(
      user.id,
      updates,
    );
    return { success: true, profile };
  }
}
