/**
 * Convert HTML blog posts to Markdown
 * 
 * Some blog posts were created with HTML instead of markdown.
 * This script converts them to proper markdown format.
 * 
 * Run with: npx tsx scripts/convert-html-to-markdown.ts
 */

import { createClient } from '@supabase/supabase-js';
import TurndownService from 'turndown';

const SUPABASE_URL = 'https://kpycyjszismwegregbva.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY environment variable is required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

/**
 * Detect if a string is HTML vs Markdown
 */
function isHtml(text: string): boolean {
  // Check for common HTML tags
  const htmlPattern = /<(h[1-6]|p|div|span|br|img|a|ul|ol|li|blockquote|pre|code|strong|em)\b[^>]*>/i;
  return htmlPattern.test(text);
}

/**
 * Convert HTML to Markdown
 */
function convertHtmlToMarkdown(html: string): string {
  try {
    const markdown = turndownService.turndown(html);
    return markdown;
  } catch (error) {
    console.error('Error converting HTML:', error);
    return html; // Return original if conversion fails
  }
}

async function main() {
  console.log('🔄 Starting HTML to Markdown conversion...\n');

  // Find all blog posts
  const { data: posts, error: fetchError } = await supabase
    .from('blog_posts')
    .select('id, title, slug, body, excerpt')
    .order('created_at', { ascending: false });

  if (fetchError) {
    console.error('❌ Failed to fetch posts:', fetchError.message);
    process.exit(1);
  }

  if (!posts || posts.length === 0) {
    console.log('✅ No posts found');
    return;
  }

  console.log(`📊 Found ${posts.length} total posts\n`);

  let convertedCount = 0;
  let skippedCount = 0;

  for (const post of posts) {
    const hasHtmlBody = post.body && isHtml(post.body);
    const hasHtmlExcerpt = post.excerpt && isHtml(post.excerpt);

    if (!hasHtmlBody && !hasHtmlExcerpt) {
      skippedCount++;
      continue;
    }

    console.log(`📝 Converting: ${post.title}`);
    console.log(`   Slug: ${post.slug}`);

    const updates: any = {};

    if (hasHtmlBody) {
      console.log('   🔄 Converting body (HTML → Markdown)');
      updates.body = convertHtmlToMarkdown(post.body);
    }

    if (hasHtmlExcerpt) {
      console.log('   🔄 Converting excerpt (HTML → Markdown)');
      updates.excerpt = convertHtmlToMarkdown(post.excerpt);
    }

    // Update the post
    const { error: updateError } = await supabase
      .from('blog_posts')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', post.id);

    if (updateError) {
      console.error(`   ❌ Update failed:`, updateError.message);
    } else {
      console.log('   ✅ Converted successfully\n');
      convertedCount++;
    }
  }

  console.log('\n🎉 Conversion complete!');
  console.log(`   ✅ Converted: ${convertedCount} posts`);
  console.log(`   ⏭️  Skipped: ${skippedCount} posts (already markdown)`);
  console.log(`   📊 Total: ${posts.length} posts`);
}

main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
