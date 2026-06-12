import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../services/supabase.service';
import type { OAuthTokenSet } from './types';

// Stores OAuth secrets in Supabase Vault (encrypted at rest, libsodium
// AES-256-GCM) and keeps the `social_tokens` row pointing at the current
// vault secret ids. Plaintext tokens exist only in memory during a request;
// they are NEVER written to a regular column or logged.
//
// All vault access goes through the service-role `public.trndinn_vault_*`
// wrappers (migration 20260601000015) because supabase-js cannot reach the
// `vault` schema directly.

export interface StoredTokenRef {
  readonly socialAccountId: string;
  readonly accessVaultSecretId: string;
  readonly refreshVaultSecretId: string | null;
  readonly expiresAt: Date;
  readonly refreshExpiresAt: Date | null;
  readonly scopes: readonly string[];
}

@Injectable()
export class TokenVaultService {
  private readonly logger = new Logger(TokenVaultService.name);

  public constructor(private readonly supabase: SupabaseService) {}

  // Persist a fresh token set for a newly connected account. Creates vault
  // secrets and inserts the `social_tokens` row.
  public async storeTokens(
    socialAccountId: string,
    tokens: OAuthTokenSet,
  ): Promise<StoredTokenRef> {
    const accessId = await this.createSecret(
      tokens.accessToken,
      `social:${socialAccountId}:access`,
      'OAuth access token',
    );
    const refreshId = tokens.refreshToken
      ? await this.createSecret(
          tokens.refreshToken,
          `social:${socialAccountId}:refresh`,
          'OAuth refresh token',
        )
      : null;

    const client = this.supabase.getServiceClient();
    const { error } = await client.from('social_tokens').insert({
      social_account_id: socialAccountId,
      vault_secret_id: accessId,
      refresh_vault_secret_id: refreshId,
      scopes: tokens.scopes,
      expires_at: tokens.expiresAt.toISOString(),
      refresh_expires_at: tokens.refreshExpiresAt?.toISOString() ?? null,
      last_refreshed_at: new Date().toISOString(),
    });
    if (error) {
      // Roll back the orphaned secrets so we don't leak vault rows.
      await this.deleteSecretSafe(accessId);
      if (refreshId) await this.deleteSecretSafe(refreshId);
      throw new Error(`Failed to insert social_tokens row: ${error.message}`);
    }

    return {
      socialAccountId,
      accessVaultSecretId: accessId,
      refreshVaultSecretId: refreshId,
      expiresAt: tokens.expiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt ?? null,
      scopes: tokens.scopes,
    };
  }

  // Read the decrypted token set for an account (publish-time use).
  public async readTokens(socialAccountId: string): Promise<OAuthTokenSet | null> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client
      .from('social_tokens')
      .select('vault_secret_id, refresh_vault_secret_id, scopes, expires_at, refresh_expires_at')
      .eq('social_account_id', socialAccountId)
      .maybeSingle();
    if (error) throw new Error(`Failed to read social_tokens row: ${error.message}`);
    if (!data) return null;

    const accessToken = await this.readSecret(data.vault_secret_id as string);
    if (accessToken == null) return null;
    const refreshToken = data.refresh_vault_secret_id
      ? (await this.readSecret(data.refresh_vault_secret_id as string)) ?? undefined
      : undefined;

    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(data.expires_at as string),
      refreshExpiresAt: data.refresh_expires_at
        ? new Date(data.refresh_expires_at as string)
        : undefined,
      scopes: (data.scopes as string[]) ?? [],
    };
  }

  // Atomically swap the stored token after a refresh: create new secrets, point
  // the row at them, then delete the old secrets. If the DB update fails the new
  // secrets are cleaned up and the old ones remain valid.
  public async rotateTokens(
    socialAccountId: string,
    tokens: OAuthTokenSet,
  ): Promise<StoredTokenRef> {
    const client = this.supabase.getServiceClient();
    const { data: existing, error: readErr } = await client
      .from('social_tokens')
      .select('vault_secret_id, refresh_vault_secret_id')
      .eq('social_account_id', socialAccountId)
      .maybeSingle();
    if (readErr) throw new Error(`Failed to read social_tokens for rotation: ${readErr.message}`);
    if (!existing) {
      // Nothing to rotate — treat as first store.
      return this.storeTokens(socialAccountId, tokens);
    }

    const newAccessId = await this.createSecret(
      tokens.accessToken,
      `social:${socialAccountId}:access`,
      'OAuth access token (rotated)',
    );
    const newRefreshId = tokens.refreshToken
      ? await this.createSecret(
          tokens.refreshToken,
          `social:${socialAccountId}:refresh`,
          'OAuth refresh token (rotated)',
        )
      : null;

    const { error: updErr } = await client
      .from('social_tokens')
      .update({
        vault_secret_id: newAccessId,
        refresh_vault_secret_id: newRefreshId,
        scopes: tokens.scopes,
        expires_at: tokens.expiresAt.toISOString(),
        refresh_expires_at: tokens.refreshExpiresAt?.toISOString() ?? null,
        last_refreshed_at: new Date().toISOString(),
      })
      .eq('social_account_id', socialAccountId);

    if (updErr) {
      await this.deleteSecretSafe(newAccessId);
      if (newRefreshId) await this.deleteSecretSafe(newRefreshId);
      throw new Error(`Failed to update social_tokens during rotation: ${updErr.message}`);
    }

    // Old secrets are now unreferenced — delete them best-effort.
    await this.deleteSecretSafe(existing.vault_secret_id as string);
    if (existing.refresh_vault_secret_id) {
      await this.deleteSecretSafe(existing.refresh_vault_secret_id as string);
    }

    return {
      socialAccountId,
      accessVaultSecretId: newAccessId,
      refreshVaultSecretId: newRefreshId,
      expiresAt: tokens.expiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt ?? null,
      scopes: tokens.scopes,
    };
  }

  private async createSecret(secret: string, name: string, description: string): Promise<string> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client.rpc('trndinn_vault_create_secret', {
      p_secret: secret,
      p_name: `${name}:${Date.now()}`,
      p_description: description,
    });
    if (error || typeof data !== 'string') {
      throw new Error(`Vault create_secret failed: ${error?.message ?? 'no id returned'}`);
    }
    return data;
  }

  private async readSecret(id: string): Promise<string | null> {
    const client = this.supabase.getServiceClient();
    const { data, error } = await client.rpc('trndinn_vault_read_secret', { p_id: id });
    if (error) throw new Error(`Vault read_secret failed: ${error.message}`);
    return typeof data === 'string' ? data : null;
  }

  private async deleteSecretSafe(id: string): Promise<void> {
    try {
      const client = this.supabase.getServiceClient();
      const { error } = await client.rpc('trndinn_vault_delete_secret', { p_id: id });
      if (error) this.logger.warn(`Vault delete_secret failed for ${id}: ${error.message}`);
    } catch (err) {
      this.logger.warn(`Vault delete_secret threw for ${id}: ${String(err)}`);
    }
  }
}
