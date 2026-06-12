-- Rollback for 20260601000014 — social_accounts globally unique ownership
-- Restores the original per-user constraint. NOTE: this is looser than the
-- global constraint and allows two users to claim the same external account.

BEGIN;

ALTER TABLE public.social_accounts
    DROP CONSTRAINT IF EXISTS social_accounts_global_unique_platform_account;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.social_accounts'::regclass
          AND conname = 'social_accounts_unique_per_user'
    ) THEN
        ALTER TABLE public.social_accounts
            ADD CONSTRAINT social_accounts_unique_per_user
            UNIQUE (user_id, platform, platform_account_id);
    END IF;
END $$;

COMMIT;
