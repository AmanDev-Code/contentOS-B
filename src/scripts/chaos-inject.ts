/**
 * Chaos Injection Script (Sprint 1.10)
 *
 * Injects controlled failures into the soak test to verify resilience:
 * - Kill BullMQ worker (30s downtime)
 * - Revoke mock OAuth token
 * - Inject malformed media file
 * - Simulate network failure (2 minutes)
 *
 * Usage:
 *   npm run soak-test:chaos -- --kill-worker
 *   npm run soak-test:chaos -- --revoke-token
 *   npm run soak-test:chaos -- --malformed-media
 *   npm run soak-test:chaos -- --network-down
 *   npm run soak-test:chaos -- --all  # Run all chaos scenarios
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SupabaseService } from '../services/supabase.service';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../common/constants';
import * as IORedis from 'ioredis';

const logger = new Logger('ChaosInject');

interface ChaosOptions {
  killWorker: boolean;
  revokeToken: boolean;
  malformedMedia: boolean;
  networkDown: boolean;
  all: boolean;
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const supabase = app.get(SupabaseService);

  // Parse CLI args
  const args = process.argv.slice(2);
  const options: ChaosOptions = {
    killWorker: args.includes('--kill-worker'),
    revokeToken: args.includes('--revoke-token'),
    malformedMedia: args.includes('--malformed-media'),
    networkDown: args.includes('--network-down'),
    all: args.includes('--all'),
  };

  if (options.all) {
    options.killWorker = true;
    options.revokeToken = true;
    options.malformedMedia = true;
    options.networkDown = true;
  }

  logger.log(`
╔═══════════════════════════════════════════════════════════════╗
║           💥 CHAOS INJECTION (Sprint 1.10)                    ║
╠═══════════════════════════════════════════════════════════════╣
║  Kill worker:      ${options.killWorker ? '✅ YES' : '❌ NO '}                                    ║
║  Revoke token:     ${options.revokeToken ? '✅ YES' : '❌ NO '}                                    ║
║  Malformed media:  ${options.malformedMedia ? '✅ YES' : '❌ NO '}                                    ║
║  Network down:     ${options.networkDown ? '✅ YES' : '❌ NO '}                                    ║
╚═══════════════════════════════════════════════════════════════╝
`);

  if (
    !options.killWorker &&
    !options.revokeToken &&
    !options.malformedMedia &&
    !options.networkDown
  ) {
    logger.warn('No chaos scenarios selected. Use --help for options.');
    await app.close();
    process.exit(0);
  }

  try {
    if (options.killWorker) {
      await chaosKillWorker(app);
    }

    if (options.revokeToken) {
      await chaosRevokeToken(supabase);
    }

    if (options.malformedMedia) {
      await chaosMalformedMedia(supabase);
    }

    if (options.networkDown) {
      await chaosNetworkDown();
    }

    logger.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  ✅ CHAOS INJECTION COMPLETE                  ║
╠═══════════════════════════════════════════════════════════════╣
║  All chaos events logged to chaos-events.log                  ║
║  System should recover automatically                          ║
╚═══════════════════════════════════════════════════════════════╝
`);
  } catch (error) {
    logger.error('❌ Chaos injection failed:', error);
    throw error;
  } finally {
    await app.close();
  }
}

async function chaosKillWorker(app: any): Promise<void> {
  logger.warn('💀 CHAOS: Killing BullMQ worker for 30 seconds...');

  // Get Redis connection info from environment
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = parseInt(process.env.REDIS_PORT || '6379');
  const redisPassword = process.env.REDIS_PASSWORD || undefined;

  const redis = new IORedis.default({
    host: redisHost,
    port: redisPort,
    password: redisPassword,
    maxRetriesPerRequest: null,
  });

  try {
    // Pause the queue (simulates worker unavailability)
    const queue = new Queue(QUEUE_NAMES.SOCIAL_PUBLISH, {
      connection: {
        host: redisHost,
        port: redisPort,
        password: redisPassword,
      },
    });

    await queue.pause();
    logger.log('  ⏸️  Queue paused (simulating worker crash)');

    // Log chaos event
    await logChaosEvent('worker_killed', {
      duration_ms: 30000,
      queue: QUEUE_NAMES.SOCIAL_PUBLISH,
    });

    // Wait 30 seconds
    await new Promise((resolve) => setTimeout(resolve, 30000));

    // Resume queue
    await queue.resume();
    logger.log('  ▶️  Queue resumed (simulating worker recovery)');

    await logChaosEvent('worker_recovered', {
      queue: QUEUE_NAMES.SOCIAL_PUBLISH,
    });

    await queue.close();
    await redis.quit();
  } catch (error) {
    logger.error('Failed to kill/recover worker:', error);
    await redis.quit();
    throw error;
  }
}

async function chaosRevokeToken(supabase: SupabaseService): Promise<void> {
  logger.warn('🔑 CHAOS: Revoking mock OAuth tokens...');

  try {
    const client = supabase.getServiceClient();

    // Find soak test users
    const { data: users, error } = await client
      .from('profiles')
      .select('id, email')
      .ilike('email', '%soak-%@trndinn-test.internal');

    if (error || !users || users.length === 0) {
      logger.warn('No soak test users found to revoke tokens for');
      return;
    }

    // Revoke tokens for first user (creates auth failures)
    const targetUser = users[0];

    await client
      .from('profiles')
      .update({
        linkedin_access_token: 'REVOKED_TOKEN_FOR_CHAOS_TEST',
        linkedin_expires_at: new Date(Date.now() - 86400000).toISOString(), // Expired yesterday
        updated_at: new Date().toISOString(),
      })
      .eq('id', targetUser.id);

    logger.log(`  ❌ Revoked token for ${targetUser.email}`);

    await logChaosEvent('token_revoked', {
      user_id: targetUser.id,
      email: targetUser.email,
    });

    // Wait 2 minutes, then restore
    logger.log('  ⏳ Waiting 2 minutes before restoring token...');
    await new Promise((resolve) => setTimeout(resolve, 120000));

    await client
      .from('profiles')
      .update({
        linkedin_access_token: `mock_token_${targetUser.id}`,
        linkedin_expires_at: new Date(
          Date.now() + 365 * 86400000,
        ).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', targetUser.id);

    logger.log(`  ✅ Restored token for ${targetUser.email}`);

    await logChaosEvent('token_restored', {
      user_id: targetUser.id,
      email: targetUser.email,
    });
  } catch (error) {
    logger.error('Failed to revoke/restore token:', error);
    throw error;
  }
}

async function chaosMalformedMedia(supabase: SupabaseService): Promise<void> {
  logger.warn('🖼️  CHAOS: Injecting malformed media URLs...');

  try {
    const client = supabase.getServiceClient();

    // Find a scheduled image post
    const { data: content, error } = await client
      .from('generated_content')
      .select('id, user_id, visual_url')
      .eq('visual_type', 'image')
      .eq('publish_status', 'ready')
      .limit(1)
      .single();

    if (error || !content) {
      logger.warn('No image posts found to corrupt');
      return;
    }

    const originalUrl = content.visual_url;

    // Replace with malformed URL
    await client
      .from('generated_content')
      .update({
        visual_url: 'https://invalid-domain-does-not-exist.xyz/image.jpg',
        updated_at: new Date().toISOString(),
      })
      .eq('id', content.id);

    logger.log(`  💥 Corrupted image URL for content ${content.id}`);

    await logChaosEvent('malformed_media', {
      content_id: content.id,
      original_url: originalUrl,
      corrupted_url: 'https://invalid-domain-does-not-exist.xyz/image.jpg',
    });

    // Wait 1 minute, then restore
    logger.log('  ⏳ Waiting 1 minute before restoring URL...');
    await new Promise((resolve) => setTimeout(resolve, 60000));

    await client
      .from('generated_content')
      .update({
        visual_url: originalUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('id', content.id);

    logger.log(`  ✅ Restored original URL for content ${content.id}`);

    await logChaosEvent('media_restored', {
      content_id: content.id,
      restored_url: originalUrl,
    });
  } catch (error) {
    logger.error('Failed to inject malformed media:', error);
    throw error;
  }
}

async function chaosNetworkDown(): Promise<void> {
  logger.warn('🌐 CHAOS: Simulating network failure (2 minutes)...');

  // Note: This is a simulation only. In a real environment, you would:
  // 1. Add firewall rules to block outbound HTTPS
  // 2. Inject DNS failures
  // 3. Use network chaos tools (Chaos Mesh, Toxiproxy, etc.)

  // For this soak test, we rely on the existing mock mode + random failures
  // which are already injected at 2-3% rate

  logger.log(
    '  ⚠️  Network simulation relies on MOCK_LINKEDIN_PUBLISH random failures',
  );
  logger.log('  ⏳ Simulating 2-minute network degradation...');

  await logChaosEvent('network_down_start', {
    duration_ms: 120000,
    note: 'Simulation via existing mock failure rate',
  });

  await new Promise((resolve) => setTimeout(resolve, 120000));

  logger.log('  ✅ Network "recovered" (simulation ended)');

  await logChaosEvent('network_down_end', {
    note: 'Simulation ended',
  });
}

async function logChaosEvent(
  eventType: string,
  details: Record<string, any>,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    event: eventType,
    details,
  };

  // Append to chaos-events.log
  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(process.cwd(), 'chaos-events.log');

  fs.appendFileSync(
    logPath,
    JSON.stringify(logEntry, null, 2) + '\n',
    'utf8',
  );

  logger.log(`  📝 Logged chaos event: ${eventType}`);
}

// Run chaos injection
main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
