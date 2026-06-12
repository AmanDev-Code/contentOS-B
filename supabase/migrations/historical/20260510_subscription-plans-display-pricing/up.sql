-- Per-currency marketing display: anchor (list) + optional promo (offer).
-- Paddle checkout amounts remain env price IDs — this affects UI only.

ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS display_pricing JSONB DEFAULT NULL;

COMMENT ON COLUMN public.subscription_plans.display_pricing IS
  'Marketing display-only prices per ISO currency code, e.g. {"USD":{"symbol":"$","listMonthly":15,"listYearly":150,"offerMonthly":null,"offerYearly":null},"INR":{...}}';

INSERT INTO public.app_settings (key, value, updated_at)
VALUES (
  'pricing_display',
  '{"defaultCurrency":"USD","supportedCurrencies":["USD","INR"]}'::jsonb,
  NOW()
)
ON CONFLICT (key) DO NOTHING;
