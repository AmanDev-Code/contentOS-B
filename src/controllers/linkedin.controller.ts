import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Request,
  Redirect,
  UseGuards,
  Optional,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { LinkedinService } from '../services/linkedin.service';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { UserRateLimitGuard } from '../guards/user-rate-limit.guard';
import { LinkedinOAuthStateService } from '../services/linkedin-oauth-state.service';
import { ImmediatePostPublishService } from '../services/immediate-post-publish.service';
import { CacheService } from '../services/cache.service';
import { SocialConnectionBridgeService } from '../integrations/social/social-connection-bridge.service';
import {
  LinkedInAuthService,
  type LinkedInOrgPage,
} from '../integrations/social/providers/linkedin/linkedin-auth.service';
import { SocialAccountAlreadyConnectedError } from '../integrations/social/types';
import { TokenVaultService } from '../integrations/social/token-vault.service';
import { buildFrontendOAuthRedirect } from '../common/utils/sanitize-return-to';

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
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
    @Optional()
    private readonly socialBridge?: SocialConnectionBridgeService,
    @Optional()
    private readonly linkedInAuthV2?: LinkedInAuthService,
    @Optional()
    private readonly tokenVault?: TokenVaultService,
  ) {}

  private readonly logger = new Logger(LinkedinController.name);

  private oauthRedirect(
    frontendUrl: string,
    returnTo: unknown,
    query: Record<string, string>,
  ): { url: string } {
    return {
      url: buildFrontendOAuthRedirect(frontendUrl, returnTo, query),
    };
  }

  private isSocialV2Enabled(): boolean {
    return (
      (this.configService.get<string>('FEATURE_SOCIAL_PROVIDER_V2') ??
        process.env.FEATURE_SOCIAL_PROVIDER_V2) === 'true'
    );
  }

  @Get('auth')
  @ApiOperation({
    summary: 'Deprecated — use POST /linkedin/oauth/start',
    deprecated: true,
  })
  @Redirect()
  deprecatedInitiateAuth() {
    const frontendUrl = this.configService.get<string>('frontendUrl');
    if (!frontendUrl) {
      throw new HttpException(
        'FRONTEND_URL env var is not set',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return {
      url: `${frontendUrl}/settings?linkedin=error&reason=deprecated_connect_flow`,
    };
  }

  @Post('oauth/start')
  @UseGuards(AuthGuard, UserRateLimitGuard)
  @ApiOperation({
    summary:
      'Start LinkedIn OAuth with unified scopes (personal + org pages in single flow)',
  })
  async startOAuth(
    @Request() req: { user?: { id: string } },
    @Body() body?: { returnTo?: string },
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestException('User ID not found in request');
    }
    const metadata: Record<string, unknown> = {};
    if (body?.returnTo) {
      metadata.returnTo = body.returnTo;
    }
    const state = await this.linkedinOAuthStateService.createStateForUser(
      userId,
      Object.keys(metadata).length > 0 ? metadata : undefined,
    );
    // Use unified scopes: requests ALL permissions in a single OAuth flow.
    // After callback, frontend auto-shows page picker if user admins any org pages.
    const url = await this.buildOAuthAuthorizeUrl(
      state,
      this.linkedInAuthV2?.getUnifiedScopes(),
    );
    return { url };
  }

  @Post('oauth/start-pages')
  @UseGuards(AuthGuard, UserRateLimitGuard)
  @ApiOperation({
    summary:
      'DEPRECATED: Use POST /oauth/start instead. Unified flow now requests all scopes.',
    deprecated: true,
  })
  async startOAuthForPages(
    @Request() req: { user?: { id: string } },
    @Body() body?: { returnTo?: string },
  ) {
    // Redirect to unified flow — same scopes, same behavior.
    // Kept for backward compatibility with any in-flight frontend versions.
    return this.startOAuth(req, body);
  }

  private async buildOAuthAuthorizeUrl(
    state: string,
    scopes?: readonly string[],
  ): Promise<string> {
    if (this.linkedInAuthV2 && scopes && scopes.length > 0) {
      const { url } = await this.linkedInAuthV2.getAuthorizationUrl(
        state,
        scopes,
      );
      return url;
    }
    return this.linkedinService.getAuthUrl(state);
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
    const frontendUrl = this.configService.get<string>('frontendUrl');
    if (!frontendUrl) {
      return {
        url: '/settings?linkedin=error&reason=server_misconfigured',
      };
    }

    if (oauthError) {
      const reason = oauthErrorDescription || oauthError || 'oauth_denied';
      return this.oauthRedirect(frontendUrl, '/settings', {
        linkedin: 'error',
        reason,
      });
    }

    if (!code) {
      return this.oauthRedirect(frontendUrl, '/settings', {
        linkedin: 'error',
        reason: 'missing_code',
      });
    }

    let userId: string;
    let stateMetadata: Record<string, unknown> | undefined;
    let returnTo: unknown = '/settings';
    try {
      const stateResult =
        await this.linkedinOAuthStateService.consumeState(state);
      if (typeof stateResult === 'string') {
        userId = stateResult;
      } else {
        userId = stateResult.userId;
        stateMetadata = stateResult.metadata;
        returnTo = stateMetadata?.returnTo ?? '/settings';
      }
    } catch {
      return this.oauthRedirect(frontendUrl, '/settings', {
        linkedin: 'error',
        reason: 'oauth_state',
      });
    }

    let accessToken: string;
    let refreshToken: string;
    let expiresIn: number;
    try {
      ({ accessToken, refreshToken, expiresIn } =
        await this.linkedinService.exchangeCodeForToken(code));
    } catch (tokenErr) {
      this.logger.error(
        `[handleCallback] token exchange failed for user ${userId}: ${String(tokenErr instanceof Error ? tokenErr.message : tokenErr)}`,
      );
      return this.oauthRedirect(frontendUrl, returnTo, {
        linkedin: 'error',
        reason: 'token_exchange',
      });
    }

    let bridgeIdentity: {
      memberId: string;
      displayName?: string;
      avatarUrl?: string;
    } | null = null;
    if (this.isSocialV2Enabled() && this.socialBridge && this.linkedInAuthV2) {
      const authV2 = this.linkedInAuthV2;
      try {
        bridgeIdentity = await authV2.fetchUserIdentity(accessToken);
        await this.socialBridge.assertLinkedInNotOwnedByOther(
          userId,
          bridgeIdentity.memberId,
        );
      } catch (preflightErr) {
        if (preflightErr instanceof SocialAccountAlreadyConnectedError) {
          this.logger.warn(
            `[handleCallback] account_in_use: LinkedIn member already owned by a different user (userId=${userId})`,
          );
          return this.oauthRedirect(frontendUrl, returnTo, {
            linkedin: 'error',
            reason: 'account_in_use',
          });
        }
        this.logger.warn(
          `[handleCallback] V2 pre-flight failed (non-fatal), falling back to legacy only: ${String(preflightErr instanceof Error ? preflightErr.message : preflightErr)}`,
        );
        bridgeIdentity = null;
      }
    }

    try {
      await this.linkedinService.saveTokens(
        userId,
        accessToken,
        refreshToken,
        expiresIn,
      );
    } catch (saveErr) {
      this.logger.error(
        `[handleCallback] saveTokens failed for user ${userId}: ${String(saveErr instanceof Error ? saveErr.message : saveErr)}`,
      );
      return this.oauthRedirect(frontendUrl, returnTo, {
        linkedin: 'error',
        reason: 'token_exchange',
      });
    }

    if (bridgeIdentity && this.socialBridge && this.linkedInAuthV2) {
      const authV2Write = this.linkedInAuthV2;
      try {
        await this.socialBridge.connectLinkedIn({
          userId,
          memberId: bridgeIdentity.memberId,
          displayName: bridgeIdentity.displayName,
          avatarUrl: bridgeIdentity.avatarUrl,
          tokens: {
            accessToken,
            refreshToken: refreshToken || undefined,
            expiresAt: new Date(Date.now() + expiresIn * 1000),
            scopes: authV2Write.getRequestedScopes(),
          },
        });
      } catch (bridgeWriteErr) {
        this.logger.warn(
          `[handleCallback] V2 bridge write failed (non-fatal, legacy already saved): ${String(bridgeWriteErr instanceof Error ? bridgeWriteErr.message : bridgeWriteErr)}`,
        );
      }
    }

    // Unified flow: always check if user has org pages they can connect.
    // If so, signal frontend to auto-open the page picker.
    let hasOrgPages = false;
    if (this.linkedInAuthV2) {
      try {
        const orgPages =
          await this.linkedInAuthV2.fetchAdminOrgPages(accessToken);
        hasOrgPages = orgPages.length > 0;
      } catch (orgErr) {
        this.logger.warn(
          `[handleCallback] fetchAdminOrgPages failed (non-fatal): ${String(orgErr instanceof Error ? orgErr.message : orgErr)}`,
        );
      }
    }

    // Legacy: handle old 'connect-pages' flow for backward compatibility
    const isPageFlow = stateMetadata?.flow === 'connect-pages';
    if (isPageFlow) {
      return this.oauthRedirect(frontendUrl, returnTo, {
        linkedin: 'connected',
        flow: 'connect-pages',
      });
    }

    // Unified flow: include has_org_pages signal so frontend can auto-open picker
    return this.oauthRedirect(frontendUrl, returnTo, {
      linkedin: 'connected',
      ...(hasOrgPages && { has_org_pages: 'true' }),
    });
  }

  @Get('org-pages')
  @UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
  @ApiOperation({
    summary: 'Discover LinkedIn organization pages the user admins',
  })
  async getOrgPages(@Request() req: { user?: { id: string } }) {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestException('User ID not found in request');
    }

    const profile = await this.linkedinService.getConnectionStatus(userId);
    if (!profile.connected) {
      throw new BadRequestException('LinkedIn not connected');
    }

    // Fetch ALL available org pages directly from LinkedIn API.
    // This endpoint is for PagePickerModal which needs to show all pages
    // the user can connect, not just already-connected ones.
    let orgPages: Array<{
      organizationUrn: string;
      organizationId: string;
      name: string;
      logoUrl?: string;
      vanityName?: string;
    }> = [];

    if (this.linkedInAuthV2) {
      try {
        const accessToken = profile.accessToken;
        if (accessToken) {
          orgPages = await this.linkedInAuthV2.fetchAdminOrgPages(accessToken);
        }
      } catch (error) {
        this.logger.warn(`[getOrgPages] fetchAdminOrgPages failed: ${error}`);
      }
    }

    // Mark which pages are already connected in social_accounts
    const connectedIds = new Set<string>();
    if (this.socialBridge) {
      try {
        const accounts =
          await this.socialBridge.getConnectedLinkedInAccounts(userId);
        for (const acct of accounts) {
          if (acct.accountType === 'organization') {
            connectedIds.add(acct.platformAccountId);
          }
        }
      } catch {
        // best effort
      }
    }

    return {
      pages: orgPages.map((p) => ({
        ...p,
        connected: connectedIds.has(p.organizationId),
      })),
    };
  }

  @Post('connect-pages')
  @UseGuards(AuthGuard, UserRateLimitGuard, PaywallGuard)
  @ApiOperation({
    summary: 'Connect selected LinkedIn Company Pages as organization accounts',
  })
  async connectPages(
    @Request() req: { user?: { id: string } },
    @Body()
    body: {
      pages: Array<{
        organizationUrn: string;
        organizationId: string;
        name: string;
        logoUrl?: string;
        vanityName?: string;
      }>;
    },
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestException('User ID not found in request');
    }
    if (!body.pages || body.pages.length === 0) {
      throw new BadRequestException('At least one page must be selected');
    }
    if (body.pages.length > 10) {
      throw new BadRequestException(
        'Cannot connect more than 10 pages at once',
      );
    }
    if (!this.socialBridge || !this.linkedInAuthV2) {
      throw new HttpException(
        'Social provider V2 not enabled',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const profile = await this.linkedinService.getConnectionStatus(userId);
    if (!profile.connected) {
      throw new BadRequestException(
        'LinkedIn not connected. Connect your personal account first.',
      );
    }

    const personalAccount =
      await this.socialBridge.getConnectedLinkedIn(userId);
    let tokens: import('../integrations/social/types').OAuthTokenSet | null =
      null;
    if (personalAccount && this.tokenVault) {
      tokens = await this.tokenVault.readTokens(personalAccount.id);
    }

    if (!tokens) {
      throw new BadRequestException(
        'No valid LinkedIn tokens found. Please reconnect your LinkedIn account.',
      );
    }

    const results: Array<{
      organizationId: string;
      status: string;
      error?: string;
    }> = [];

    for (const page of body.pages) {
      try {
        await this.socialBridge.connectLinkedInOrganization({
          userId,
          organizationId: page.organizationId,
          organizationUrn: page.organizationUrn,
          tokens,
          displayName: page.name,
          avatarUrl: page.logoUrl,
          vanityName: page.vanityName,
          parentPersonalAccountId: personalAccount?.id,
        });
        results.push({
          organizationId: page.organizationId,
          status: 'connected',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[connectPages] Failed to connect org ${page.organizationId}: ${message}`,
        );
        results.push({
          organizationId: page.organizationId,
          status: 'error',
          error: message,
        });
      }
    }

    return { results };
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

    // Cache dashboard metrics for 60 seconds to avoid hammering LinkedIn API
    const cacheKey = `linkedin:dashboard:${userId}`;
    const cached = await this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await this.linkedinService.getDashboardMetrics(userId);
    await this.cacheService.set(cacheKey, result, 60);
    return result;
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
    summary:
      'Get available LinkedIn posting identities (personal + admin pages)',
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
    return this.linkedinService.getOrganizationAnalytics(
      userId,
      organizationUrn,
    );
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

      // Sprint 1.4 bridge: best-effort removal from the new model too so the
      // global-unique slot is freed for re-connection by any user.
      if (this.socialBridge) {
        try {
          await this.socialBridge.disconnectLinkedIn(userId);
        } catch {
          // Legacy disconnect already succeeded; new-model cleanup is best-effort.
        }
      }

      return {
        success: true,
        message: 'LinkedIn account disconnected successfully',
      };
    } catch {
      throw new BadRequestException('Failed to disconnect LinkedIn account');
    }
  }
}
