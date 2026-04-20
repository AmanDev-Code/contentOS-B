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
import { UserRateLimitGuard } from '../guards/user-rate-limit.guard';
import { LinkedinOAuthStateService } from '../services/linkedin-oauth-state.service';
import { ImmediatePostPublishService } from '../services/immediate-post-publish.service';

/**
 * OAuth callback has no AuthGuard (browser redirect). Start flow uses
 * POST /linkedin/oauth/start with Bearer token; server stores opaque `state` in Redis.
 */
@ApiTags('linkedin')
@Controller('linkedin')
export class LinkedinController {
  constructor(
    private readonly linkedinService: LinkedinService,
    private readonly linkedinOAuthStateService: LinkedinOAuthStateService,
    private readonly immediatePostPublishService: ImmediatePostPublishService,
  ) {}

  @Get('auth')
  @ApiOperation({
    summary: 'Deprecated — use POST /linkedin/oauth/start',
    deprecated: true,
  })
  @Redirect()
  deprecatedInitiateAuth() {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return {
      url: `${frontendUrl}/settings?linkedin=error&reason=deprecated_connect_flow`,
    };
  }

  @Post('oauth/start')
  @UseGuards(AuthGuard, UserRateLimitGuard)
  @ApiOperation({
    summary:
      'Start LinkedIn OAuth (returns LinkedIn authorize URL with secure state)',
  })
  async startOAuth(@Request() req: { user?: { id: string } }) {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestException('User ID not found in request');
    }
    const state =
      await this.linkedinOAuthStateService.createStateForUser(userId);
    const url = this.linkedinService.getAuthUrl(state);
    return { url };
  }

  @Get('callback')
  @ApiOperation({ summary: 'LinkedIn OAuth callback' })
  @Redirect()
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') oauthError?: string,
    @Query('error_description') oauthErrorDescription?: string,
  ) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    if (oauthError) {
      const reason = encodeURIComponent(
        oauthErrorDescription || oauthError || 'oauth_denied',
      );
      return {
        url: `${frontendUrl}/settings?linkedin=error&reason=${reason}`,
      };
    }

    if (!code) {
      return {
        url: `${frontendUrl}/settings?linkedin=error&reason=missing_code`,
      };
    }

    let userId: string;
    try {
      userId = await this.linkedinOAuthStateService.consumeState(state);
    } catch {
      return {
        url: `${frontendUrl}/settings?linkedin=error&reason=oauth_state`,
      };
    }

    try {
      const { accessToken, refreshToken, expiresIn } =
        await this.linkedinService.exchangeCodeForToken(code);

      await this.linkedinService.saveTokens(
        userId,
        accessToken,
        refreshToken,
        expiresIn,
      );

      return {
        url: `${frontendUrl}/settings?linkedin=connected`,
      };
    } catch {
      return {
        url: `${frontendUrl}/settings?linkedin=error&reason=token_exchange`,
      };
    }
  }

  @Get('status')
  @UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
  @ApiOperation({ summary: 'Get LinkedIn connection status for current user' })
  async getStatus(@Request() req) {
    const userId = req.user?.id;
    return this.linkedinService.getConnectionStatus(userId);
  }

  @Post('publish')
  @UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
  @ApiOperation({
    summary:
      'Publish content to LinkedIn (same pipeline as POST /posts/publish)',
  })
  async publishPost(
    @Request() req: { user?: { id: string } },
    @Body() body: { contentId: string },
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestException('User ID not found in request');
    }
    return this.immediatePostPublishService.publishImmediate({
      userId,
      contentId: body.contentId,
      platform: 'linkedin',
    });
  }

  @Get('metrics')
  @UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
  @ApiOperation({ summary: 'Get LinkedIn profile metrics' })
  async getMetrics(@Request() req) {
    const userId = req.user?.id;
    return this.linkedinService.getProfileMetrics(userId);
  }

  @Get('analytics')
  @UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
  @ApiOperation({ summary: 'Get LinkedIn post analytics' })
  async getAnalytics(@Request() req, @Query('limit') limit?: string) {
    const userId = req.user?.id;
    const postLimit = limit ? parseInt(limit, 10) : 10;
    const actorType =
      req.query?.actorType === 'organization' ? 'organization' : 'member';
    const organizationUrn =
      typeof req.query?.organizationUrn === 'string'
        ? req.query.organizationUrn
        : undefined;
    return this.linkedinService.getPostAnalytics(
      userId,
      postLimit,
      actorType,
      organizationUrn,
    );
  }

  @Get('dashboard')
  @UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
  @ApiOperation({ summary: 'Get LinkedIn metrics for dashboard' })
  async getDashboardMetrics(@Request() req) {
    const userId = req.user?.id;
    return this.linkedinService.getDashboardMetrics(userId);
  }

  @Get('insights')
  @UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
  @ApiOperation({
    summary: 'Get computed LinkedIn insights from live connected data',
  })
  async getInsights(@Request() req, @Query('periodDays') periodDays?: string) {
    const userId = req.user?.id;
    const parsed = Number(periodDays);
    const actorType =
      req.query?.actorType === 'organization' ? 'organization' : 'member';
    const organizationUrn =
      typeof req.query?.organizationUrn === 'string'
        ? req.query.organizationUrn
        : undefined;
    return this.linkedinService.getInsights(
      userId,
      Number.isFinite(parsed) ? parsed : 30,
      actorType,
      organizationUrn,
    );
  }

  @Get('account-type')
  @UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
  @ApiOperation({
    summary: 'Get connected LinkedIn account type and analytics capability',
  })
  async getAccountType(@Request() req) {
    const userId = req.user?.id;
    const actorType =
      req.query?.actorType === 'organization' ? 'organization' : 'member';
    const organizationUrn =
      typeof req.query?.organizationUrn === 'string'
        ? req.query.organizationUrn
        : undefined;
    return this.linkedinService.getAccountTypeContext(
      userId,
      actorType,
      organizationUrn,
    );
  }

  @Get('posting-identities')
  @UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
  @ApiOperation({
    summary: 'Get available LinkedIn posting identities (personal + admin pages)',
  })
  async getPostingIdentities(@Request() req) {
    const userId = req.user?.id;
    return this.linkedinService.getPostingIdentities(userId);
  }

  @Get('organization')
  @UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
  @ApiOperation({ summary: 'Get LinkedIn organization analytics' })
  async getOrganizationAnalytics(
    @Request() req,
    @Query('organizationUrn') organizationUrn?: string,
  ) {
    const userId = req.user?.id;
    return this.linkedinService.getOrganizationAnalytics(userId, organizationUrn);
  }

  @Post('disconnect')
  @UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
  @ApiOperation({ summary: 'Disconnect LinkedIn account' })
  async disconnect(@Request() req) {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestException('User ID not found in request');
    }

    try {
      await this.linkedinService.disconnectLinkedIn(userId);
      return {
        success: true,
        message: 'LinkedIn account disconnected successfully',
      };
    } catch {
      throw new BadRequestException('Failed to disconnect LinkedIn account');
    }
  }
}
