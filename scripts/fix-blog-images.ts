/**
 * Fix blog post images:
 * 1. Generate simple canvas images or use placeholder.com
 * 2. Upload to MinIO via direct MinIO client
 * 3. Update blog_posts with MinIO URLs
 * 
 * Run with: npx tsx scripts/fix-blog-images.ts
 */

import { createClient } from '@supabase/supabase-js';
import { Client as MinioClient } from 'minio';
import { createCanvas } from 'canvas';
import * as crypto from 'crypto';

// Configuration
const SUPABASE_URL = 'https://kpycyjszismwegregbva.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// MinIO config (from backend/.env or environment)
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'localhost';
const MINIO_PORT = parseInt(process.env.MINIO_PORT || '9000');
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin';
const MINIO_BUCKET = process.env.MINIO_BUCKET_NAME || 'contentos-media';
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === 'true';
const MINIO_PUBLIC_URL = process.env.MINIO_PUBLIC_URL || 'http://localhost:9000';

if (!SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY environment variable is required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Initialize MinIO client
const minioClient = new MinioClient({
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
});

interface BlogImage {
  slug: string;
  images: Array<{
    type: 'hero' | 'diagram';
    description: string;
    oldUrl: string;
    filename: string;
    width: number;
    height: number;
    text: string;
  }>;
}

const blogImages: BlogImage[] = [
  {
    slug: 'what-is-agentic-social-media-scheduling',
    images: [
      {
        type: 'hero',
        description: 'Agentic Social Media Scheduling',
        oldUrl: 'https://source.unsplash.com/1200x600/?social+media+automation',
        filename: 'agentic-social-hero.jpg',
        width: 1200,
        height: 600,
        text: 'Agentic Social\nScheduling'
      },
      {
        type: 'diagram',
        description: 'AI Agent Workflow',
        oldUrl: 'https://source.unsplash.com/800x400/?artificial+intelligence+workflow',
        filename: 'ai-agent-workflow.jpg',
        width: 800,
        height: 400,
        text: 'AI Agent\nWorkflow'
      }
    ]
  },
  {
    slug: 'linkedin-autopilot-ai-agents-brand-voice',
    images: [
      {
        type: 'hero',
        description: 'LinkedIn Automation with AI',
        oldUrl: 'https://source.unsplash.com/1200x600/?linkedin+professional+network',
        filename: 'linkedin-autopilot-hero.jpg',
        width: 1200,
        height: 600,
        text: 'LinkedIn\nAutopilot'
      },
      {
        type: 'diagram',
        description: 'LinkedIn Strategy Workflow',
        oldUrl: 'https://source.unsplash.com/800x400/?strategy+planning+workflow',
        filename: 'linkedin-strategy-workflow.jpg',
        width: 800,
        height: 400,
        text: 'LinkedIn\nStrategy'
      }
    ]
  },
  {
    slug: 'trndinn-vs-postiz-agentic-scheduler-vs-growth-os',
    images: [
      {
        type: 'hero',
        description: 'Trndinn vs Postiz Comparison',
        oldUrl: 'https://source.unsplash.com/1200x600/?software+comparison+tools',
        filename: 'trndinn-vs-postiz-hero.jpg',
        width: 1200,
        height: 600,
        text: 'Trndinn vs\nPostiz'
      },
      {
        type: 'diagram',
        description: 'Platform Comparison Diagram',
        oldUrl: 'https://source.unsplash.com/800x400/?platform+comparison+diagram',
        filename: 'platform-comparison-diagram.jpg',
        width: 800,
        height: 400,
        text: 'Platform\nComparison'
      }
    ]
  },
  {
    slug: 'blog-post-to-31-platforms-agentic-distribution-loop',
    images: [
      {
        type: 'hero',
        description: 'Content Distribution Workflow',
        oldUrl: 'https://source.unsplash.com/1200x600/?content+distribution+network',
        filename: 'content-distribution-hero.jpg',
        width: 1200,
        height: 600,
        text: 'Content\nDistribution'
      },
      {
        type: 'diagram',
        description: 'Agentic Distribution Loop Diagram',
        oldUrl: 'https://source.unsplash.com/800x400/?workflow+automation+diagram',
        filename: 'distribution-loop-diagram.jpg',
        width: 800,
        height: 400,
        text: 'Distribution\nLoop'
      }
    ]
  }
];


/**
 * Generate a simple placeholder image using canvas
 */
function generatePlaceholderImage(
  width: number,
  height: number,
  text: string
): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Gradient background (Trndinn brand colors)
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#4F46E5'); // Indigo
  gradient.addColorStop(1, '#7C3AED'); // Purple
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Add text
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  const fontSize = Math.floor(height / 8);
  ctx.font = `bold ${fontSize}px Arial`;
  
  const lines = text.split('\n');
  const lineHeight = fontSize * 1.2;
  const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;
  
  lines.forEach((line, i) => {
    ctx.fillText(line, width / 2, startY + i * lineHeight);
  });

  return canvas.toBuffer('image/jpeg', { quality: 0.9 });
}

/**
 * Upload image buffer directly to MinIO
 */
async function uploadToMinio(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const objectKey = `blog/${filename}`;
  
  // Upload to MinIO
  await minioClient.putObject(
    MINIO_BUCKET,
    objectKey,
    buffer,
    buffer.length,
    {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000'
    }
  );

  // Construct public URL
  const publicUrl = `${MINIO_PUBLIC_URL}/${MINIO_BUCKET}/${objectKey}`;
  
  console.log(`  ✅ Uploaded to MinIO: ${publicUrl}`);
  return publicUrl;
}

/**
 * Update blog post body with new image URL
 */
function replaceBlogImageUrl(body: string, oldUrl: string, newUrl: string): string {
  return body.replace(oldUrl, newUrl);
}


/**
 * Main execution
 */
async function main() {
  console.log('🚀 Starting blog image fix...\n');

  // Check MinIO connection
  try {
    const exists = await minioClient.bucketExists(MINIO_BUCKET);
    if (!exists) {
      console.error(`❌ MinIO bucket "${MINIO_BUCKET}" does not exist`);
      process.exit(1);
    }
    console.log(`✅ Connected to MinIO bucket: ${MINIO_BUCKET}\n`);
  } catch (error) {
    console.error('❌ Failed to connect to MinIO:', error.message);
    console.error('   Make sure MinIO is running and environment variables are set');
    process.exit(1);
  }

  // Process each blog post
  for (const blog of blogImages) {
    console.log(`📝 Processing: ${blog.slug}`);
    
    // Get current blog post
    const { data: post, error: fetchError } = await supabase
      .from('blog_posts')
      .select('id, body')
      .eq('slug', blog.slug)
      .single();

    if (fetchError || !post) {
      console.error(`  ❌ Failed to fetch post: ${fetchError?.message}`);
      continue;
    }

    let updatedBody = post.body;

    // Process each image
    for (const image of blog.images) {
      console.log(`  🖼️  Generating ${image.type}: ${image.filename}`);
      
      try {
        // Generate placeholder image
        const imageBuffer = generatePlaceholderImage(
          image.width,
          image.height,
          image.text
        );

        console.log(`  📤 Uploading to MinIO...`);
        
        // Upload to MinIO
        const minioUrl = await uploadToMinio(imageBuffer, image.filename);

        // Replace in body
        updatedBody = replaceBlogImageUrl(updatedBody, image.oldUrl, minioUrl);
      } catch (error) {
        console.error(`  ❌ Failed to process ${image.filename}:`, error.message);
      }
    }

    // Update blog post in Supabase
    console.log(`  💾 Updating blog post in Supabase...`);
    const { error: updateError } = await supabase
      .from('blog_posts')
      .update({ 
        body: updatedBody,
        updated_at: new Date().toISOString()
      })
      .eq('id', post.id);

    if (updateError) {
      console.error(`  ❌ Failed to update post:`, updateError.message);
    } else {
      console.log(`  ✅ Updated successfully!\n`);
    }
  }

  console.log('🎉 Blog image fix complete!');
  console.log('\n📋 Summary:');
  console.log(`   - Processed ${blogImages.length} blog posts`);
  console.log(`   - Generated and uploaded ${blogImages.reduce((acc, b) => acc + b.images.length, 0)} images`);
  console.log(`   - Images stored in MinIO at: ${MINIO_PUBLIC_URL}/${MINIO_BUCKET}/blog/`);
}

main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
