import { Injectable, Logger } from '@nestjs/common';

import {
  CooldownConfig,
  REDIS_KEYS,
  DEFAULT_COOLDOWN_CONFIG,
} from '../core';
import { CacheService } from '../../../services/cache.service';

/**
 * Cooldown Manager — Per-account request throttling.
 *
 * Enforces minimum intervals between requests to the same account.
 * Uses exponential backoff when rate-limited.
 * Prevents burst patterns that trigger Instagram's anti-automation.
 */
@Injectable()
export class CooldownManagerService {
  private readonly logger = new Logger(CooldownManagerService.name);
  private readonly config: CooldownConfig;

  constructor(private readonly cache: CacheService) {
    this.config = { ...DEFAULT_COOLDOWN_CONFIG };
  }

  /**
   * Check if an account can make a request right now.
   * Returns true if enough time has passed since the last request.
   */
  async canRequest(accountId: string): Promise<boolean> {
    const lastRequest = await this.getLastRequestTime(accountId);
    if (!lastRequest) return true;

    const elapsed = Date.now() - lastRequest;
    return elapsed >= this.config.minRequestIntervalMs;
  }

  /**
   * Get the time in ms until the account can make the next request.
   * Returns 0 if the account can request immediately.
   */
  async getWaitTime(accountId: string): Promise<number> {
    const lastRequest = await this.getLastRequestTime(accountId);
    if (!lastRequest) return 0;

    const elapsed = Date.now() - lastRequest;
    const remaining = this.config.minRequestIntervalMs - elapsed;
    return Math.max(0, remaining);
  }

  /**
   * Record that a request was made (updates the last-request timestamp).
   */
  async recordRequest(accountId: string): Promise<void> {
    const key = `${REDIS_KEYS.LAST_REQUEST}:${accountId}`;
    // Store timestamp with a short TTL (10 minutes — longer than any cooldown)
    await this.cache.set(key, Date.now(), 600);
  }

  /**
   * Apply a cooldown to an account (e.g., after a 429 response).
   * Uses exponential backoff based on consecutive failures.
   */
  async applyCooldown(accountId: string, consecutiveFailures: number): Promise<number> {
    const cooldownMs = this.calculateCooldown(consecutiveFailures);
    const key = `${REDIS_KEYS.COOLDOWN}:${accountId}`;
    const expiresAt = Date.now() + cooldownMs;

    // Store cooldown expiry; TTL = cooldown duration + 1 second buffer
    await this.cache.set(key, expiresAt, Math.ceil(cooldownMs / 1000) + 1);

    this.logger.warn(
      `Applied ${cooldownMs / 1000}s cooldown to account: ${accountId} (failure #${consecutiveFailures})`,
    );

    return cooldownMs;
  }

  /**
   * Check if an account is currently in cooldown.
   */
  async isInCooldown(accountId: string): Promise<boolean> {
    const key = `${REDIS_KEYS.COOLDOWN}:${accountId}`;
    const expiresAt = await this.cache.get(key);
    if (!expiresAt) return false;

    return Date.now() < (expiresAt as number);
  }

  /**
   * Get remaining cooldown time in ms. Returns 0 if not in cooldown.
   */
  async getRemainingCooldown(accountId: string): Promise<number> {
    const key = `${REDIS_KEYS.COOLDOWN}:${accountId}`;
    const expiresAt = await this.cache.get(key);
    if (!expiresAt) return 0;

    const remaining = (expiresAt as number) - Date.now();
    return Math.max(0, remaining);
  }

  /**
   * Clear cooldown for an account (manual override / recovery).
   */
  async clearCooldown(accountId: string): Promise<void> {
    const key = `${REDIS_KEYS.COOLDOWN}:${accountId}`;
    await this.cache.delete(key);
    this.logger.log(`Cleared cooldown for account: ${accountId}`);
  }

  /**
   * Wait until the account can make a request.
   * Returns immediately if no wait needed.
   * Use this before making a request to respect throttling.
   */
  async waitForSlot(accountId: string): Promise<void> {
    // Check cooldown first (takes priority)
    const cooldownRemaining = await this.getRemainingCooldown(accountId);
    if (cooldownRemaining > 0) {
      await this.sleep(cooldownRemaining);
      return;
    }

    // Check minimum interval
    const waitTime = await this.getWaitTime(accountId);
    if (waitTime > 0) {
      await this.sleep(waitTime);
    }
  }

  /**
   * Calculate cooldown duration with exponential backoff.
   */
  private calculateCooldown(consecutiveFailures: number): number {
    const cooldown =
      this.config.baseCooldownMs *
      Math.pow(this.config.backoffMultiplier, Math.max(0, consecutiveFailures - 1));

    return Math.min(cooldown, this.config.maxCooldownMs);
  }

  private async getLastRequestTime(accountId: string): Promise<number | null> {
    const key = `${REDIS_KEYS.LAST_REQUEST}:${accountId}`;
    const data = await this.cache.get(key);
    return data ? (data as number) : null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
