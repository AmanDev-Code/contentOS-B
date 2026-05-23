/**
 * Repairs user_subscriptions.polar_customer_id by looking up Polar customers
 * via external id (Supabase user UUID). Also sets Polar external_id when empty.
 *
 * Usage (from backend/):
 *   npx ts-node -r tsconfig-paths/register scripts/repair-polar-customer-ids.ts
 *   npx ts-node -r tsconfig-paths/register scripts/repair-polar-customer-ids.ts <user_id>
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import { Polar } from '@polar-sh/sdk';

config({ path: resolve(__dirname, '../.env') });

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

  let repaired = 0;
  let externalSynced = 0;
  let skipped = 0;
  let failed = 0;

  const readExternalId = (customer: {
    externalId?: string | null;
    external_id?: string | null;
  }): string =>
    String(customer.externalId || customer.external_id || '').trim();

  for (const row of rows || []) {
    const userId = row.user_id as string;
    const stored = String(row.polar_customer_id || '').trim();
    try {
      let polarId: string | undefined;
      let customer: {
        id?: string;
        externalId?: string | null;
        external_id?: string | null;
      } | null = null;

      try {
        customer = await polar.customers.getExternal({ externalId: userId });
        polarId = customer?.id;
      } catch {
        if (stored) {
          customer = await polar.customers.get({ id: stored });
          polarId = customer?.id;
        }
      }

      if (!polarId) {
        skipped += 1;
        console.log(`skip ${userId}: no Polar customer for external id or ${stored}`);
        continue;
      }

      if (!readExternalId(customer || {})) {
        try {
          await polar.customers.update({
            id: polarId,
            customerUpdate: { externalId: userId },
          });
          externalSynced += 1;
          console.log(`external_id set ${userId} on Polar customer ${polarId}`);
        } catch (extErr) {
          const message =
            extErr instanceof Error ? extErr.message : String(extErr);
          console.warn(`warn ${userId}: could not set external_id: ${message}`);
        }
      }

      if (polarId === stored) {
        skipped += 1;
        continue;
      }
      const { error: updateError } = await supabase
        .from('user_subscriptions')
        .update({
          polar_customer_id: polarId,
          stripe_customer_id: polarId,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
      if (updateError) {
        failed += 1;
        console.error(`fail ${userId}: ${updateError.message}`);
        continue;
      }
      repaired += 1;
      console.log(`repaired ${userId}: ${stored} -> ${polarId}`);
    } catch (e) {
      failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      console.error(`fail ${userId}: ${message}`);
    }
  }

  console.log(
    `Done. repaired=${repaired} external_synced=${externalSynced} skipped=${skipped} failed=${failed} total=${rows?.length ?? 0}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
