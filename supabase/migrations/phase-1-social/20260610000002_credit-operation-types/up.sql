-- Migration: 20260610000002 — credit-operation-types (Sprint 1.9b reward-grant fix)
--
-- ADDITIVE-ONLY. Widens two CHECK constraints on public.credit_transactions so
-- the new multi-bucket model's reward/bonus/admin grants can be recorded:
--   * credit_transactions_operation_type_check  — add reward-grant op types
--   * credit_transactions_content_type_check     — add reward-grant content tags
--
-- WHY: referral.service grants credits with operation_type='referral_bonus'
-- (and the feedback reward path uses operation_type='feedback_reward' +
-- content_type='bonus'). Neither value was in the original CHECK sets, so the
-- INSERT into credit_transactions (via apply_credit_charge / log_credit_transaction)
-- failed at the DB level and referral/reward grants could not be persisted.
--
-- Also adds 'admin_adjustment' so the admin credit-adjustment endpoint can
-- record bucket-aware NEGATIVE corrections (positive admin grants use
-- 'admin_grant'); both now flow through the multi-bucket charge path.
--
-- Reward credits are now a first-class bucket (never-expiring) in the Sprint
-- 1.9b model, so these grants MUST succeed.
--
-- SAFETY (additive): each new CHECK is a strict SUPERSET of the old one and
-- preserves NULL acceptance. The original constraints were of the form
-- `col = ANY(ARRAY[...])` (NULL passes a CHECK because it is not FALSE); the new
-- constraints make that explicit with `col IS NULL OR col IN (...)` and only ADD
-- allowed values. No existing row can be rejected, so this only widens what is
-- permitted — it never breaks current charging/refund paths.
--
-- Original (pre-migration) allowed sets, captured live from STAGING:
--   operation_type: post_now, schedule, generation, media_upload, refund
--   content_type:   text, image, carousel, custom_topic   (NULL also allowed)

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Widen operation_type to include reward/bonus/admin-grant operations.
-- ---------------------------------------------------------------------------
ALTER TABLE public.credit_transactions
    DROP CONSTRAINT IF EXISTS credit_transactions_operation_type_check;

ALTER TABLE public.credit_transactions
    ADD CONSTRAINT credit_transactions_operation_type_check
    CHECK (
        operation_type IS NULL OR operation_type IN (
            -- existing (preserved)
            'post_now', 'schedule', 'generation', 'media_upload', 'refund',
            -- reward / bonus / admin grants (new)
            'referral_bonus', 'feedback_reward', 'admin_grant',
            'reward', 'bonus', 'signup_bonus', 'promo',
            -- admin negative correction / deduction (bucket-aware debit) (new)
            'admin_adjustment'
        )
    );

-- ---------------------------------------------------------------------------
-- 2) Widen content_type so reward-grant rows can carry a (non-content) tag.
--    Referral grants now pass content_type = NULL (a reward grant is not
--    "content"), but the existing feedback-reward path tags rows 'bonus' and
--    older referral rows used 'referral'; both are added so every reward-grant
--    code path can persist.
-- ---------------------------------------------------------------------------
ALTER TABLE public.credit_transactions
    DROP CONSTRAINT IF EXISTS credit_transactions_content_type_check;

ALTER TABLE public.credit_transactions
    ADD CONSTRAINT credit_transactions_content_type_check
    CHECK (
        content_type IS NULL OR content_type IN (
            -- existing (preserved)
            'text', 'image', 'carousel', 'custom_topic',
            -- reward-grant tags (new)
            'referral', 'bonus'
        )
    );

COMMENT ON CONSTRAINT credit_transactions_operation_type_check ON public.credit_transactions IS
    'Sprint 1.9b: widened to allow reward/bonus/admin-grant op types (referral_bonus, feedback_reward, admin_grant, admin_adjustment, reward, bonus, signup_bonus, promo) on top of the original charge/refund op types. Additive-only (superset).';

COMMIT;
