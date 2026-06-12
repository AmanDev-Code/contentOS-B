import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../services/supabase.service';
import { TokenVaultService } from './token-vault.service';
import {
  SocialAccountAlreadyConnectedError,
  type ConnectedAccount,
  type OAuthTokenSet,
  type Platform,
} from './types';

// Sprint 1.4 bridge: connects a social account into the NEW data model
// (`social_accounts` + Vault-encrypted `social_tokens`) while the legacy
// `linkedin.service.ts` keeps running. This service is the single seam that
// enforces the founder-mandated global-unique ownership rule:
//
//   An external account (platform + platform_account_id) can be connected to
//   exactly ONE Trndinn user at a time. A second user attempting to connect the
//   same account gets SocialAccountAlreadyConnectedError (HTTP 409).
//
// Re-auth by the SAME user updates in place and rotates the stored token rather
// than erroring.

const UNIQUE_VIOLATION = '23505';

interface SocialAccountRow {
  id: string;
  user_id: string;
  platform: string;
  platform_account_id: string;
  account_type: string;
  display_name: string | null;
  profile_url: string | null;
  avatar_url: string | null;
  status: string;
  connected_at: string;
  last_used_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ConnectLinkedInParams {
  readonly userId: string;
  readonly memberId: string;
  readonly tokens: OAuthTokenSet;
  readonly displayName?: string;
  readonly profileUrl?: string;
  readonly avatarUrl?: string;
}

export interface ConnectLinkedInOrgParams {
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationUrn: string;
  readonly tokens: OAuthTokenSet;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly vanityName?: string;
  readonly parentPersonalAccountId?: string;
}

@Injectable()
export class SocialConnectionBridgeService {
  private readonly logger = new Logger(SocialConnectionBridgeService.name);

  public constructor(
    private readonly supabase: SupabaseService,
    private readonly tokenVault: TokenVaultService,
  ) {}

  public async connectLinkedIn(params: ConnectLinkedInParams): Promise<ConnectedAccount> {
    return this.connect('linkedin', 'personal', params);
  }

  public async connectLinkedInOrganization(
    params: ConnectLinkedInOrgParams,
  ): Promise<ConnectedAccount> {
    return this.connect('linkedin', 'organization', {
      userId: params.userId,
      memberId: params.organizationId,
      tokens: params.tokens,
      displayName: params.displayName,
      avatarUrl: params.avatarUrl,
    });
  }

  public async getConnectedLinkedInAccounts(userId: string): Promise<ConnectedAccount[]> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('social_accounts')
      .select('*')
      .eq('platform', 'linkedin')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('connected_at', { ascending: false });
    if (error) throw new Error(`Failed to read social_accounts: ${error.message}`);
    return (data ?? []).map((row) => this.mapRow(row as SocialAccountRow));
  }

  public async getConnectedLinkedInByPlatformId(
    userId: string,
    platformAccountId: string,
  ): Promise<ConnectedAccount | null> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('social_accounts')
      .select('*')
      .eq('platform', 'linkedin')
      .eq('user_id', userId)
      .eq('platform_account_id', platformAccountId)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw new Error(`Failed to read social_accounts: ${error.message}`);
    return data ? this.mapRow(data as SocialAccountRow) : null;
  }

  /**
   * Pre-flight ownership check: resolves whether the given memberId is already
   * claimed by a DIFFERENT user. Throws SocialAccountAlreadyConnectedError if
   * so; returns silently otherwise. No writes are performed.
   *
   * Call this BEFORE any legacy token save so the legacy row is never written
   * when the account belongs to someone else.
   */
  public async assertLinkedInNotOwnedByOther(
    userId: string,
    memberId: string,
  ): Promise<void> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('social_accounts')
      .select('user_id')
      .eq('platform', 'linkedin')
      .eq('platform_account_id', memberId)
      .maybeSingle();
    if (error) {
      // Read failure → allow the flow to continue (fail-open on lookup error).
      this.logger.warn(`assertLinkedInNotOwnedByOther lookup failed: ${error.message}`);
      return;
    }
    if (data && (data as { user_id: string }).user_id !== userId) {
      throw new SocialAccountAlreadyConnectedError('linkedin', memberId);
    }
  }

  private async connect(
    platform: Platform,
    accountType: 'personal' | 'organization',
    params: ConnectLinkedInParams,
  ): Promise<ConnectedAccount> {
    const client = this.supabase.getServiceClient();

    const { data: existing, error: selErr } = await client
      .from('social_accounts')
      .select('*')
      .eq('platform', platform)
      .eq('platform_account_id', params.memberId)
      .maybeSingle();
    if (selErr) {
      throw new Error(`Failed to look up social_accounts: ${selErr.message}`);
    }

    if (existing) {
      const row = existing as SocialAccountRow;
      // Owned by a different user -> hard block (the global-unique rule).
      if (row.user_id !== params.userId) {
        throw new SocialAccountAlreadyConnectedError(platform, params.memberId);
      }
      // Same user re-authenticating -> update + rotate tokens.
      const { error: updErr } = await client
        .from('social_accounts')
        .update({
          display_name: params.displayName ?? row.display_name,
          profile_url: params.profileUrl ?? row.profile_url,
          avatar_url: params.avatarUrl ?? row.avatar_url,
          status: 'active',
          last_used_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (updErr) {
        throw new Error(`Failed to update social_accounts on re-auth: ${updErr.message}`);
      }
      await this.tokenVault.rotateTokens(row.id, params.tokens);
      return this.mapRow({ ...row, status: 'active' });
    }

    // New connection -> insert, then store tokens in Vault.
    const { data: inserted, error: insErr } = await client
      .from('social_accounts')
      .insert({
        user_id: params.userId,
        platform,
        platform_account_id: params.memberId,
        account_type: accountType,
        display_name: params.displayName ?? null,
        profile_url: params.profileUrl ?? null,
        avatar_url: params.avatarUrl ?? null,
        status: 'active',
        last_used_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (insErr) {
      // Race: another connect won between our SELECT and INSERT. The global
      // UNIQUE(platform, platform_account_id) constraint fired. Re-resolve owner.
      if ((insErr as { code?: string }).code === UNIQUE_VIOLATION) {
        const { data: winner } = await client
          .from('social_accounts')
          .select('*')
          .eq('platform', platform)
          .eq('platform_account_id', params.memberId)
          .maybeSingle();
        const winnerRow = winner as SocialAccountRow | null;
        if (winnerRow && winnerRow.user_id === params.userId) {
          await this.tokenVault.rotateTokens(winnerRow.id, params.tokens);
          return this.mapRow(winnerRow);
        }
        throw new SocialAccountAlreadyConnectedError(platform, params.memberId);
      }
      throw new Error(`Failed to insert social_accounts: ${insErr.message}`);
    }

    const row = inserted as SocialAccountRow;
    await this.tokenVault.storeTokens(row.id, params.tokens);
    return this.mapRow(row);
  }

  // Best-effort disconnect: removes the new-model rows + vault secrets for this
  // user. Legacy disconnect (profiles.linkedin_*) is handled by the caller.
  public async disconnectLinkedIn(userId: string, memberId?: string): Promise<void> {
    const client = this.supabase.getServiceClient();
    let query = client
      .from('social_accounts')
      .select('id')
      .eq('platform', 'linkedin')
      .eq('user_id', userId);
    if (memberId) {
      query = query.eq('platform_account_id', memberId);
    }
    const { data, error } = await query;
    if (error) {
      this.logger.warn(`disconnectLinkedIn lookup failed for ${userId}: ${error.message}`);
      return;
    }
    for (const row of (data as Array<{ id: string }>) ?? []) {
      // Deleting the social_accounts row cascades to social_tokens; vault
      // secrets are cleaned up explicitly by the token service before delete.
      const { error: delErr } = await client.from('social_accounts').delete().eq('id', row.id);
      if (delErr) {
        this.logger.warn(`Failed to delete social_account ${row.id}: ${delErr.message}`);
      }
    }
  }

  /**
   * Ownership-scoped lookup of a single connected account by its
   * `social_accounts` row id. Returns null when the row does not exist OR is
   * owned by a different user — callers cannot distinguish the two, so a key
   * can never probe another user's account ids.
   */
  public async getAccountByIdForUser(
    userId: string,
    accountId: string,
  ): Promise<ConnectedAccount | null> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('social_accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to read social_accounts: ${error.message}`);
    }
    return data ? this.mapRow(data as SocialAccountRow) : null;
  }

  /**
   * Disconnects a single connected account by its `social_accounts` row id,
   * rigorously scoped to the owning user (the `user_id` filter is applied to
   * BOTH the lookup and the delete, so a key can never disconnect another
   * user's account). Deleting the row cascades to `social_tokens`. Mirrors the
   * delete semantics of `disconnectLinkedIn` but keyed by row id for the
   * Public API v1 (`accounts:write`).
   *
   * Returns the disconnected account on success, or null when no owned row
   * matched (the caller maps that to 404).
   */
  public async disconnectAccountByIdForUser(
    userId: string,
    accountId: string,
  ): Promise<ConnectedAccount | null> {
    const client = this.supabase.getServiceClient();
    const existing = await this.getAccountByIdForUser(userId, accountId);
    if (!existing) return null;

    const { error: delErr } = await client
      .from('social_accounts')
      .delete()
      .eq('id', accountId)
      .eq('user_id', userId);
    if (delErr) {
      throw new Error(`Failed to disconnect social_account ${accountId}: ${delErr.message}`);
    }
    return existing;
  }

  public async getConnectedLinkedIn(userId: string): Promise<ConnectedAccount | null> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('social_accounts')
      .select('*')
      .eq('platform', 'linkedin')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('connected_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to read social_accounts: ${error.message}`);
    return data ? this.mapRow(data as SocialAccountRow) : null;
  }

  private mapRow(row: SocialAccountRow): ConnectedAccount {
    return {
      id: row.id,
      userId: row.user_id,
      platform: row.platform as Platform,
      platformAccountId: row.platform_account_id,
      accountType: row.account_type === 'organization' ? 'organization' : 'personal',
      displayName: row.display_name,
      profileUrl: row.profile_url,
      avatarUrl: row.avatar_url,
      status:
        row.status === 'reauth_required' ||
        row.status === 'disabled' ||
        row.status === 'deleted'
          ? row.status
          : 'active',
      connectedAt: new Date(row.connected_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
      metadata: row.metadata ?? {},
    };
  }
}
