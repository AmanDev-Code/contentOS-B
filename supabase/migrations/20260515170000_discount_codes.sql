-- Admin-managed discount codes synced to Polar at checkout.

CREATE TABLE IF NOT EXISTS public.discount_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  discount_type text NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  percent_off numeric CHECK (percent_off IS NULL OR (percent_off > 0 AND percent_off <= 100)),
  amount_off numeric CHECK (amount_off IS NULL OR amount_off > 0),
  currency text NOT NULL DEFAULT 'USD',
  plan_types text[] DEFAULT NULL,
  billing_cycles text[] DEFAULT NULL,
  duration text NOT NULL DEFAULT 'once' CHECK (duration IN ('once', 'forever', 'repeating')),
  duration_in_months integer,
  polar_discount_id text,
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  max_redemptions integer,
  redemption_count integer NOT NULL DEFAULT 0,
  polar_sync_status text NOT NULL DEFAULT 'pending'
    CHECK (polar_sync_status IN ('pending', 'synced', 'error', 'skipped')),
  polar_sync_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discount_codes_code_normalized CHECK (code ~ '^[A-Za-z0-9]{3,64}$'),
  CONSTRAINT discount_codes_value_check CHECK (
    (discount_type = 'percentage' AND percent_off IS NOT NULL AND amount_off IS NULL)
    OR (discount_type = 'fixed' AND amount_off IS NOT NULL AND percent_off IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS discount_codes_code_lower_uidx
  ON public.discount_codes (lower(code));

CREATE INDEX IF NOT EXISTS discount_codes_active_idx
  ON public.discount_codes (active) WHERE active = true;

CREATE INDEX IF NOT EXISTS discount_codes_polar_discount_id_idx
  ON public.discount_codes (polar_discount_id)
  WHERE polar_discount_id IS NOT NULL;

COMMENT ON TABLE public.discount_codes IS 'Promo/discount codes managed in admin and synced to Polar discounts API';
