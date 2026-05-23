/**
 * Sets Polar customer external_id (Supabase user UUID) when empty.
 *
 * Usage (from backend/):
 *   npx ts-node -r tsconfig-paths/register scripts/sync-polar-external-ids.ts
 *   npx ts-node -r tsconfig-paths/register scripts/sync-polar-external-ids.ts <user_id>
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import { Polar } from '@polar-sh/sdk';

config({ path: resolve(__dirname, '../.env') });

function readExternalId(customer: Record<string, unknown>): string {
  const ext =
    (customer.externalId as string | undefined) ||
    (customer.external_id as string | undefined) ||
    '';
  return ext.trim();
}

async function main(): Promise<void> {
  const accessToken = process.env.POLAR_ACCESS_TOKEN || '';
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const filterUserId = process.argv[2]?.trim();

  if (!accessToken || !supabaseUrl || !supabaseKey) {
    console.error(
      'Set POLAR_ACCESS_TOKEN, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY',
    );
    process.exit(1);
  }

  const mode = process.env.POLAR_MODE || 'sandbox';
  const polar = new Polar({
    accessToken,
    server: mode === 'production' ? 'production' : 'sandbox',
  });
  const supabase = createClient(supabaseUrl, supabaseKey);

  let query = supabase
    .from('user_subscriptions')
    .select('user_id, polar_customer_id')
    .not('polar_customer_id', 'is', null);

  if (filterUserId) {
    query = query.eq('user_id', filterUserId);
  }

  const { data: rows, error } = await query;
  if (error) {
    console.error(error.message);
    process.exit(1);
  }

  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows || []) {
    const userId = String(row.user_id || '').trim();
    const polarCustomerId = String(row.polar_customer_id || '').trim();
    if (!userId || !polarCustomerId) {
      skipped += 1;
      continue;
    }

    try {
      const customer = (await polar.customers.get({
        id: polarCustomerId,
      })) as Record<string, unknown>;
      const existing = readExternalId(customer);
      if (existing) {
        if (existing !== userId) {
          console.warn(
            `warn ${userId}: Polar external_id is "${existing}", expected ${userId}`,
          );
        }
        skipped += 1;
        continue;
      }

      await polar.customers.update({
        id: polarCustomerId,
        customerUpdate: { externalId: userId },
      });
      synced += 1;
      console.log(`synced ${userId} → Polar customer ${polarCustomerId}`);
    } catch (e) {
      failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      console.error(`fail ${userId}: ${message}`);
    }
  }

  console.log(
    `Done. synced=${synced} skipped=${skipped} failed=${failed} total=${rows?.length ?? 0}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
