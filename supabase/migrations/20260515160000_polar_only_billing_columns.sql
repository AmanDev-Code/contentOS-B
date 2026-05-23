-- Polar-only billing: backfill Polar / neutral columns from legacy Paddle-prefixed columns, then drop Paddle columns.

ALTER TABLE public.user_subscriptions
  ADD COLUMN IF NOT EXISTS polar_subscription_id text,
  ADD COLUMN IF NOT EXISTS polar_customer_id text;

DO $mig$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_subscriptions' AND column_name = 'paddle_subscription_id'
  ) THEN
    EXECUTE $q$
      UPDATE public.user_subscriptions SET
        polar_subscription_id = COALESCE(polar_subscription_id, paddle_subscription_id),
        polar_customer_id = COALESCE(polar_customer_id, paddle_customer_id)
      WHERE paddle_subscription_id IS NOT NULL OR paddle_customer_id IS NOT NULL
    $q$;
    ALTER TABLE public.user_subscriptions DROP COLUMN paddle_subscription_id;
    ALTER TABLE public.user_subscriptions DROP COLUMN paddle_customer_id;
  END IF;
END $mig$;

ALTER TABLE public.billing_invoices
  ADD COLUMN IF NOT EXISTS polar_order_id text;

DO $mig$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'billing_invoices' AND column_name = 'paddle_transaction_id'
  ) THEN
    EXECUTE $q$
      UPDATE public.billing_invoices
      SET polar_order_id = COALESCE(polar_order_id, paddle_transaction_id)
      WHERE polar_order_id IS NULL
    $q$;
    ALTER TABLE public.billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_paddle_transaction_id_key;
    ALTER TABLE public.billing_invoices DROP COLUMN paddle_transaction_id;
  END IF;
END $mig$;

CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_polar_order_id_uidx
  ON public.billing_invoices (polar_order_id)
  WHERE polar_order_id IS NOT NULL;

ALTER TABLE public.billing_payment_methods
  ADD COLUMN IF NOT EXISTS polar_customer_id text;

DO $mig$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'billing_payment_methods' AND column_name = 'paddle_customer_id'
  ) THEN
    EXECUTE $q$
      UPDATE public.billing_payment_methods
      SET polar_customer_id = COALESCE(polar_customer_id, paddle_customer_id)
      WHERE paddle_customer_id IS NOT NULL
    $q$;
    ALTER TABLE public.billing_payment_methods DROP COLUMN paddle_customer_id;
  END IF;
END $mig$;
