#!/usr/bin/env node

/**
 * Add images to 4 existing blog posts
 * Run: SUPABASE_URL=https://your-project.supabase.co SUPABASE_SERVICE_KEY=your-key node scripts/add-blog-images.mjs
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const updates = [
  {
    slug: 'what-is-agentic-social-media-scheduling',
    heroImage: '![Agentic Social Media Scheduling](https://source.unsplash.com/1200x600/?social+media+automation)',
    sectionImage: {
      after: '## What "agentic" actually means',
      image: '\n\n![AI Agent Workflow](https://source.unsplash.com/800x400/?artificial+intelligence+workflow)\n\n'
    }
  },
  {
    slug: 'linkedin-autopilot-ai-agents-brand-voice',
    heroImage: '![LinkedIn Automation with AI](https://source.unsplash.com/1200x600/?linkedin+professional+network)',
    sectionImage: {
      after: '## What "autopilot" should mean on LinkedIn',
      image: '\n\n![LinkedIn Strategy Workflow](https://source.unsplash.com/800x400/?strategy+planning+workflow)\n\n'
    }
  },
  {
    slug: 'trndinn-vs-postiz-agentic-scheduler-vs-growth-os',
    heroImage: '![Trndinn vs Postiz Comparison](https://source.unsplash.com/1200x600/?software+comparison+tools)',
    sectionImage: {
      after: '## What both tools mean by "agentic"',
      image: '\n\n![Platform Comparison Diagram](https://source.unsplash.com/800x400/?platform+comparison+diagram)\n\n'
    }
  },
  {
    slug: 'blog-post-to-31-platforms-agentic-distribution-loop',
    heroImage: '![Content Distribution Workflow](https://source.unsplash.com/1200x600/?content+distribution+network)',
    sectionImage: {
      after: '## The agentic distribution loop (overview)',
      image: '\n\n![Agentic Distribution Loop Diagram](https://source.unsplash.com/800x400/?workflow+automation+diagram)\n\n'
    }
  }
];

async function addImages() {
  console.log('Starting blog post image updates...\n');

  for (const update of updates) {
    try {
      // Fetch current post
      const { data: post, error: fetchError } = await supabase
        .from('blog_posts')
        .select('id, title, body')
        .eq('slug', update.slug)
        .single();

      if (fetchError || !post) {
        console.error(`❌ Failed to fetch ${update.slug}:`, fetchError?.message || 'Not found');
        continue;
      }

      let updatedBody = post.body;

      // Add hero image at top if not already present
      if (!updatedBody.startsWith('![')) {
        updatedBody = `${update.heroImage}\n\n${updatedBody}`;
      }

      // Add section image after specific heading
      if (update.sectionImage && !updatedBody.includes(update.sectionImage.image.trim())) {
        const headingIndex = updatedBody.indexOf(update.sectionImage.after);
        if (headingIndex !== -1) {
          const headingEndIndex = updatedBody.indexOf('\n', headingIndex);
          if (headingEndIndex !== -1) {
            updatedBody = 
              updatedBody.slice(0, headingEndIndex) +
              update.sectionImage.image +
              updatedBody.slice(headingEndIndex + 1);
          }
        }
      }

      // Update post
      const { error: updateError } = await supabase
        .from('blog_posts')
        .update({ body: updatedBody })
        .eq('id', post.id);

      if (updateError) {
        console.error(`❌ Failed to update ${update.slug}:`, updateError.message);
      } else {
        console.log(`✅ Updated ${update.slug}`);
        console.log(`   Title: ${post.title}`);
        console.log(`   Hero: Added`);
        console.log(`   Section: ${update.sectionImage ? 'Added' : 'Skipped'}\n`);
      }
    } catch (error) {
      console.error(`❌ Error processing ${update.slug}:`, error.message);
    }
  }

  console.log('✨ Blog post image updates complete!');
}

addImages().catch(console.error);
