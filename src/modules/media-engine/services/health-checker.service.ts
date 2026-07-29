import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';

import {
  Platform,
  HealthCheckResult,
  Session,
  REDIS_KEYS,
  INSTAGRAM,
} from '../core';
import { CacheService } from '../../../services/cache.service';
import { SessionPoolService } from '../services/session-pool.service';
import { SessionManagerService } from '../services/session-manager.service';

/**
 * Health Checker — Periodic session health probing.
 *
 * Every 5 minutes, checks all sessions by making a lightweight request
 * (GET own profile) to detect dead/expired sessions.
 *
 * Also revives sessions whose cooldown period has expired.
 */
@Injectable()
export class HealthCheckerService {
  private readonly logger = new Logger(HealthCheckerService.name);

  constructor(
    private readonly cache: CacheService,
    private readonly sessionPool: SessionPoolService,
    private readonly sessionManager: SessionManagerService,
  ) {}

  /**
   * Cron job: Check all Instagram sessions every 5 minutes.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkAllSessions(): Promise<void> {
    this.logger.debug('Running health check on all sessions...');

    const platforms: Platform[] = ['instagram'];

    for (const platform of platforms) {
      await this.checkPlatformSessions(platform);
    }
  }

  /**
   * Check all sessions for a specific platform.
   */
  async checkPlatformSessions(platform: Platform): Promise<HealthCheckResult[]> {
    const sessions = await this.sessionPool.listAll(platform);
    const results: HealthCheckResult[] = [];

    // Revive expired cooldowns first
    await this.sessionPool.reviveExpiredCooldowns(platform);

    for (const session of sessions) {
      // Skip dead and checkpoint sessions — they need manual intervention
      if (session.health === 'dead' || session.health === 'checkpoint') {
        continue;
      }

      // Skip sessions in active cooldown
      if (
        session.health === 'cooldown' &&
        session.cooldownUntil &&
        new Date(session.cooldownUntil) > new Date()
      ) {
        continue;
      }

      const result = await this.checkSession(session);
      results.push(result);

      // Update session health based on probe result
      if (!result.healthy) {
        await this.sessionManager.recordFailure(session, false);
        this.logger.warn(
          `Health check FAILED for ${session.accountId}: ${result.error}`,
        );
      } else if (session.health !== 'healthy') {
        // Session recovered
        await this.sessionManager.setHealth(session.accountId, platform, 'healthy');
        this.logger.log(`Session ${session.accountId} recovered to healthy`);
      }

      // Store health check result
      await this.storeResult(session.accountId, result);
    }

    const healthyCount = results.filter((r) => r.healthy).length;
    this.logger.debug(
      `Health check complete for ${platform}: ${healthyCount}/${results.length} healthy`,
    );

    return results;
  }

  /**
   * Probe a single session by making a lightweight authenticated request.
   * For Instagram: GET /api/v1/accounts/current_user/ (returns user info if session valid).
   */
  private async checkSession(session: Session): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const response = await axios.get(
        `${INSTAGRAM.PRIVATE_API_URL}/accounts/current_user/?edit=true`,
        {
          headers: {
            ...session.headers,
            'Cookie': Object.entries(session.cookies.cookies)
              .map(([name, value]) => `${name}=${value}`)
              .join('; '),
          },
          timeout: 10_000,
          validateStatus: () => true, // Don't throw on non-2xx
        },
      );

      const latencyMs = Date.now() - startTime;
      const status = response.status;

      if (status === 200) {
        return {
          accountId: session.accountId,
          healthy: true,
          statusCode: status,
          latencyMs,
          checkedAt: new Date().toISOString(),
        };
      }

      if (status === 429) {
        return {
          accountId: session.accountId,
          healthy: false,
          statusCode: status,
          latencyMs,
          checkedAt: new Date().toISOString(),
          error: 'Rate limited during health check',
        };
      }

      return {
        accountId: session.accountId,
        healthy: false,
        statusCode: status,
        latencyMs,
        checkedAt: new Date().toISOString(),
        error: `Unexpected status: ${status}`,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);

      return {
        accountId: session.accountId,
        healthy: false,
        latencyMs,
        checkedAt: new Date().toISOString(),
        error: message,
      };
    }
  }

  /**
   * Store health check result in Redis for monitoring.
   */
  private async storeResult(
    accountId: string,
    result: HealthCheckResult,
  ): Promise<void> {
    const key = `${REDIS_KEYS.HEALTH}:${accountId}`;
    // Store for 1 hour (overwritten every 5 minutes)
    await this.cache.set(key, result, 3600);
  }

  /**
   * Get the last health check result for an account (admin/monitoring).
   */
  async getLastResult(accountId: string): Promise<HealthCheckResult | null> {
    const key = `${REDIS_KEYS.HEALTH}:${accountId}`;
    return (await this.cache.get(key)) as HealthCheckResult | null;
  }
}
