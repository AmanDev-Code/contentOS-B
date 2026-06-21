#!/usr/bin/env node
/**
 * One-shot: READ blog_posts from production Supabase, UPSERT into staging.
 * Production: read-only via REST. Staging: write via DATABASE_URL psql.
 */
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '../.env') });

const PROD_URL = 'https://pfrhlcmkgpfiuyrfdmee.supabase.co';
const PROD_SERVICE_KEY = process.env.PROD_SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

async function fetchProductionPosts() {
  if (!PROD_SERVICE_KEY) {
    throw new Error('Set PROD_SUPABASE_SERVICE_ROLE_KEY env var for production read');
  }
  const res = await fetch(`${PROD_URL}/rest/v1/blog_posts?select=*&order=created_at.asc`, {
    headers: {
      apikey: PROD_SERVICE_KEY,
      Authorization: `Bearer ${PROD_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Production fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function loadPostsFromFile(path) {
  const raw = readFileSync(path, 'utf8').trim();
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed) && parsed[0]?.posts) return parsed[0].posts;
  if (Array.isArray(parsed) && parsed[0]?.id) return parsed;
  if (parsed.posts) return parsed.posts;
  throw new Error('Unrecognized JSON shape in ' + path);
}

const updateCols = [
  'parent_id', 'path', 'slug', 'title', 'subtitle', 'excerpt', 'body', 'post_kind',
  'status', 'scheduled_publish_at', 'published_at', 'display_order', 'featured_image_url',
  'hero_style', 'reading_minutes', 'author_display_name', 'tags', 'custom_css', 'settings',
  'seo_title', 'seo_description', 'seo_keywords', 'canonical_url', 'og_image_url',
  'twitter_card', 'robots', 'structured_data', 'locale', 'created_by', 'created_at',
  'updated_at', 'author_bio', 'author_avatar_url', 'author_role', 'author_linkedin_url',
  'content_category', 'featured_image_object_position', 'faq_json', 'seo_score',
  'aeo_score', 'geo_score', 'eeat_score', 'readability_score', 'quality_score',
  'json_ld_schemas',
];
const updateSet = updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(',\n  ');

const inputFile = process.argv[2];
const posts = inputFile
  ? loadPostsFromFile(inputFile)
  : await fetchProductionPosts();

console.log(`Upserting ${posts.length} posts to staging...`);

let synced = 0;
const errors = [];

for (const post of posts) {
  const tag = `post_${post.id.replace(/-/g, '_')}`;
  const json = JSON.stringify(post);
  const sql = `
INSERT INTO blog_posts
SELECT * FROM json_populate_record(null::blog_posts, $${tag}$${json}$${tag}$::json)
ON CONFLICT (id) DO UPDATE SET
  ${updateSet};
`;

  const result = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    errors.push({ id: post.id, slug: post.slug, error: result.stderr?.trim() });
    console.error(`FAIL ${post.slug}`);
  } else {
    synced++;
    console.log(`OK ${post.slug}`);
  }
}

console.log(`\nResult: ${synced}/${posts.length} synced`);
if (errors.length) {
  console.error(JSON.stringify(errors, null, 2));
  process.exit(1);
}
