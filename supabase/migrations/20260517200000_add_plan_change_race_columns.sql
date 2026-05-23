-- Add columns used by changePlanForExistingSubscription to prevent webhook race conditions.
-- last_updated_by: 'api' when the change originates from the backend API (vs 'webhook')
-- changed_at: timestamp of the last plan change via API, used to skip stale webhook events

ALTER TABLE public.user_subscriptions
  ADD COLUMN IF NOT EXISTS last_updated_by text,
  ADD COLUMN IF NOT EXISTS changed_at timestamptz;

COMMENT ON COLUMN public.user_subscriptions.last_updated_by IS 'Source of last plan update: api or webhook';
COMMENT ON COLUMN public.user_subscriptions.changed_at IS 'Timestamp of last API-driven plan change (race condition guard)';
