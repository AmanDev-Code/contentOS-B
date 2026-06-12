-- Migration: 20260601000014 — social_accounts globally unique ownership
-- Founder directive (May 31, 2026): an external social account can only belong
-- to ONE Trndinn user at a time. If user A connects LinkedIn account
-- "urn:li:person:XYZ", user B CANNOT connect the same LinkedIn account until
-- A explicitly disconnects. This prevents double-ownership, accidental cross-
-- posting, and stolen-cookie reconnect attacks.
--
-- Implementation:
--   * Drop the existing per-user constraint `social_accounts_unique_per_user`
--     (`UNIQUE (user_id, platform, platform_account_id)`).
--   * Add a GLOBAL unique constraint on (platform, platform_account_id).
--
-- API behavior (enforced in the OAuth callback handler — Sprint 1.3):
--   * Catch the unique-violation, translate to `SocialAccountAlreadyConnectedError`,
--     return HTTP 409 with a clear, user-actionable message.
--
-- Reversibility note: the rollback re-adds the per-user constraint, which is
-- looser than the new global constraint. Any rows that violated the global
-- constraint at rollback time would already have been blocked at insert, so
-- the data should always be safe to downgrade.

BEGIN;

ALTER TABLE public.social_accounts
    DROP CONSTRAINT IF EXISTS social_accounts_unique_per_user;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.social_accounts'::regclass
          AND conname = 'social_accounts_global_unique_platform_account'
    ) THEN
        ALTER TABLE public.social_accounts
            ADD CONSTRAINT social_accounts_global_unique_platform_account
            UNIQUE (platform, platform_account_id);
    END IF;
END $$;

COMMENT ON COLUMN public.social_accounts.platform_account_id IS
    'Platform-side identifier (LinkedIn OIDC sub, or urn:li:organization:{id}). GLOBALLY UNIQUE across all Trndinn users when combined with `platform`. An external social account can only be connected to ONE Trndinn user at a time. The previous owner must disconnect before another user can connect it. Violations raise SocialAccountAlreadyConnectedError (HTTP 409) at the API boundary.';

COMMIT;
