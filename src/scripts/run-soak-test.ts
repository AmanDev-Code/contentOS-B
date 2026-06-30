/**
 * Soak Test Runner (Sprint 1.10)
 *
 * Orchestrates the full soak test lifecycle:
 * 1. Enable mock mode
 * 2. Run seeder
 * 3. Wait for Day/Hour 4
 * 4. Run chaos injection (optional)
 * 5. Wait until Day/Hour 7
 * 6. Generate final report
 *
 * Usage:
 *   npm run soak-test:run              # 7-day run with chaos
 *   npm run soak-test:run:fast         # 7-hour run with chaos
 *   ts-node src/scripts/run-soak-test.ts --duration 7h --chaos false
 */

import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);
const logger = new Logger('SoakTestRunner');

interface RunnerOptions {
  duration: '7d' | '7h';
  chaos: boolean;
}

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  const options: RunnerOptions = {
    duration: args.includes('--duration')
      ? (args[args.indexOf('--duration') + 1] as '7d' | '7h')
      : '7d',
    chaos:
      args.includes('--chaos') &&
      args[args.indexOf('--chaos') + 1] === 'false'
        ? false
        : true,
  };

  const isFastForward = options.duration === '7h';
  const timeUnit = isFastForward ? 'hours' : 'days';
  const chaosDelay = isFastForward ? 4 * 3600000 : 4 * 86400000; // 4 hours or 4 days
  const totalDuration = isFastForward ? 7 * 3600000 : 7 * 86400000; // 7 hours or 7 days

  logger.log(`
╔═══════════════════════════════════════════════════════════════╗
║         🚀 SOAK TEST RUNNER (Sprint 1.10)                     ║
╠═══════════════════════════════════════════════════════════════╣
║  Duration: 7 ${timeUnit}                                          ║
║  Chaos injection: ${options.chaos ? 'ENABLED' : 'DISABLED'}                              ║
║  Fast-forward: ${isFastForward ? 'YES (7 hours)' : 'NO (7 days)'}                           ║
╚═══════════════════════════════════════════════════════════════╝
`);

  try {
    // Step 1: Verify MOCK_LINKEDIN_PUBLISH is enabled
    logger.log('📋 Step 1: Verifying mock mode...');
    await verifyMockMode();

    // Step 2: Run seeder
    logger.log('📋 Step 2: Running seeder...');
    await runSeeder(isFastForward);

    // Step 3: Wait for Day/Hour 4
    logger.log(`📋 Step 3: Waiting for ${timeUnit.slice(0, -1)} 4...`);
    await sleep(chaosDelay, 'Waiting for chaos injection point');

    // Step 4: Run chaos injection (optional)
    if (options.chaos) {
      logger.log('📋 Step 4: Running chaos injection...');
      await runChaos();
    } else {
      logger.log('📋 Step 4: Skipping chaos injection (disabled)');
    }

    // Step 5: Wait until end
    const remainingTime = totalDuration - chaosDelay;
    logger.log(`📋 Step 5: Waiting for test completion (${formatDuration(remainingTime)})...`);
    await sleep(remainingTime, 'Waiting for soak test completion');

    // Step 6: Generate final report
    logger.log('📋 Step 6: Generating final report...');
    await generateReport();

    logger.log(`
╔═══════════════════════════════════════════════════════════════╗
║              ✅ SOAK TEST COMPLETE                            ║
╠═══════════════════════════════════════════════════════════════╣
║  Total duration: 7 ${timeUnit}                                    ║
║  Chaos injected: ${options.chaos ? 'YES' : 'NO '}                                     ║
║                                                               ║
║  Report saved to: soak-test-reports/                          ║
║  View dashboard: http://localhost:5173/admin/soak-test       ║
╚═══════════════════════════════════════════════════════════════╝
`);
  } catch (error) {
    logger.error('❌ Soak test failed:', error);
    throw error;
  }
}

async function verifyMockMode(): Promise<void> {
  // Check .env for MOCK_LINKEDIN_PUBLISH
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error('.env file not found. Create one based on .env.example');
  }

  const envContent = fs.readFileSync(envPath, 'utf8');
  const mockEnabled = envContent.includes('MOCK_LINKEDIN_PUBLISH=true');

  if (!mockEnabled) {
    logger.warn('⚠️  MOCK_LINKEDIN_PUBLISH is not set to true in .env');
    logger.warn('   Posts will go to REAL LinkedIn unless you fix this!');
    logger.warn('   Add: MOCK_LINKEDIN_PUBLISH=true');
    throw new Error('Mock mode not enabled. Aborting to prevent real posts.');
  }

  logger.log('  ✅ Mock mode enabled (MOCK_LINKEDIN_PUBLISH=true)');
}

async function runSeeder(fastForward: boolean): Promise<void> {
  const command = fastForward
    ? 'npm run soak-test:seed:fast'
    : 'npm run soak-test:seed';

  logger.log(`  Running: ${command}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['run', fastForward ? 'soak-test:seed:fast' : 'soak-test:seed'], {
      stdio: 'inherit',
      shell: true,
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Seeder failed with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

async function runChaos(): Promise<void> {
  logger.log('  Running: npm run soak-test:chaos -- --all');

  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['run', 'soak-test:chaos', '--', '--all'], {
      stdio: 'inherit',
      shell: true,
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Chaos injection failed with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

async function generateReport(): Promise<void> {
  logger.log('  Generating report...');

  // Import and run report generator
  const { generateSoakTestReport } = await import('./soak-test-report-generator.js');
  const report = await generateSoakTestReport();

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .substring(0, 19);
  const reportPath = path.join(
    process.cwd(),
    'soak-test-reports',
    `${timestamp}.json`,
  );

  // Ensure directory exists
  const reportDir = path.join(process.cwd(), 'soak-test-reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  logger.log(`  ✅ Report saved: ${reportPath}`);

  // Print summary
  logger.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    SOAK TEST SUMMARY                          ║
╠═══════════════════════════════════════════════════════════════╣
║  Total posts: ${report.stats.totalScheduled.toString().padEnd(48)}║
║  Published: ${report.stats.published.toString().padEnd(50)}║
║  Failed: ${report.stats.failed.toString().padEnd(53)}║
║  Success rate: ${report.stats.successRate.toFixed(2)}%${' '.repeat(43)}║
║  Mean latency: ${report.stats.meanLatencySeconds.toFixed(1)}s${' '.repeat(43)}║
║  P95 latency: ${report.stats.p95LatencySeconds.toFixed(1)}s${' '.repeat(44)}║
║  DLQ count: ${report.stats.dlqCount.toString().padEnd(49)}║
║  Webhook success: ${report.stats.webhookSuccessRate.toFixed(1)}%${' '.repeat(39)}║
║                                                               ║
║  PASS/FAIL: ${report.passed ? '✅ PASSED' : '❌ FAILED'}${' '.repeat(44)}║
╚═══════════════════════════════════════════════════════════════╝
`);

  if (!report.passed) {
    logger.error('❌ Soak test FAILED criteria:');
    for (const failure of report.failures) {
      logger.error(`   - ${failure}`);
    }
  }
}

async function sleep(ms: number, message: string): Promise<void> {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    logger.log(`  ⏳ ${message}: ${hours}h ${minutes % 60}m`);
  } else {
    logger.log(`  ⏳ ${message}: ${minutes}m`);
  }

  // Show progress every 10 minutes (or 10 seconds in fast mode)
  const progressInterval = ms < 3600000 ? 10000 : 600000; // 10s or 10min
  const steps = Math.floor(ms / progressInterval);

  for (let i = 0; i < steps; i++) {
    await new Promise((resolve) => setTimeout(resolve, progressInterval));
    const elapsed = (i + 1) * progressInterval;
    const remaining = ms - elapsed;
    const progress = ((elapsed / ms) * 100).toFixed(0);
    logger.log(`  Progress: ${progress}% (${formatDuration(remaining)} remaining)`);
  }

  // Sleep remaining time
  const remaining = ms - steps * progressInterval;
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  } else {
    return `${seconds}s`;
  }
}

// Run soak test
main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
