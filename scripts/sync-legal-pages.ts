/**
 * Upsert all default legal pages from legal-content.ts into `legal_pages`.
 *
 * Usage:
 *   npx ts-node scripts/sync-legal-pages.ts           # insert missing slugs only
 *   npx ts-node scripts/sync-legal-pages.ts --force   # overwrite every slug
 *   npx ts-node scripts/sync-legal-pages.ts --stale   # overwrite placeholder/draft rows only
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import {
  DEFAULT_LEGAL_PAGES,
  LEGAL_PAGE_SLUGS,
  isStaleLegalDbRow,
} from '../src/config/legal-content';

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const force = process.argv.includes('--force');
const staleOnly = process.argv.includes('--stale');

async function main() {
  const { data: existing, error: listError } = await supabase
    .from('legal_pages')
    .select('*');
  if (listError) {
    console.error('Failed to list legal_pages:', listError.message);
    process.exit(1);
  }

  const bySlug = new Map((existing ?? []).map((r) => [r.slug, r]));
  let upserted = 0;
  let skipped = 0;

  for (const slug of LEGAL_PAGE_SLUGS) {
    const def = DEFAULT_LEGAL_PAGES[slug];
    const row = bySlug.get(slug);

    const shouldUpsert =
      force ||
      !row ||
      (staleOnly && isStaleLegalDbRow(row)) ||
      (!staleOnly && !force && !row);

    if (!shouldUpsert) {
      skipped += 1;
      console.log(`skip  ${slug} (existing override kept)`);
      continue;
    }

    const payload = {
      slug,
      title: def.title,
      summary: def.summary,
      body: def.body,
      seo_description: def.seoDescription,
      version: def.version,
      effective_date: def.effectiveDate,
      sort_order: def.sortOrder,
      is_published: true,
    };

    const { error } = await supabase
      .from('legal_pages')
      .upsert(payload, { onConflict: 'slug' });
    if (error) {
      console.error(`fail  ${slug}:`, error.message);
      process.exit(1);
    }

    upserted += 1;
    console.log(`sync  ${slug} (v${def.version}, effective ${def.effectiveDate})`);
  }

  console.log(`\nDone: ${upserted} upserted, ${skipped} skipped (${LEGAL_PAGE_SLUGS.length} slugs).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
