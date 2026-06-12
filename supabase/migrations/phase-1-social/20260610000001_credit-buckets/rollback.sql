-- ROLLBACK: credit-buckets (Sprint 1.9b multi-bucket credit model)
--
-- Drops only the objects introduced by this migration. The legacy
-- credit_transactions ledger + user_quota_view are untouched (the bucket_type
-- column is additive; dropping it is optional and safe since it is nullable).
--
-- WARNING: dropping credit_buckets discards bucket balances. Only run if you
-- intend to fully revert to the legacy single-balance model.

BEGIN;

DROP VIEW IF EXISTS public.user_credit_balance_view;
DROP FUNCTION IF EXISTS public.apply_credit_charge(UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, JSONB, NUMERIC);
DROP FUNCTION IF EXISTS public.ensure_credit_buckets(UUID, NUMERIC);
DROP FUNCTION IF EXISTS public.backfill_credit_buckets(NUMERIC);
DROP FUNCTION IF EXISTS public.credit_plan_allotment(TEXT);

DROP TRIGGER IF EXISTS trg_credit_buckets_touch_updated_at ON public.credit_buckets;
DROP TABLE IF EXISTS public.credit_buckets;

ALTER TABLE public.credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_bucket_type_check;
ALTER TABLE public.credit_transactions DROP COLUMN IF EXISTS bucket_type;

COMMIT;
