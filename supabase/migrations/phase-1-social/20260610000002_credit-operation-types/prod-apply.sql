-- PROD-APPLY: credit-operation-types (Sprint 1.9b reward-grant fix)
--
-- Standalone, self-contained, ADDITIVE-ONLY migration for PRODUCTION. Identical
-- effect to up.sql: widens the operation_type + content_type CHECK constraints
-- on public.credit_transactions so referral/reward/bonus/admin grants persist.
--
-- VERIFIED ADDITIVE on STAGING (Jun 10 2026): the live constraints were
--   operation_type_check: operation_type = ANY(ARRAY['post_now','schedule','generation','media_upload','refund'])
--   content_type_check:   content_type IS NULL OR content_type = ANY(ARRAY['text','image','carousel','custom_topic'])
-- This script DROPs each and re-CREATEs it as a strict SUPERSET (NULL still
-- allowed). It does NOT alter, drop, or modify any table data, column, policy,
-- relation, the credit_transactions ledger semantics, or the user_quota_view.
--
-- No data backfill required. Safe to apply independently of, and in any order
-- relative to, 20260610000001_credit-buckets.
--
-- The prod Supabase MCP is read-only; apply manually (SQL editor / CLI) with a
-- DDL-capable role.

BEGIN;

ALTER TABLE public.credit_transactions
    DROP CONSTRAINT IF EXISTS credit_transactions_operation_type_check;
ALTER TABLE public.credit_transactions
    ADD CONSTRAINT credit_transactions_operation_type_check
    CHECK (
        operation_type IS NULL OR operation_type IN (
            'post_now', 'schedule', 'generation', 'media_upload', 'refund',
            'referral_bonus', 'feedback_reward', 'admin_grant',
            'reward', 'bonus', 'signup_bonus', 'promo',
            'admin_adjustment'
        )
    );

ALTER TABLE public.credit_transactions
    DROP CONSTRAINT IF EXISTS credit_transactions_content_type_check;
ALTER TABLE public.credit_transactions
    ADD CONSTRAINT credit_transactions_content_type_check
    CHECK (
        content_type IS NULL OR content_type IN (
            'text', 'image', 'carousel', 'custom_topic',
            'referral', 'bonus'
        )
    );

COMMIT;
