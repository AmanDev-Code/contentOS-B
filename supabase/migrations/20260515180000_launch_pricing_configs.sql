-- Create launch_pricing_configs table for managing launch pricing with INR as primary currency
-- and automatic conversion to USD

CREATE TABLE IF NOT EXISTS launch_pricing_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL, -- e.g. "Launch Offer", "Summer Sale"
  is_active BOOLEAN DEFAULT false,
  base_currency TEXT DEFAULT 'INR',

  -- INR prices (base)
  standard_monthly_inr INTEGER NOT NULL,
  pro_monthly_inr INTEGER NOT NULL,
  ultimate_monthly_inr INTEGER NOT NULL,

  -- USD prices (auto-calculated, can be overridden)
  standard_monthly_usd DECIMAL(10,2),
  pro_monthly_usd DECIMAL(10,2),
  ultimate_monthly_usd DECIMAL(10,2),

  -- Yearly prices (auto-calculated with discount)
  standard_yearly_inr INTEGER,
  pro_yearly_inr INTEGER,
  ultimate_yearly_inr INTEGER,
  standard_yearly_usd DECIMAL(10,2),
  pro_yearly_usd DECIMAL(10,2),
  ultimate_yearly_usd DECIMAL(10,2),

  -- Configuration
  usd_conversion_rate DECIMAL(10,4) DEFAULT 83.5,
  yearly_discount_percent DECIMAL(5,2) DEFAULT 17.0,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id),

  -- Constraints
  CONSTRAINT positive_inr_prices CHECK (
    standard_monthly_inr > 0 AND
    pro_monthly_inr > 0 AND
    ultimate_monthly_inr > 0
  ),
  CONSTRAINT positive_conversion_rate CHECK (usd_conversion_rate > 0),
  CONSTRAINT valid_discount CHECK (yearly_discount_percent >= 0 AND yearly_discount_percent <= 100)
);

-- Index for active config lookup
CREATE INDEX IF NOT EXISTS idx_launch_pricing_active ON launch_pricing_configs(is_active) WHERE is_active = true;

-- Index for ordering by creation date
CREATE INDEX IF NOT EXISTS idx_launch_pricing_created_at ON launch_pricing_configs(created_at DESC);

-- Enable RLS
ALTER TABLE launch_pricing_configs ENABLE ROW LEVEL SECURITY;

-- Policy: Only service role can manage launch pricing configs
-- Admin operations go through backend using service_role
CREATE POLICY "Service role can manage launch pricing configs"
  ON launch_pricing_configs
  FOR ALL
  USING (auth.role() = 'service_role');

-- Policy: All authenticated users can view active configs
CREATE POLICY "All users can view active launch pricing"
  ON launch_pricing_configs
  FOR SELECT
  USING (is_active = true);

-- Trigger to auto-calculate USD and yearly prices before insert/update
CREATE OR REPLACE FUNCTION calculate_launch_pricing_prices()
RETURNS TRIGGER AS $$
BEGIN
  -- Calculate USD monthly prices
  NEW.standard_monthly_usd := ROUND((NEW.standard_monthly_inr / NEW.usd_conversion_rate)::numeric, 2);
  NEW.pro_monthly_usd := ROUND((NEW.pro_monthly_inr / NEW.usd_conversion_rate)::numeric, 2);
  NEW.ultimate_monthly_usd := ROUND((NEW.ultimate_monthly_inr / NEW.usd_conversion_rate)::numeric, 2);

  -- Calculate yearly INR prices with discount
  NEW.standard_yearly_inr := ROUND(NEW.standard_monthly_inr * 12 * (1 - NEW.yearly_discount_percent / 100));
  NEW.pro_yearly_inr := ROUND(NEW.pro_monthly_inr * 12 * (1 - NEW.yearly_discount_percent / 100));
  NEW.ultimate_yearly_inr := ROUND(NEW.ultimate_monthly_inr * 12 * (1 - NEW.yearly_discount_percent / 100));

  -- Calculate yearly USD prices
  NEW.standard_yearly_usd := ROUND((NEW.standard_yearly_inr / NEW.usd_conversion_rate)::numeric, 2);
  NEW.pro_yearly_usd := ROUND((NEW.pro_yearly_inr / NEW.usd_conversion_rate)::numeric, 2);
  NEW.ultimate_yearly_usd := ROUND((NEW.ultimate_yearly_inr / NEW.usd_conversion_rate)::numeric, 2);

  -- Update updated_at timestamp
  NEW.updated_at := NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS trigger_calculate_launch_pricing ON launch_pricing_configs;
CREATE TRIGGER trigger_calculate_launch_pricing
  BEFORE INSERT OR UPDATE ON launch_pricing_configs
  FOR EACH ROW
  EXECUTE FUNCTION calculate_launch_pricing_prices();
