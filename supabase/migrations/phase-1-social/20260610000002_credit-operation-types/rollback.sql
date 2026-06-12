-- ROLLBACK: credit-operation-types (Sprint 1.9b reward-grant fix)
--
-- Restores the ORIGINAL (narrower) CHECK constraints on credit_transactions.
--
-- WARNING: this NARROWS the allowed sets. It will FAIL if any credit_transactions
-- row already uses one of the values added by up.sql (referral_bonus,
-- feedback_reward, admin_grant, admin_adjustment, reward, bonus, signup_bonus,
-- promo for operation_type; referral, bonus for content_type). In that case, either keep
-- the widened constraints (recommended — they are additive/harmless) or migrate
-- those rows first. Only run this if you intend to fully revert reward grants.

BEGIN;

ALTER TABLE public.credit_transactions
    DROP CONSTRAINT IF EXISTS credit_transactions_operation_type_check;
ALTER TABLE public.credit_transactions
    ADD CONSTRAINT credit_transactions_operation_type_check
    CHECK (
        operation_type = ANY (ARRAY[
            'post_now'::text, 'schedule'::text, 'generation'::text,
            'media_upload'::text, 'refund'::text
        ])
    );

ALTER TABLE public.credit_transactions
    DROP CONSTRAINT IF EXISTS credit_transactions_content_type_check;
ALTER TABLE public.credit_transactions
    ADD CONSTRAINT credit_transactions_content_type_check
    CHECK (
        content_type IS NULL OR content_type = ANY (ARRAY[
            'text'::text, 'image'::text, 'carousel'::text, 'custom_topic'::text
        ])
    );

COMMIT;
