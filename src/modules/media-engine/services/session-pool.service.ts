import { Injectable, Logger } from '@nestjs/common';

import {
  Session,
  Platform,
  RequestOutcome,
  PoolStats,
  REDIS_KEYS,
  DEFAULT_SESSION_CONFIG,
} from '../core';
import { CacheService } from '../../../services/cache.service';
import { SessionManagerService } from './session-manager.service';

/**
 * Session Pool — Multi-account rotation with health-aware selection.
 *
 * Acquires the healthiest, least-recently-used session from the pool.
 * Implements distributed locking to prevent concurrent use of same session.
 * Releases sessions with updated health/cooldown after use.
 */
@Injectable()
export class SessionPoolService {
  private readonly logger = new Logger(SessionPoolService.name);

  constructor(
    private readonly cache: CacheService,
    private readonly sessionManager: SessionManagerService,
  ) {}

  /**
   * Acquire a healthy session for the given platform.
   * Selection strategy: healthy → least recently used → not locked.
   * Returns null if no sessions are available.
   */
  async acquire(platform: Platform): Promise<Session | null> {
    const sessions = await this.sessionManager.listAll(platform);

    if (sessions.length === 0) {
      this.logger.warn(`No sessions available for platform: ${platform}`);
      return null;
    }

    // Filter to usable sessions and sort by lastUsed (oldest first = round-robin)
    const usable = sessions
      .filter((s) => this.sessionManager.isUsable(s))
      .sort((a, b) => new Date(a.lastUsed).getTime() - new Date(b.lastUsed).getTime());

    if (usable.length === 0) {
      this.logger.warn(
        `All ${sessions.length} sessions for ${platform} are unavailable`,
      );
      return null;
    }

    // Try to acquire a lock on each session in order
    for (const session of usable) {
      const locked = await this.tryLock(session.accountId);
      if (locked) {
        const updated = await this.sessionManager.markUsed(session);
        return updated;
      }
    }

    this.logger.warn(`All usable sessions for ${platform} are currently locked`);
    return null;
  }

  /**
   * Release a session back to the pool after use.
   * Updates health based on the request outcome.
   */
  async release(session: Session, outcome: RequestOutcome): Promise<void> {
    if (outcome.success) {
      await this.sessionManager.recordSuccess(session);
    } else if (outcome.checkpoint) {
      await this.sessionManager.markCheckpoint(session);
    } else {
      await this.sessionManager.recordFailure(session, outcome.rateLimited ?? false);
    }

    await this.releaseLock(session.accountId);
  }

  /**
   * Get statistics for the session pool.
   */
  async getStats(platform: Platform): Promise<PoolStats> {
    const sessions = await this.sessionManager.listAll(platform);

    const stats: PoolStats = {
      total: sessions.length,
      healthy: 0,
      cooldown: 0,
      dead: 0,
      checkpoint: 0,
    };

    for (const session of sessions) {
      switch (session.health) {
        case 'healthy':
          stats.healthy++;
          break;
        case 'cooldown':
          if (session.cooldownUntil && new Date(session.cooldownUntil) <= new Date()) {
            stats.healthy++;
          } else {
            stats.cooldown++;
          }
          break;
        case 'dead':
          stats.dead++;
          break;
        case 'checkpoint':
          stats.checkpoint++;
          break;
      }
    }

    return stats;
  }

  /**
   * Add a new session to the pool.
   */
  async addSession(
    accountId: string,
    platform: Platform,
    cookies: Record<string, string>,
    proxy?: string,
  ): Promise<Session> {
    return this.sessionManager.create(accountId, platform, cookies, proxy);
  }

  /**
   * Remove a session from the pool.
   */
  async removeSession(accountId: string, platform: Platform): Promise<void> {
    await this.sessionManager.delete(accountId, platform);
    await this.releaseLock(accountId);
    this.logger.log(`Removed session ${accountId} from ${platform} pool`);
  }

  /**
   * Get all sessions for admin/monitoring.
   */
  async listAll(platform: Platform): Promise<Session[]> {
    return this.sessionManager.listAll(platform);
  }

  /**
   * Revive sessions that were in cooldown but cooldown has expired.
   * Called periodically by the health checker.
   */
  async reviveExpiredCooldowns(platform: Platform): Promise<number> {
    const sessions = await this.sessionManager.listAll(platform);
    let revived = 0;

    for (const session of sessions) {
      if (
        session.health === 'cooldown' &&
        session.cooldownUntil &&
        new Date(session.cooldownUntil) <= new Date()
      ) {
        await this.sessionManager.setHealth(session.accountId, platform, 'healthy');
        revived++;
      }
    }

    if (revived > 0) {
      this.logger.log(`Revived ${revived} sessions from cooldown on ${platform}`);
    }

    return revived;
  }

  /**
   * Try to acquire a distributed lock for a session.
   */
  private async tryLock(accountId: string): Promise<boolean> {
    const key = `${REDIS_KEYS.LOCK}:${accountId}`;
    return this.cache.setIfAbsent(key, Date.now(), DEFAULT_SESSION_CONFIG.lockTtlSeconds);
  }

  /**
   * Release the lock for a session.
   */
  private async releaseLock(accountId: string): Promise<void> {
    const key = `${REDIS_KEYS.LOCK}:${accountId}`;
    await this.cache.delete(key);
  }
}
