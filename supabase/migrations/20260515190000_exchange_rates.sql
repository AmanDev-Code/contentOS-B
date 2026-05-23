-- Create exchange_rates table for daily currency exchange rates fetched from Forex API
-- Stores rates with INR as base currency for daily exchange calculations

CREATE TABLE IF NOT EXISTS exchange_rates (
  id TEXT PRIMARY KEY, -- Format: {base_currency}-{target_currency}-{date}
  base_currency TEXT NOT NULL,
  target_currency TEXT NOT NULL,
  rate DECIMAL(20, 10) NOT NULL,
  date TEXT NOT NULL, -- YYYY-MM-DD format
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT DEFAULT 'forex-aws.silverlining.cloud'
);

-- Create unique constraint for upsert operations
CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_rates_unique
  ON exchange_rates (base_currency, target_currency, date);

-- Index for date lookups
CREATE INDEX IF NOT EXISTS idx_exchange_rates_date ON exchange_rates(date DESC);

-- Index for base currency lookups
CREATE INDEX IF NOT EXISTS idx_exchange_rates_base ON exchange_rates(base_currency);

-- Index for target currency lookups
CREATE INDEX IF NOT EXISTS idx_exchange_rates_target ON exchange_rates(target_currency);

-- Index for fetched_at lookups (useful for finding most recent)
CREATE INDEX IF NOT EXISTS idx_exchange_rates_fetched ON exchange_rates(fetched_at DESC);

-- Enable RLS
ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can read exchange rates (public data)
CREATE POLICY "Anyone can read exchange rates"
  ON exchange_rates
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Policy: Only service role can write exchange rates (populated by cron job)
CREATE POLICY "Service role can write exchange rates"
  ON exchange_rates
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Comment for documentation
COMMENT ON TABLE exchange_rates IS 'Daily exchange rates fetched from Forex API (base=INR). Populated by daily cron job at 5 AM IST.';
