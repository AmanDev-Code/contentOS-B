-- ROLLBACK: contact-messages (Phase 1.5 GTM contact form)
--
-- Drops only the object introduced by this migration. The /contact page keeps
-- rendering after rollback (the form will simply fail to persist if the table is
-- gone, so only run this to fully revert the feature).
--
-- WARNING: dropping this table discards all stored contact-form submissions.

BEGIN;

DROP TABLE IF EXISTS public.contact_messages;

COMMIT;
