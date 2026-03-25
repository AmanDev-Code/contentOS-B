import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Request,
  Redirect,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { LinkedinService } from '../services/linkedin.service';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';

/**
 * OAuth routes (`/auth`, `/callback`) must NOT use AuthGuard: the browser follows
 * redirects without an `Authorization: Bearer` header. Only API calls from the
 * app (fetch with token) include JWT — this was causing 401 on LinkedIn connect.
 */
@ApiTags('linkedin')
@Controller('linkedin')
export class LinkedinController {
  constructor(private linkedinService: LinkedinService) {}

  @Get('auth')
  @ApiOperation({ summary: 'Initiate LinkedIn OAuth' })
  @Redirect()
  initiateAuth(@Query('state') state: string) {
    const authUrl = this.linkedinService.getAuthUrl(state || 'default-state');
    return { url: authUrl };
  }

  @Get('callback')
  @ApiOperation({ summary: 'LinkedIn OAuth callback' })
  @Redirect()
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
  ) {
    // Use the state parameter to associate the callback with the original user
    const userId = state;

    const { accessToken, refreshToken, expiresIn } =
      await this.linkedinService.exchangeCodeForToken(code);

    await this.linkedinService.saveTokens(
      userId,
      accessToken,
      refreshToken,
      expiresIn,
    );

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    // Redirect back to frontend (Settings page) so UI updates immediately
    return {
      url: `${frontendUrl}/settings?linkedin=connected`,
    };
  }

  @Get('status')
  @UseGuards(AuthGuard, PaywallGuard)
  @ApiOperation({ summary: 'Get LinkedIn connection status for current user' })
  async getStatus(@Request() req) {
    const userId = req.user?.id; // AuthGuard sets req.user.id
    return this.linkedinService.getConnectionStatus(userId);
  }

  @Post('publish')
  @UseGuards(AuthGuard, PaywallGuard)
  @ApiOperation({ summary: 'Publish content to LinkedIn' })
  async publishPost(@Request() req, @Body() body: { contentId: string }) {
    const userId = req.user?.id; // AuthGuard sets req.user.id
    // This method needs to be updated to work with the new publishPost signature
    // For now, return a placeholder
    throw new BadRequestException(
      'This endpoint needs to be updated for the new publishing system',
    );
  }

  @Get('metrics')
  @UseGuards(AuthGuard, PaywallGuard)
  @ApiOperation({ summary: 'Get LinkedIn profile metrics' })
  async getMetrics(@Request() req) {
    const userId = req.user?.id; // AuthGuard sets req.user.id
    return this.linkedinService.getProfileMetrics(userId);
  }

  @Get('analytics')
  @UseGuards(AuthGuard, PaywallGuard)
  @ApiOperation({ summary: 'Get LinkedIn post analytics' })
  async getAnalytics(@Request() req, @Query('limit') limit?: string) {
    const userId = req.user?.id; // AuthGuard sets req.user.id
    const postLimit = limit ? parseInt(limit, 10) : 10;
    return this.linkedinService.getPostAnalytics(userId, postLimit);
  }

  @Get('dashboard')
  @UseGuards(AuthGuard, PaywallGuard)
  @ApiOperation({ summary: 'Get LinkedIn metrics for dashboard' })
  async getDashboardMetrics(@Request() req) {
    const userId = req.user?.id; // AuthGuard sets req.user.id
    return this.linkedinService.getDashboardMetrics(userId);
  }

  @Get('organization')
  @UseGuards(AuthGuard, PaywallGuard)
  @ApiOperation({ summary: 'Get LinkedIn organization analytics' })
  async getOrganizationAnalytics(@Request() req) {
    const userId = req.user?.id; // AuthGuard sets req.user.id
    return this.linkedinService.getOrganizationAnalytics(userId);
  }

  @Post('disconnect')
  @UseGuards(AuthGuard, PaywallGuard)
  @ApiOperation({ summary: 'Disconnect LinkedIn account' })
  async disconnect(@Request() req) {
    console.log('🔗 LinkedIn disconnect endpoint hit');
    console.log('Request user:', req.user);

    const userId = req.user?.id; // AuthGuard sets req.user.id
    if (!userId) {
      console.error('❌ No user ID found in request');
      throw new BadRequestException('User ID not found in request');
    }

    console.log('✅ User ID found:', userId);

    try {
      await this.linkedinService.disconnectLinkedIn(userId);
      console.log('✅ LinkedIn disconnect successful for user:', userId);
      return {
        success: true,
        message: 'LinkedIn account disconnected successfully',
      };
    } catch (error) {
      console.error('❌ LinkedIn disconnect error:', error);
      throw new BadRequestException('Failed to disconnect LinkedIn account');
    }
  }
}
