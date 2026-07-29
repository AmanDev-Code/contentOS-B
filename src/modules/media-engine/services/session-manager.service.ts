import { Injectable, Logger } from '@nestjs/common';

import {
  Session,
  Platform,
  SessionHealth,
  DeviceFingerprint,
  CookieJar,
  HeaderProfile,
  REDIS_KEYS,
  DEFAULT_SESSION_CONFIG,
  INSTAGRAM,
} from '../core';
import { CacheService } from '../../../services/cache.service';
import { DeviceManagerService } from './device-manager.service';
import { CookieManagerService } from './cookie-manager.service';
import { MediaEngineAlertService } from './alert.service';

/**
 * Session Manager — Full session object lifecycle.
 *
 * A session is the atomic unit of platform interaction:
 * cookies + headers + device + proxy + health + cooldown state.
 *
 * Stored in Redis with 7-day TTL. Headers are always derived from
 * the device fingerprint to maintain consistency.
 */
@Injectable()
export class SessionManagerService {
  private readonly logger = new Logger(SessionManagerService.name);

  constructor(
    private readonly cache: CacheService,
    private readonly deviceManager: DeviceManagerService,
    private readonly cookieManager: CookieManagerService,
    private readonly alerts: MediaEngineAlertService,
  ) {}

  /**
   * Create a new session for an account.
   * Generates device fingerprint (or retrieves existing) and builds headers.
   */
  async create(
    accountId: string,
    platform: Platform,
    cookies: Record<string, string>,
    proxy?: string,
  ): Promise<Session> {
    const device = await this.deviceManager.getOrCreate(accountId);
    const cookieJar = await this.cookieManager.store(accountId, platform, cookies);
    const headers = this.buildHeaders(device, cookieJar);

    const session: Session = {
      accountId,
      platform,
      cookies: cookieJar,
      headers,
      device,
      proxy,
      lastUsed: new Date().toISOString(),
      health: 'healthy',
      cooldownUntil: undefined,
      failedRequests: 0,
      consecutiveFailures: 0,
      totalRequests: 0,
      createdAt: new Date().toISOString(),
    };

    await this.save(session);
    this.logger.log(`Created session for ${accountId} on ${platform}`);
    return session;
  }

  /**
   * Get a session by account and platform.
   */
  async get(accountId: string, platform: Platform): Promise<Session | null> {
    const key = this.buildKey(platform, accountId);
    return (await this.cache.get(key)) as Session | null;
  }

  /**
   * Save/update a session in Redis.
   */
  async save(session: Session): Promise<void> {
    const key = this.buildKey(session.platform, session.accountId);
    await this.cache.set(key, session, DEFAULT_SESSION_CONFIG.sessionTtlSeconds);
  }

  /**
   * Mark a session as used (updates lastUsed timestamp and request count).
   */
  async markUsed(session: Session): Promise<Session> {
    session.lastUsed = new Date().toISOString();
    session.totalRequests++;
    await this.save(session);
    return session;
  }

  /**
   * Record a successful request (resets consecutive failures).
   */
  async recordSuccess(session: Session): Promise<Session> {
    session.consecutiveFailures = 0;
    session.health = 'healthy';
    session.cooldownUntil = undefined;
    await this.save(session);
    return session;
  }

  /**
   * Record a failed request. May trigger cooldown or mark dead.
   */
  async recordFailure(session: Session, rateLimited: boolean): Promise<Session> {
    session.failedRequests++;
    session.consecutiveFailures++;

    if (session.consecutiveFailures >= DEFAULT_SESSION_CONFIG.maxConsecutiveFailures) {
      session.health = 'dead';
      this.logger.warn(
        `Session ${session.accountId} marked DEAD after ${session.consecutiveFailures} failures`,
      );
      this.alerts.emitSessionDead(session.accountId, session.platform, session.consecutiveFailures);
    } else if (rateLimited) {
      session.health = 'cooldown';
      const cooldownMs = Math.min(
        30_000 * Math.pow(2, session.consecutiveFailures - 1),
        900_000,
      );
      session.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
      this.logger.warn(
        `Session ${session.accountId} in cooldown for ${cooldownMs / 1000}s`,
      );
      this.alerts.emitCooldown(session.accountId, session.platform, cooldownMs, session.consecutiveFailures);
    }

    await this.save(session);
    return session;
  }

  /**
   * Mark a session as checkpoint (Instagram challenge detected).
   */
  async markCheckpoint(session: Session): Promise<Session> {
    session.health = 'checkpoint';
    await this.save(session);
    this.logger.error(
      `Session ${session.accountId} hit CHECKPOINT — needs manual resolution`,
    );
    this.alerts.emitCheckpoint(session.accountId, session.platform);
    return session;
  }

  /**
   * Update session health status.
   */
  async setHealth(
    accountId: string,
    platform: Platform,
    health: SessionHealth,
  ): Promise<void> {
    const session = await this.get(accountId, platform);
    if (!session) return;

    session.health = health;
    if (health === 'healthy') {
      session.cooldownUntil = undefined;
      session.consecutiveFailures = 0;
    }
    await this.save(session);
  }

  /**
   * Update cookies for an existing session.
   */
  async updateCookies(
    accountId: string,
    platform: Platform,
    cookies: Record<string, string>,
  ): Promise<Session | null> {
    const session = await this.get(accountId, platform);
    if (!session) return null;

    const jar = await this.cookieManager.merge(accountId, platform, cookies);
    if (jar) {
      session.cookies = jar;
      session.headers = this.buildHeaders(session.device, jar);
      await this.save(session);
    }
    return session;
  }

  /**
   * Check if a session is currently usable (healthy and not in cooldown).
   */
  isUsable(session: Session): boolean {
    if (session.health === 'dead' || session.health === 'checkpoint') {
      return false;
    }

    if (session.health === 'cooldown' && session.cooldownUntil) {
      return new Date(session.cooldownUntil) <= new Date();
    }

    return true;
  }

  /**
   * Delete a session.
   */
  async delete(accountId: string, platform: Platform): Promise<void> {
    const key = this.buildKey(platform, accountId);
    await this.cache.delete(key);
    this.logger.log(`Deleted session for ${accountId} on ${platform}`);
  }

  /**
   * List all sessions for a platform.
   * Note: Uses key pattern scan — acceptable for small session counts (<100).
   */
  async listAll(platform: Platform): Promise<Session[]> {
    const pattern = `${REDIS_KEYS.SESSION}:${platform}:*`;
    const keys = await this.cache.getKeysByPattern(pattern);
    if (keys.length === 0) return [];

    const sessions: Session[] = [];
    for (const key of keys) {
      const data = await this.cache.get(key);
      if (data) {
        sessions.push(data as Session);
      }
    }

    return sessions;
  }

  /**
   * Build platform-specific headers from device fingerprint and cookies.
   */
  private buildHeaders(device: DeviceFingerprint, cookieJar: CookieJar): HeaderProfile {
    const csrfToken = cookieJar.cookies['csrftoken'] || '';
    const mid = cookieJar.cookies['mid'] || '';

    return {
      'User-Agent': device.userAgent,
      'X-IG-Device-ID': device.uuid,
      'X-IG-Android-ID': device.deviceId,
      'X-IG-App-ID': INSTAGRAM.APP_ID,
      'X-MID': mid,
      'X-CSRF-Token': csrfToken,
      'X-IG-App-Locale': 'en_US',
      'X-IG-Device-Locale': 'en_US',
      'X-IG-Mapped-Locale': 'en_US',
      'X-Pigeon-Session-Id': `UFS-${device.uuid}-0`,
      'X-Pigeon-Rawclienttime': String(Date.now() / 1000),
      'X-IG-Connection-Speed': '-1kbps',
      'X-IG-Bandwidth-Speed-KBPS': '-1.000',
      'X-IG-Bandwidth-TotalBytes-B': '0',
      'X-IG-Bandwidth-TotalTime-MS': '0',
      'X-IG-Connection-Type': 'WIFI',
      'X-IG-Capabilities': '3brTvx0=',
      'Accept-Language': 'en-US',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
  }

  private buildKey(platform: Platform, accountId: string): string {
    return `${REDIS_KEYS.SESSION}:${platform}:${accountId}`;
  }
}
