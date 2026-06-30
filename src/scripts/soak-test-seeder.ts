/**
 * Soak Test Seeder (Sprint 1.10)
 *
 * Creates test data for the LinkedIn publishing soak test:
 * - 2 test users (Solo + Growth tier)
 * - 100+ posts spread over 7 days (or 7 hours in fast-forward mode)
 * - Mix of content types: text, images, carousels
 * - Mix of schedules: immediate, near-future, far-future
 * - 5 recurring workflows (daily/weekly patterns)
 *
 * Usage:
 *   npm run soak-test:seed              # 7-day schedule
 *   npm run soak-test:seed:fast         # 7-hour fast-forward
 *   ts-node src/scripts/soak-test-seeder.ts --fast-forward
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SupabaseService } from '../services/supabase.service';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../common/constants';

interface TestUser {
  id: string;
  email: string;
  tier: string;
  credits: number;
}

interface SeederOptions {
  fastForward: boolean; // 7 hours instead of 7 days
  dryRun: boolean;
}

const logger = new Logger('SoakTestSeeder');

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const supabase = app.get(SupabaseService);
  const config = app.get(ConfigService);

  // Parse CLI args
  const args = process.argv.slice(2);
  const options: SeederOptions = {
    fastForward: args.includes('--fast-forward'),
    dryRun: args.includes('--dry-run'),
  };

  const timeUnit = options.fastForward ? 'hours' : 'days';
  const timeMultiplier = options.fastForward ? 3600000 : 86400000; // ms per hour or day

  logger.log(`
╔═══════════════════════════════════════════════════════════════╗
║           🧪 SOAK TEST SEEDER (Sprint 1.10)                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Mode: ${options.fastForward ? '⚡ FAST-FORWARD (7 hours)' : '🕐 STANDARD (7 days)'.padEnd(56)}║
║  Dry run: ${options.dryRun ? 'YES' : 'NO '.padEnd(52)}║
║  Test users: Isolated with is_test_user=true flag            ║
╚═══════════════════════════════════════════════════════════════╝
`);

  logger.log(
    '✅ Test users will use mock publishing (is_test_user=true). Real users are unaffected.',
  );

  try {
    // Step 1: Create test users
    logger.log('📝 Creating test users...');
    const users = await createTestUsers(supabase, options);

    // Step 2: Create posts with varied schedules
    logger.log(`📅 Creating 100+ posts spread over 7 ${timeUnit}...`);
    await createScheduledPosts(
      supabase,
      users,
      timeMultiplier,
      timeUnit,
      options,
    );

    // Step 3: Create recurring workflows
    logger.log('🔁 Creating recurring workflow patterns...');
    await createRecurringWorkflows(
      supabase,
      users,
      timeMultiplier,
      timeUnit,
      options,
    );

    logger.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    ✅ SEEDING COMPLETE                        ║
╠═══════════════════════════════════════════════════════════════╣
║  Test users: ${users.length}                                               ║
║  Duration: 7 ${timeUnit}                                          ║
║                                                               ║
║  Next steps:                                                  ║
║  1. Run: npm run soak-test:run${options.fastForward ? ':fast' : ''}                          ║
║  2. Monitor: http://localhost:5173/admin/soak-test           ║
╚═══════════════════════════════════════════════════════════════╝
`);
  } catch (error) {
    logger.error('❌ Seeding failed:', error);
    throw error;
  } finally {
    await app.close();
  }
}

async function createTestUsers(
  supabase: SupabaseService,
  options: SeederOptions,
): Promise<TestUser[]> {
  const timestamp = Date.now();
  const users: TestUser[] = [
    {
      id: `soak-test-solo-${timestamp}`,
      email: `soak-solo-${timestamp}@trndinn-test.internal`,
      tier: 'solo',
      credits: 1000,
    },
    {
      id: `soak-test-growth-${timestamp}`,
      email: `soak-growth-${timestamp}@trndinn-test.internal`,
      tier: 'growth',
      credits: 5000,
    },
  ];

  if (options.dryRun) {
    logger.log('[DRY RUN] Would create users:', users);
    return users;
  }

  const client = supabase.getServiceClient();

  for (const user of users) {
    // Create profile
    const { error: profileError } = await client.from('profiles').insert({
      id: user.id,
      email: user.email,
      full_name: `Soak Test ${user.tier.toUpperCase()}`,
      credits_remaining: user.credits,
      subscription_tier: user.tier,
      // Mock LinkedIn credentials for testing
      linkedin_access_token: `mock_token_${user.id}`,
      linkedin_refresh_token: `mock_refresh_${user.id}`,
      linkedin_expires_at: new Date(Date.now() + 365 * 86400000).toISOString(), // 1 year
      is_test_user: true, // FLAG: This user gets mock publishing
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (profileError) {
      logger.error(`Failed to create profile for ${user.email}:`, profileError);
      throw profileError;
    }

    logger.log(`  ✅ Created user: ${user.email} (${user.tier})`);
  }

  return users;
}

async function createScheduledPosts(
  supabase: SupabaseService,
  users: TestUser[],
  timeMultiplier: number,
  timeUnit: string,
  options: SeederOptions,
): Promise<void> {
  const client = supabase.getServiceClient();
  const now = Date.now();

  const contentTypes: Array<{
    type: 'text' | 'image' | 'carousel';
    weight: number;
  }> = [
    { type: 'text', weight: 40 },
    { type: 'image', weight: 40 },
    { type: 'carousel', weight: 20 },
  ];

  // Distribution strategy: 100 posts over 7 periods
  // Day/Hour 1: 20 posts (heavy load test)
  // Day/Hour 2-3: 15 posts each (sustained load)
  // Day/Hour 4-5: 10 posts each (moderate load)
  // Day/Hour 6-7: 15 posts each (recovery verification)
  const distribution = [20, 15, 15, 10, 10, 15, 15];

  let totalPosts = 0;

  for (let period = 0; period < 7; period++) {
    const postsInPeriod = distribution[period];
    logger.log(
      `  📦 ${timeUnit.slice(0, -1).toUpperCase()} ${period + 1}: ${postsInPeriod} posts`,
    );

    for (let i = 0; i < postsInPeriod; i++) {
      const user = users[i % users.length]; // Alternate between users

      // Random content type (weighted)
      const contentType = weightedRandom(contentTypes);

      // Random schedule within the period
      const periodStart = now + period * timeMultiplier;
      const periodEnd = periodStart + timeMultiplier;
      const scheduledFor = new Date(
        periodStart + Math.random() * (periodEnd - periodStart),
      );

      // Create generated_content entry
      const postContent = generatePostContent(contentType, period, i);

      if (options.dryRun) {
        logger.log(
          `[DRY RUN] Would create ${contentType} post for ${user.email} at ${scheduledFor.toISOString()}`,
        );
        continue;
      }

      const { data: content, error: contentError } = await client
        .from('generated_content')
        .insert({
          user_id: user.id,
          title: postContent.title,
          content: postContent.content,
          hashtags: postContent.hashtags,
          visual_type: contentType,
          visual_url: postContent.visualUrl,
          carousel_urls: postContent.carouselUrls,
          pdf_url: postContent.pdfUrl,
          publish_status: 'ready',
          is_scheduled: true,
          scheduled_for: scheduledFor.toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (contentError) {
        logger.error('Failed to create content:', contentError);
        continue;
      }

      // Create scheduled_posts entry (queue job will be created by POST /posts/schedule)
      // For soak test, we'll directly insert and create BullMQ jobs
      const jobId = `soak-test-${content.id}-${Date.now()}`;

      const { error: scheduleError } = await client
        .from('scheduled_posts')
        .insert({
          user_id: user.id,
          content_id: content.id,
          job_id: jobId,
          scheduled_for: scheduledFor.toISOString(),
          platform: 'linkedin',
          status: 'scheduled',
          actor_type: 'member',
          organization_urn: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (scheduleError) {
        logger.error('Failed to create scheduled post:', scheduleError);
        continue;
      }

      totalPosts++;
    }
  }

  logger.log(`  ✅ Created ${totalPosts} scheduled posts`);
}

async function createRecurringWorkflows(
  supabase: SupabaseService,
  users: TestUser[],
  timeMultiplier: number,
  timeUnit: string,
  options: SeederOptions,
): Promise<void> {
  // Recurring patterns: daily 9am, daily 3pm, MWF 11am, weekly Monday, weekly Friday
  const patterns = [
    {
      name: 'Daily 9am',
      times: Array.from({ length: 7 }, (_, i) => i * timeMultiplier + 9 * 3600000), // 9am each day/hour
    },
    {
      name: 'Daily 3pm',
      times: Array.from(
        { length: 7 },
        (_, i) => i * timeMultiplier + 15 * 3600000,
      ), // 3pm each day/hour
    },
    {
      name: 'MWF 11am',
      times: [0, 2, 4].map((day) => day * timeMultiplier + 11 * 3600000), // Mon, Wed, Fri at 11am
    },
    {
      name: 'Weekly Monday',
      times: [0 * timeMultiplier + 10 * 3600000], // Monday 10am
    },
    {
      name: 'Weekly Friday',
      times: [4 * timeMultiplier + 16 * 3600000], // Friday 4pm
    },
  ];

  if (options.dryRun) {
    logger.log('[DRY RUN] Would create recurring workflows:', patterns);
    return;
  }

  const client = supabase.getServiceClient();
  const now = Date.now();

  for (const pattern of patterns) {
    const user = users[0]; // Use first user for recurring
    logger.log(`  🔁 ${pattern.name}: ${pattern.times.length} instances`);

    for (const offset of pattern.times) {
      const scheduledFor = new Date(now + offset);
      const postContent = generatePostContent('text', 0, 0);

      const { data: content, error: contentError } = await client
        .from('generated_content')
        .insert({
          user_id: user.id,
          title: `${pattern.name} - ${postContent.title}`,
          content: `[Recurring: ${pattern.name}] ${postContent.content}`,
          hashtags: postContent.hashtags,
          visual_type: 'text',
          publish_status: 'ready',
          is_scheduled: true,
          scheduled_for: scheduledFor.toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (contentError) {
        logger.error('Failed to create recurring content:', contentError);
        continue;
      }

      const jobId = `soak-test-recurring-${content.id}-${Date.now()}`;

      const { error: scheduleError } = await client
        .from('scheduled_posts')
        .insert({
          user_id: user.id,
          content_id: content.id,
          job_id: jobId,
          scheduled_for: scheduledFor.toISOString(),
          platform: 'linkedin',
          status: 'scheduled',
          actor_type: 'member',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (scheduleError) {
        logger.error('Failed to create recurring schedule:', scheduleError);
      }
    }
  }
}

function generatePostContent(
  type: 'text' | 'image' | 'carousel',
  period: number,
  index: number,
): {
  title: string;
  content: string;
  hashtags: string[];
  visualUrl?: string;
  carouselUrls?: string[];
  pdfUrl?: string;
} {
  const titles = [
    'Breaking Down Complex Systems',
    '5 Lessons from Building at Scale',
    'The Future of Developer Tools',
    'Why Documentation Matters',
    'Scaling Teams and Infrastructure',
  ];

  const contents = [
    'After years of building distributed systems, here are the key patterns that always deliver results. Thread 🧵',
    'The most underrated skill in tech is not what you think. Let me explain why...',
    'Hot take: Most startups fail not from bad ideas, but from poor execution. Here is what we learned...',
    'Three years ago, we made a critical architectural decision. Today, it is paying dividends. Here is the story...',
    'The best engineers I have worked with all share these traits. Number 3 will surprise you...',
  ];

  const hashtags = [
    ['#SoftwareEngineering', '#TechLeadership'],
    ['#Startups', '#ProductDevelopment'],
    ['#DevOps', '#CloudNative'],
    ['#Engineering', '#BestPractices'],
    ['#TechIndustry', '#Innovation'],
  ];

  const title = titles[index % titles.length];
  const content = contents[index % contents.length];
  const tags = hashtags[index % hashtags.length];

  const result: any = {
    title: `${title} (Period ${period + 1})`,
    content: `${content} #SoakTest #Period${period + 1}`,
    hashtags: [...tags, `#Day${period + 1}`],
  };

  if (type === 'image') {
    // Use placeholder image service
    result.visualUrl = `https://picsum.photos/seed/soak-${period}-${index}/1200/630`;
  } else if (type === 'carousel') {
    // Placeholder carousel images
    result.carouselUrls = Array.from(
      { length: 5 },
      (_, i) =>
        `https://picsum.photos/seed/carousel-${period}-${index}-${i}/1080/1080`,
    );
    // Note: pdf_url will be generated on-demand during publish
  }

  return result;
}

function weightedRandom<T extends { weight: number; type: any }>(items: T[]): T['type'] {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * totalWeight;

  for (const item of items) {
    random -= item.weight;
    if (random <= 0) {
      return item.type;
    }
  }

  return items[0].type;
}

// Run seeder
main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
