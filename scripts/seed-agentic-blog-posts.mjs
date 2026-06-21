#!/usr/bin/env node
/**
 * Seed agentic positioning blog posts from docs/marketing/blog-drafts/*.md
 * into staging (or any) Postgres via DATABASE_URL psql.
 *
 * Usage:
 *   node backend/scripts/seed-agentic-blog-posts.mjs
 *   node backend/scripts/seed-agentic-blog-posts.mjs --dry-run   # print SQL only
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');
config({ path: join(__dirname, '../.env') });

const draftsDir = join(repoRoot, 'docs/marketing/blog-drafts');
const dryRun = process.argv.includes('--dry-run');
const outputDir = process.argv.find((a) => a.startsWith('--output-dir='))?.split('=')[1];
const dbUrl = process.env.DATABASE_URL;

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error('Missing YAML frontmatter');
  const yaml = match[1];
  const body = match[2].trim();
  const meta = {};
  let currentKey = null;
  let listItems = null;

  for (const line of yaml.split('\n')) {
    if (listItems !== null) {
      const li = line.match(/^\s+-\s+(.*)$/);
      if (li) {
        listItems.push(li[1].replace(/^["']|["']$/g, ''));
        continue;
      }
      meta[currentKey] = listItems;
      listItems = null;
      currentKey = null;
    }
    const faqBlock = line.match(/^faq_json:\s*$/);
    if (faqBlock) {
      currentKey = 'faq_json';
      meta.faq_json = [];
      continue;
    }
    if (currentKey === 'faq_json') {
      const q = line.match(/^\s+-\s+question:\s*(.*)$/);
      if (q) {
        meta.faq_json.push({ question: q[1].replace(/^["']|["']$/g, ''), answer: '' });
        continue;
      }
      const a = line.match(/^\s+answer:\s*(.*)$/);
      if (a && meta.faq_json.length) {
        meta.faq_json[meta.faq_json.length - 1].answer = a[1].replace(/^["']|["']$/g, '');
        continue;
      }
    }
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val === '' || val === undefined) {
      currentKey = key;
      listItems = [];
      continue;
    }
    meta[key] = val.replace(/^["']|["']$/g, '');
  }
  if (listItems !== null && currentKey) meta[currentKey] = listItems;

  return { meta, body };
}

function sqlLiteral(value, { asJsonb = false } = {}) {
  if (value === null || value === undefined) return 'NULL';
  if (asJsonb) {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Array.isArray(value)) {
    return `ARRAY[${value.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ')}]::text[]`;
  }
  if (typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildInsert({ meta, body }) {
  const slug = meta.slug;
  const faqJson = meta.faq_json?.length ? meta.faq_json : null;
  const tags = meta.tags || [];

  const row = {
    path: slug,
    slug,
    title: meta.title,
    excerpt: meta.excerpt,
    body,
    post_kind: 'article',
    status: meta.status || 'draft',
    content_category: meta.content_category || 'Marketing',
    reading_minutes: parseInt(meta.reading_minutes, 10) || null,
    author_display_name: meta.author_display_name || 'Aman Ahuja',
    author_role: meta.author_role || 'Founder & CEO',
    tags,
    seo_title: meta.seo_title,
    seo_description: meta.seo_description,
    seo_keywords: meta.seo_keywords || null,
    faq_json: faqJson,
    locale: 'en',
    robots: 'index,follow',
    twitter_card: 'summary_large_image',
  };

  const cols = Object.keys(row);
  const vals = cols.map((c) =>
    c === 'faq_json' ? sqlLiteral(row[c], { asJsonb: true }) : sqlLiteral(row[c]),
  );

  return `
INSERT INTO blog_posts (${cols.join(', ')})
VALUES (${vals.join(', ')})
ON CONFLICT (path) DO UPDATE SET
  slug = EXCLUDED.slug,
  title = EXCLUDED.title,
  excerpt = EXCLUDED.excerpt,
  body = EXCLUDED.body,
  post_kind = EXCLUDED.post_kind,
  status = EXCLUDED.status,
  content_category = EXCLUDED.content_category,
  reading_minutes = EXCLUDED.reading_minutes,
  author_display_name = EXCLUDED.author_display_name,
  author_role = EXCLUDED.author_role,
  tags = EXCLUDED.tags,
  seo_title = EXCLUDED.seo_title,
  seo_description = EXCLUDED.seo_description,
  seo_keywords = EXCLUDED.seo_keywords,
  faq_json = EXCLUDED.faq_json,
  updated_at = now();
`;
}

const files = readdirSync(draftsDir)
  .filter((f) => f.endsWith('.md'))
  .sort();

if (!files.length) {
  console.error('No markdown drafts found in', draftsDir);
  process.exit(1);
}

const statements = [];
for (const file of files) {
  const raw = readFileSync(join(draftsDir, file), 'utf8');
  const parsed = parseFrontmatter(raw);
  const sql = buildInsert(parsed);
  statements.push(sql);
  console.log(`Prepared: ${parsed.meta.slug} (${file})`);
  if (outputDir) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, `${parsed.meta.slug}.sql`), sql.trim() + '\n');
  }
}

const fullSql = statements.join('\n');

if (outputDir) {
  console.log(`\nWrote ${files.length} SQL file(s) to ${outputDir}`);
  process.exit(0);
}

if (process.argv.includes('--rest')) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for --rest');
    process.exit(1);
  }
  for (const file of files) {
    const raw = readFileSync(join(draftsDir, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const slug = meta.slug;
    const row = {
      path: slug,
      slug,
      title: meta.title,
      excerpt: meta.excerpt,
      body,
      post_kind: 'article',
      status: meta.status || 'draft',
      content_category: meta.content_category || 'Marketing',
      reading_minutes: parseInt(meta.reading_minutes, 10) || null,
      author_display_name: meta.author_display_name || 'Aman Ahuja',
      author_role: meta.author_role || 'Founder & CEO',
      tags: meta.tags || [],
      seo_title: meta.seo_title,
      seo_description: meta.seo_description,
      seo_keywords: meta.seo_keywords || null,
      faq_json: meta.faq_json?.length ? meta.faq_json : null,
      locale: 'en',
      robots: 'index,follow',
      twitter_card: 'summary_large_image',
    };
    const res = await fetch(`${supabaseUrl}/rest/v1/blog_posts?on_conflict=path`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.error(`FAIL ${slug}:`, res.status, await res.text());
      process.exit(1);
    }
    console.log(`OK ${slug}`);
  }
  console.log(`\nUpserted ${files.length} post(s) via REST.`);
  process.exit(0);
}

if (dryRun) {
  console.log('\n--- SQL ---\n');
  console.log(fullSql);
  process.exit(0);
}

if (!dbUrl) {
  console.error('DATABASE_URL not set — use --dry-run or set DATABASE_URL in backend/.env');
  process.exit(1);
}

const result = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', fullSql], {
  encoding: 'utf8',
});

if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
if (result.status !== 0) process.exit(result.status || 1);

console.log(`\nSeeded ${files.length} blog post(s) successfully.`);
