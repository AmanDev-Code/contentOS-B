-- Add missing content_status enum values required by the application code.
-- The original enum only had: draft, generating, ready, posted, failed.
-- The application now uses additional statuses for the generation pipeline.

ALTER TYPE public.content_status ADD VALUE IF NOT EXISTS 'pending';
ALTER TYPE public.content_status ADD VALUE IF NOT EXISTS 'media_generating';
ALTER TYPE public.content_status ADD VALUE IF NOT EXISTS 'media_ready';
ALTER TYPE public.content_status ADD VALUE IF NOT EXISTS 'publishing';
ALTER TYPE public.content_status ADD VALUE IF NOT EXISTS 'published';
ALTER TYPE public.content_status ADD VALUE IF NOT EXISTS 'scheduled';
ALTER TYPE public.content_status ADD VALUE IF NOT EXISTS 'cancelled';
