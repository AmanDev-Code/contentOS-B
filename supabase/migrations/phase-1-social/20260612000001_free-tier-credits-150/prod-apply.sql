-- Migration: 20260612000001 — free-tier-credits-150 (production apply)
--
-- PRODUCTION APPLY SCRIPT
-- Run this against production AFTER verifying in staging.
--
-- This script is identical to up.sql. It raises the free tier monthly credit
-- allotment from 50 → 150 to match the already-updated TypeScript constants.
--
-- PRE-FLIGHT CHECKLIST:
--   [ ] Verified staging migration succeeded
--   [ ] Verified SELECT public.credit_plan_allotment('free') returns 150 in staging
--   [ ] Verified no regressions in staging credit flows
--
-- POST-APPLY VERIFICATION:
--   SELECT public.credit_plan_allotment('free');  -- should return 150
--   SELECT public.credit_plan_allotment('standard');  -- should return 500
--   SELECT public.credit_plan_allotment('pro');  -- should return 2000
--   SELECT public.credit_plan_allotment('ultimate');  -- should return 10000

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Update credit_plan_allotment function: free now returns 150
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_plan_allotment(p_plan_type TEXT)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE lower(coalesce(p_plan_type, 'free'))
        WHEN 'standard' THEN 500
        WHEN 'pro'      THEN 2000
        WHEN 'ultimate' THEN 10000
        ELSE 150  -- free / unknown (was 50, now 150)
    END::numeric;
$$;

COMMENT ON FUNCTION public.credit_plan_allotment(TEXT) IS
    'Returns the monthly credit allotment for a plan type. free=150 (updated 2026-06-12), standard=500, pro=2000, ultimate=10000.';

-- ---------------------------------------------------------------------------
-- 2) Update ensure_credit_buckets: p_trial_default 50→150
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_credit_buckets(
    p_user_id UUID,
    p_trial_default NUMERIC DEFAULT 150  -- was 50, now 150
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_plan_type        TEXT := 'free';
    v_sub_start        TIMESTAMPTZ;
    v_created_at       TIMESTAMPTZ;
    v_anchor_day       INT;
    v_period_start     TIMESTAMPTZ;
    v_period_end       TIMESTAMPTZ;
    v_allotment        NUMERIC;
    v_trial_expires    TIMESTAMPTZ;
    v_trial_balance    NUMERIC;
    v_plan_row         public.credit_buckets%ROWTYPE;
BEGIN
    -- Resolve plan + start dates from the active subscription (if any).
    SELECT s.plan_type, s.subscription_start_date, s.created_at
      INTO v_plan_type, v_sub_start, v_created_at
      FROM public.user_subscriptions s
     WHERE s.user_id = p_user_id AND s.is_active = true
     ORDER BY s.created_at DESC
     LIMIT 1;

    -- Account creation falls back to auth.users.
    IF v_created_at IS NULL THEN
        SELECT u.created_at INTO v_created_at FROM auth.users u WHERE u.id = p_user_id;
    END IF;
    IF v_created_at IS NULL THEN
        v_created_at := now();
    END IF;
    v_plan_type := coalesce(v_plan_type, 'free');

    -- Plan period anchor: subscription start day for paid; account-creation day
    -- for free users / no subscription. Clamp day-of-month to 28.
    v_anchor_day := LEAST(28, GREATEST(1,
        EXTRACT(DAY FROM coalesce(
            CASE WHEN v_plan_type = 'free' THEN v_created_at ELSE v_sub_start END,
            v_created_at
        ))::int));

    v_period_start := date_trunc('month', now()) + ((v_anchor_day - 1) || ' days')::interval;
    IF v_period_start > now() THEN
        v_period_start := v_period_start - interval '1 month';
    END IF;
    v_period_end := v_period_start + interval '1 month';

    v_allotment := public.credit_plan_allotment(v_plan_type);
    v_trial_expires := v_created_at + interval '14 days';
    v_trial_balance := CASE WHEN now() < v_trial_expires THEN p_trial_default ELSE 0 END;

    -- TRIAL bucket: create if missing. Never reset/refresh once it exists.
    INSERT INTO public.credit_buckets
        (user_id, bucket_type, balance, granted, granted_at, expires_at, period_start, source)
    VALUES
        (p_user_id, 'trial', v_trial_balance, p_trial_default, v_created_at, v_trial_expires, v_created_at, 'signup_trial')
    ON CONFLICT (user_id, bucket_type) DO NOTHING;

    -- REWARD bucket: create empty if missing. Never auto-resets.
    INSERT INTO public.credit_buckets
        (user_id, bucket_type, balance, granted, source)
    VALUES
        (p_user_id, 'reward', 0, 0, 'init')
    ON CONFLICT (user_id, bucket_type) DO NOTHING;

    -- PLAN bucket: create if missing, else reset when a new period has begun.
    SELECT * INTO v_plan_row
      FROM public.credit_buckets
     WHERE user_id = p_user_id AND bucket_type = 'plan'
     FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.credit_buckets
            (user_id, bucket_type, balance, granted, granted_at, expires_at, period_start, source)
        VALUES
            (p_user_id, 'plan', v_allotment, v_allotment, now(), v_period_end, v_period_start, 'plan_grant')
        ON CONFLICT (user_id, bucket_type) DO NOTHING;
    ELSIF v_plan_row.period_start IS NULL OR v_plan_row.period_start < v_period_start THEN
        -- A new monthly period started since the last grant -> reset allotment.
        UPDATE public.credit_buckets
           SET balance = v_allotment,
               granted = v_allotment,
               granted_at = now(),
               period_start = v_period_start,
               expires_at = v_period_end,
               source = 'plan_reset'
         WHERE user_id = p_user_id AND bucket_type = 'plan';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) Update apply_credit_charge: p_trial_default 50→150
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_credit_charge(
    p_user_id UUID,
    p_content_id UUID,
    p_transaction_type TEXT,        -- 'debit' | 'refund' | 'credit'
    p_amount NUMERIC,               -- positive magnitude
    p_description TEXT,
    p_operation_type TEXT DEFAULT NULL,
    p_content_type TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb,
    p_trial_default NUMERIC DEFAULT 150  -- was 50, now 150
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_remaining   NUMERIC := abs(coalesce(p_amount, 0));
    v_take        NUMERIC;
    v_trial_bal   NUMERIC := 0;
    v_plan_bal    NUMERIC := 0;
    v_reward_bal  NUMERIC := 0;
    v_trial_ok    BOOLEAN := false;
    v_refund_bucket TEXT;
    rec           RECORD;
BEGIN
    PERFORM public.ensure_credit_buckets(p_user_id, p_trial_default);

    -- Lock this user's buckets for the duration of the charge.
    FOR rec IN
        SELECT bucket_type, balance, expires_at
          FROM public.credit_buckets
         WHERE user_id = p_user_id
         FOR UPDATE
    LOOP
        IF rec.bucket_type = 'trial' THEN
            v_trial_bal := rec.balance;
            v_trial_ok := (rec.expires_at IS NULL OR rec.expires_at > now());
        ELSIF rec.bucket_type = 'plan' THEN
            v_plan_bal := rec.balance;
        ELSIF rec.bucket_type = 'reward' THEN
            v_reward_bal := rec.balance;
        END IF;
    END LOOP;

    IF p_transaction_type = 'debit' THEN
        -- 1) trial (only if not expired)
        IF v_trial_ok AND v_trial_bal > 0 AND v_remaining > 0 THEN
            v_take := LEAST(v_remaining, v_trial_bal);
            UPDATE public.credit_buckets SET balance = balance - v_take
             WHERE user_id = p_user_id AND bucket_type = 'trial';
            INSERT INTO public.credit_transactions
                (user_id, content_id, transaction_type, amount, description, operation_type, content_type, bucket_type, metadata)
            VALUES (p_user_id, p_content_id, 'debit', v_take, p_description, p_operation_type, p_content_type, 'trial',
                    p_metadata || jsonb_build_object('bucket_type', 'trial'));
            v_remaining := v_remaining - v_take;
        END IF;

        -- 2) plan
        IF v_plan_bal > 0 AND v_remaining > 0 THEN
            v_take := LEAST(v_remaining, v_plan_bal);
            UPDATE public.credit_buckets SET balance = balance - v_take
             WHERE user_id = p_user_id AND bucket_type = 'plan';
            INSERT INTO public.credit_transactions
                (user_id, content_id, transaction_type, amount, description, operation_type, content_type, bucket_type, metadata)
            VALUES (p_user_id, p_content_id, 'debit', v_take, p_description, p_operation_type, p_content_type, 'plan',
                    p_metadata || jsonb_build_object('bucket_type', 'plan'));
            v_remaining := v_remaining - v_take;
        END IF;

        -- 3) reward (never-expiring, last)
        IF v_reward_bal > 0 AND v_remaining > 0 THEN
            v_take := LEAST(v_remaining, v_reward_bal);
            UPDATE public.credit_buckets SET balance = balance - v_take
             WHERE user_id = p_user_id AND bucket_type = 'reward';
            INSERT INTO public.credit_transactions
                (user_id, content_id, transaction_type, amount, description, operation_type, content_type, bucket_type, metadata)
            VALUES (p_user_id, p_content_id, 'debit', v_take, p_description, p_operation_type, p_content_type, 'reward',
                    p_metadata || jsonb_build_object('bucket_type', 'reward'));
            v_remaining := v_remaining - v_take;
        END IF;

        -- Safety net: if buckets could not cover the full amount (the caller is
        -- expected to pre-check), record the remainder against plan (allowed to
        -- go negative) so the audit ledger still sums to the charged amount and
        -- user_quota_view stays exactly consistent.
        IF v_remaining > 0 THEN
            UPDATE public.credit_buckets SET balance = balance - v_remaining
             WHERE user_id = p_user_id AND bucket_type = 'plan';
            INSERT INTO public.credit_transactions
                (user_id, content_id, transaction_type, amount, description, operation_type, content_type, bucket_type, metadata)
            VALUES (p_user_id, p_content_id, 'debit', v_remaining, p_description, p_operation_type, p_content_type, 'plan',
                    p_metadata || jsonb_build_object('bucket_type', 'plan', 'overdraw', true));
            v_remaining := 0;
        END IF;

    ELSIF p_transaction_type IN ('refund', 'credit') THEN
        -- Refunds go back to the bucket charged when known (metadata.refund_bucket),
        -- otherwise to plan by default (conservative: keeps reward pristine and
        -- never resurrects an expired trial). Admin 'credit' grants go to reward.
        IF p_transaction_type = 'credit' THEN
            v_refund_bucket := 'reward';
        ELSE
            v_refund_bucket := coalesce(p_metadata->>'refund_bucket', 'plan');
            IF v_refund_bucket NOT IN ('trial', 'plan', 'reward') THEN
                v_refund_bucket := 'plan';
            END IF;
            -- Do not refund into an expired trial bucket; redirect to plan.
            IF v_refund_bucket = 'trial' AND NOT v_trial_ok THEN
                v_refund_bucket := 'plan';
            END IF;
        END IF;

        UPDATE public.credit_buckets SET balance = balance + v_remaining
         WHERE user_id = p_user_id AND bucket_type = v_refund_bucket;
        INSERT INTO public.credit_transactions
            (user_id, content_id, transaction_type, amount, description, operation_type, content_type, bucket_type, metadata)
        VALUES (p_user_id, p_content_id, p_transaction_type, v_remaining, p_description, p_operation_type, p_content_type, v_refund_bucket,
                p_metadata || jsonb_build_object('bucket_type', v_refund_bucket));
        v_remaining := 0;
    ELSE
        RAISE EXCEPTION 'apply_credit_charge: unsupported transaction_type %', p_transaction_type;
    END IF;

    -- Return the fresh balance snapshot.
    SELECT
        coalesce(SUM(balance) FILTER (WHERE bucket_type = 'trial' AND (expires_at IS NULL OR expires_at > now())), 0),
        coalesce(SUM(balance) FILTER (WHERE bucket_type = 'plan'), 0),
        coalesce(SUM(balance) FILTER (WHERE bucket_type = 'reward'), 0)
      INTO v_trial_bal, v_plan_bal, v_reward_bal
      FROM public.credit_buckets
     WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'trial', v_trial_bal,
        'plan', v_plan_bal,
        'reward', v_reward_bal,
        'total', v_trial_bal + v_plan_bal + v_reward_bal
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) Update backfill_credit_buckets: p_trial_default 50→150
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backfill_credit_buckets(p_trial_default NUMERIC DEFAULT 150)
RETURNS TABLE(seeded_users BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count BIGINT := 0;
    r RECORD;
    v_created_at    TIMESTAMPTZ;
    v_sub_start     TIMESTAMPTZ;
    v_anchor_day    INT;
    v_period_start  TIMESTAMPTZ;
    v_period_end    TIMESTAMPTZ;
    v_remaining     NUMERIC;
    v_trial_expires TIMESTAMPTZ;
    v_trial_seed    NUMERIC;
    v_plan_seed     NUMERIC;
    v_in_trial      BOOLEAN;
BEGIN
    FOR r IN
        SELECT s.user_id, s.plan_type, s.subscription_start_date, s.created_at,
               coalesce(q.remaining_credits, s.credits_limit) AS remaining_credits
          FROM public.user_subscriptions s
          LEFT JOIN public.user_quota_view q ON q.user_id = s.user_id
         WHERE s.is_active = true
           AND NOT EXISTS (
               SELECT 1 FROM public.credit_buckets cb WHERE cb.user_id = s.user_id
           )
    LOOP
        v_created_at := coalesce(r.created_at, now());
        v_sub_start := r.subscription_start_date;
        v_remaining := GREATEST(0, coalesce(r.remaining_credits, 0));

        v_anchor_day := LEAST(28, GREATEST(1,
            EXTRACT(DAY FROM coalesce(
                CASE WHEN coalesce(r.plan_type, 'free') = 'free' THEN v_created_at ELSE v_sub_start END,
                v_created_at))::int));
        v_period_start := date_trunc('month', now()) + ((v_anchor_day - 1) || ' days')::interval;
        IF v_period_start > now() THEN
            v_period_start := v_period_start - interval '1 month';
        END IF;
        v_period_end := v_period_start + interval '1 month';

        v_trial_expires := v_created_at + interval '14 days';
        v_in_trial := (now() < v_trial_expires) AND (coalesce(r.plan_type, 'free') = 'free');

        IF v_in_trial THEN
            v_trial_seed := LEAST(v_remaining, p_trial_default);
        ELSE
            v_trial_seed := 0;
        END IF;
        v_plan_seed := GREATEST(0, v_remaining - v_trial_seed);

        INSERT INTO public.credit_buckets
            (user_id, bucket_type, balance, granted, granted_at, expires_at, period_start, source)
        VALUES
            (r.user_id, 'trial', v_trial_seed, p_trial_default, v_created_at, v_trial_expires, v_created_at, 'backfill_trial'),
            (r.user_id, 'plan', v_plan_seed, public.credit_plan_allotment(r.plan_type), now(), v_period_end, v_period_start, 'backfill_plan'),
            (r.user_id, 'reward', 0, 0, now(), NULL, NULL, 'backfill_reward')
        ON CONFLICT (user_id, bucket_type) DO NOTHING;

        v_count := v_count + 1;
    END LOOP;

    seeded_users := v_count;
    RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) Sync subscription_plans catalog row (legacy credits_limit column)
-- ---------------------------------------------------------------------------
UPDATE public.subscription_plans
   SET credits_limit = 150,
       updated_at = now()
 WHERE plan_type = 'free';

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-APPLY VERIFICATION QUERIES (run manually after commit)
-- ---------------------------------------------------------------------------
-- SELECT public.credit_plan_allotment('free');       -- Expected: 150
-- SELECT public.credit_plan_allotment('standard');   -- Expected: 500
-- SELECT public.credit_plan_allotment('pro');        -- Expected: 2000
-- SELECT public.credit_plan_allotment('ultimate');   -- Expected: 10000
