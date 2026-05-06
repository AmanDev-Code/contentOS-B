-- Allow custom-topic credit debits/refunds (Content generation v2).
-- Production error: check constraint rejected content_type = 'custom_topic'.

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_content_type_check;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_content_type_check
  CHECK (
    content_type IS NULL
    OR content_type IN ('text', 'image', 'carousel', 'custom_topic')
  );
