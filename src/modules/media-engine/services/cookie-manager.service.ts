import { Injectable, Logger } from '@nestjs/common';

import { CookieJar, Platform, REDIS_KEYS, DEFAULT_SESSION_CONFIG } from '../core';
import { CacheService } from '../../../services/cache.service';

/**
 * Cookie Manager — Complete cookie jar storage per account.
 *
 * Key principle: Store ALL cookies, not just the 5 session cookies.
 * Instagram sets 20+ cookies; missing any triggers suspicion.
 *
 * Stores in Redis (DragonflyDB) with 30-day TTL.
 */
@Injectable()
export class CookieManagerService {
  private readonly logger = new Logger(CookieManagerService.name);

  constructor(private readonly cache: CacheService) {}

  /**
   * Store a complete cookie jar for an account.
   */
  async store(
    accountId: string,
    platform: Platform,
    cookies: Record<string, string>,
  ): Promise<CookieJar> {
    const key = this.buildKey(platform, accountId);

    const jar: CookieJar = {
      accountId,
      cookies,
      updatedAt: new Date().toISOString(),
      domain: this.getDomain(platform),
    };

    await this.cache.set(key, jar, DEFAULT_SESSION_CONFIG.cookieTtlSeconds);

    this.logger.debug(
      `Stored ${Object.keys(cookies).length} cookies for ${accountId} on ${platform}`,
    );

    return jar;
  }

  /**
   * Get the full cookie jar for an account.
   */
  async get(accountId: string, platform: Platform): Promise<CookieJar | null> {
    const key = this.buildKey(platform, accountId);
    return (await this.cache.get(key)) as CookieJar | null;
  }

  /**
   * Update specific cookies without replacing the whole jar.
   * Merges new cookies into existing jar.
   */
  async merge(
    accountId: string,
    platform: Platform,
    newCookies: Record<string, string>,
  ): Promise<CookieJar | null> {
    const existing = await this.get(accountId, platform);

    if (!existing) {
      return this.store(accountId, platform, newCookies);
    }

    const merged = { ...existing.cookies, ...newCookies };
    return this.store(accountId, platform, merged);
  }

  /**
   * Remove specific cookies from the jar.
   */
  async removeCookies(
    accountId: string,
    platform: Platform,
    cookieNames: string[],
  ): Promise<void> {
    const existing = await this.get(accountId, platform);
    if (!existing) return;

    for (const name of cookieNames) {
      delete existing.cookies[name];
    }

    await this.store(accountId, platform, existing.cookies);
  }

  /**
   * Delete the entire cookie jar for an account.
   */
  async delete(accountId: string, platform: Platform): Promise<void> {
    const key = this.buildKey(platform, accountId);
    await this.cache.delete(key);
    this.logger.log(`Deleted cookie jar for ${accountId} on ${platform}`);
  }

  /**
   * Check if a jar exists and is not empty.
   */
  async hasValidCookies(accountId: string, platform: Platform): Promise<boolean> {
    const jar = await this.get(accountId, platform);
    return jar !== null && Object.keys(jar.cookies).length > 0;
  }

  /**
   * Get the cookie header string (for HTTP requests).
   * Format: "name1=value1; name2=value2"
   */
  async getCookieHeader(accountId: string, platform: Platform): Promise<string | null> {
    const jar = await this.get(accountId, platform);
    if (!jar) return null;

    return Object.entries(jar.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  /**
   * Parse a Set-Cookie response header array into a cookie map.
   */
  parseCookieHeaders(setCookieHeaders: string[]): Record<string, string> {
    const cookies: Record<string, string> = {};

    for (const header of setCookieHeaders) {
      const parts = header.split(';')[0]?.trim();
      if (!parts) continue;

      const eqIndex = parts.indexOf('=');
      if (eqIndex === -1) continue;

      const name = parts.substring(0, eqIndex).trim();
      const value = parts.substring(eqIndex + 1).trim();

      if (name) {
        cookies[name] = value;
      }
    }

    return cookies;
  }

  private buildKey(platform: Platform, accountId: string): string {
    return `${REDIS_KEYS.COOKIES}:${platform}:${accountId}`;
  }

  private getDomain(platform: Platform): string {
    const domains: Record<Platform, string> = {
      instagram: '.instagram.com',
      tiktok: '.tiktok.com',
      youtube: '.youtube.com',
      twitter: '.twitter.com',
      linkedin: '.linkedin.com',
    };
    return domains[platform];
  }
}
