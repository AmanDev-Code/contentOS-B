-- Rollback: 20260612000001 — free-tier-credits-150
--
-- Reverts the free tier credit allotment back to 50 (original value).
-- WARNING: This will affect new plan grants; existing balances are NOT touched.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Revert credit_plan_allotment function: free returns 50
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
        ELSE 50  -- free / unknown (original value)
    END::numeric;
$$;

-- ---------------------------------------------------------------------------
-- 2) Revert ensure_credit_buckets: p_trial_default back to 50
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_credit_buckets(
    p_user_id UUID,
    p_trial_default NUMERIC DEFAULT 50  -- revert to 50
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
    SELECT s.plan_type, s.subscription_start_date, s.created_at
      INTO v_plan_type, v_sub_start, v_created_at
      FROM public.user_subscriptions s
     WHERE s.user_id = p_user_id AND s.is_active = true
     ORDER BY s.created_at DESC
     LIMIT 1;

    IF v_created_at IS NULL THEN
        SELECT u.created_at INTO v_created_at FROM auth.users u WHERE u.id = p_user_id;
    END IF;
    IF v_created_at IS NULL THEN
        v_created_at := now();
    END IF;
    v_plan_type := coalesce(v_plan_type, 'free');

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

    INSERT INTO public.credit_buckets
        (user_id, bucket_type, balance, granted, granted_at, expires_at, period_start, source)
    VALUES
        (p_user_id, 'trial', v_trial_balance, p_trial_default, v_created_at, v_trial_expires, v_created_at, 'signup_trial')
    ON CONFLICT (user_id, bucket_type) DO NOTHING;

    INSERT INTO public.credit_buckets
        (user_id, bucket_type, balance, granted, source)
    VALUES
        (p_user_id, 'reward', 0, 0, 'init')
    ON CONFLICT (user_id, bucket_type) DO NOTHING;

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
-- 3) Revert apply_credit_charge: p_trial_default back to 50
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_credit_charge(
    p_user_id UUID,
    p_content_id UUID,
    p_transaction_type TEXT,
    p_amount NUMERIC,
    p_description TEXT,
    p_operation_type TEXT DEFAULT NULL,
    p_content_type TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb,
    p_trial_default NUMERIC DEFAULT 50  -- revert to 50
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
        IF p_transaction_type = 'credit' THEN
            v_refund_bucket := 'reward';
        ELSE
            v_refund_bucket := coalesce(p_metadata->>'refund_bucket', 'plan');
            IF v_refund_bucket NOT IN ('trial', 'plan', 'reward') THEN
                v_refund_bucket := 'plan';
            END IF;
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
-- 4) Revert backfill_credit_buckets: p_trial_default back to 50
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backfill_credit_buckets(p_trial_default NUMERIC DEFAULT 50)
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

COMMIT;
