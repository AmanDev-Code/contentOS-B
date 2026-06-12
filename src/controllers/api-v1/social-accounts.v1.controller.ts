import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../guards/api-key-auth.guard';
import { RequireApiScope } from '../../decorators/api-scope.decorator';
import { SupabaseService } from '../../services/supabase.service';
import { SocialConnectionBridgeService } from '../../integrations/social/social-connection-bridge.service';
import { TokenVaultService } from '../../integrations/social/token-vault.service';

interface ApiAuthedRequest {
  user: { id: string };
}

/**
 * Public API v1 — Social accounts. Lists the caller's connected accounts by
 * reading the `social_accounts` table directly (DB is the source of truth — it
 * does NOT call the LinkedIn API, preserving the Sprint 1.7 fix).
 *
 * Write operations (Sprint 1.8-D, `accounts:write`) reuse the existing
 * `SocialConnectionBridgeService` so the new-model disconnect logic the UI uses
 * is the single source of truth — no business logic is duplicated here.
 */
@ApiTags('public-api-v1')
@ApiBearerAuth()
@Controller('api/v1/social-accounts')
@UseGuards(ApiKeyAuthGuard)
export class SocialAccountsV1Controller {
  private readonly logger = new Logger(SocialAccountsV1Controller.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly socialBridge: SocialConnectionBridgeService,
    private readonly tokenVault: TokenVaultService,
  ) {}

  @Get()
  @RequireApiScope('accounts:read')
  @ApiOperation({ summary: 'List connected social accounts' })
  async list(@Request() req: ApiAuthedRequest) {
    try {
      const { data, error } = await this.supabase
        .getServiceClient()
        .from('social_accounts')
        .select(
          'id, platform, account_type, platform_account_id, display_name, profile_url, avatar_url, status, connected_at, last_used_at',
        )
        .eq('user_id', req.user.id)
        .eq('status', 'active')
        .order('connected_at', { ascending: false });

      if (error) {
        throw new HttpException(
          `Failed to list social accounts: ${error.message}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      const accounts = (data ?? []).map((row: Record<string, any>) => ({
        id: row.id as string,
        platform: row.platform as string,
        accountType: row.account_type as string,
        platformAccountId: row.platform_account_id as string,
        displayName: (row.display_name as string) ?? null,
        profileUrl: (row.profile_url as string) ?? null,
        avatarUrl: (row.avatar_url as string) ?? null,
        status: row.status as string,
        connectedAt: (row.connected_at as string) ?? null,
        lastUsedAt: (row.last_used_at as string) ?? null,
      }));

      return { data: accounts, total: accounts.length };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Failed to list social accounts: ${(error as Error)?.message}`,
      );
      throw new HttpException(
        'Failed to list social accounts',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Disconnect (remove) a connected social account owned by the authenticating
   * key's user. Ownership is enforced inside the bridge service (the `user_id`
   * filter is applied to both lookup and delete), so a key can never disconnect
   * another user's account. Returns 404 when the account does not exist or is
   * not owned by the caller.
   */
  @Delete(':id')
  @RequireApiScope('accounts:write')
  @ApiOperation({ summary: 'Disconnect a connected social account' })
  async disconnect(@Request() req: ApiAuthedRequest, @Param('id') id: string) {
    try {
      const removed = await this.socialBridge.disconnectAccountByIdForUser(
        req.user.id,
        id,
      );
      if (!removed) {
        throw new NotFoundException(
          'Social account not found or not owned by this key.',
        );
      }
      return {
        success: true,
        id: removed.id,
        platform: removed.platform,
        status: 'disconnected',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Failed to disconnect social account ${id}: ${(error as Error)?.message}`,
      );
      throw new HttpException(
        'Failed to disconnect social account',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Re-checks / revalidates an account's connection state. Reads the stored
   * token expiry (Vault) to report whether the connection is still usable.
   *
   * NOTE (Phase 2): actual OAuth token *rotation* against the provider is not
   * yet wired (no callable refresh-from-refresh-token service exists), so this
   * is a revalidation/no-op stub for refresh — it reports current status and
   * token expiry without minting a new access token.
   */
  @Post(':id/refresh')
  @HttpCode(HttpStatus.OK)
  @RequireApiScope('accounts:write')
  @ApiOperation({
    summary: 'Refresh / revalidate a connected account connection state',
  })
  async refresh(@Request() req: ApiAuthedRequest, @Param('id') id: string) {
    try {
      const account = await this.socialBridge.getAccountByIdForUser(
        req.user.id,
        id,
      );
      if (!account) {
        throw new NotFoundException(
          'Social account not found or not owned by this key.',
        );
      }

      let tokenExpiresAt: string | null = null;
      let tokenValid: boolean | null = null;
      try {
        const tokens = await this.tokenVault.readTokens(account.id);
        if (tokens) {
          tokenExpiresAt = tokens.expiresAt.toISOString();
          tokenValid = tokens.expiresAt.getTime() > Date.now();
        }
      } catch (e) {
        this.logger.warn(
          `Token read during refresh failed for ${account.id}: ${(e as Error)?.message}`,
        );
      }

      return {
        success: true,
        id: account.id,
        platform: account.platform,
        status: account.status,
        tokenExpiresAt,
        tokenValid,
        refreshed: false,
        note: 'Connection state revalidated. Active OAuth token rotation is a Phase 2 no-op stub.',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Failed to refresh social account ${id}: ${(error as Error)?.message}`,
      );
      throw new HttpException(
        'Failed to refresh social account',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
