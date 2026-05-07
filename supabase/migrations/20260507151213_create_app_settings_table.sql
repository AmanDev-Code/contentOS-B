-- Migration: Create app_settings table for global application settings
-- This table stores key-value pairs for application-wide configuration

-- Create the app_settings table
CREATE TABLE IF NOT EXISTS public.app_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Add comment for documentation
COMMENT ON TABLE public.app_settings IS 'Global application settings stored as key-value pairs';
COMMENT ON COLUMN public.app_settings.key IS 'Unique setting identifier';
COMMENT ON COLUMN public.app_settings.value IS 'Setting value stored as JSONB';
COMMENT ON COLUMN public.app_settings.updated_at IS 'Last update timestamp';
COMMENT ON COLUMN public.app_settings.updated_by IS 'User who last updated the setting';

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_app_settings_updated_at ON public.app_settings(updated_at);

-- Enable RLS
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Only service role can read/write app settings (admin operations go through backend)
CREATE POLICY "Service role can manage app settings"
    ON public.app_settings
    FOR ALL
    USING (auth.role() = 'service_role');

-- Insert default free credit limit
INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('free_credit_limit', '50', NOW())
ON CONFLICT (key) DO NOTHING;

-- Create function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_app_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update updated_at
DROP TRIGGER IF EXISTS trigger_app_settings_updated_at ON public.app_settings;
CREATE TRIGGER trigger_app_settings_updated_at
    BEFORE UPDATE ON public.app_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.update_app_settings_updated_at();
