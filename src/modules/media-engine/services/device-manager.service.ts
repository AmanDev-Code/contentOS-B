import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import {
  DeviceFingerprint,
  REDIS_KEYS,
  DEFAULT_SESSION_CONFIG,
  INSTAGRAM,
} from '../core';
import { CacheService } from '../../../services/cache.service';

/**
 * Device Manager — Persistent per-account device fingerprints.
 *
 * Key principle: NEVER regenerate a device fingerprint once created.
 * Instagram tracks device_id ↔ account associations. Changing device = checkpoint.
 *
 * Stores in Redis (DragonflyDB) with effectively infinite TTL (365 days).
 */
@Injectable()
export class DeviceManagerService {
  private readonly logger = new Logger(DeviceManagerService.name);

  constructor(private readonly cache: CacheService) {}

  /**
   * Get or create a persistent device fingerprint for an account.
   * If one exists in Redis, return it. Never regenerate.
   */
  async getOrCreate(accountId: string): Promise<DeviceFingerprint> {
    const key = `${REDIS_KEYS.DEVICE}:${accountId}`;
    const existing = await this.cache.get(key);

    if (existing) {
      return existing as DeviceFingerprint;
    }

    const device = this.generateFingerprint();
    await this.cache.set(key, device, DEFAULT_SESSION_CONFIG.deviceTtlSeconds);

    this.logger.log(`Created new device fingerprint for account: ${accountId}`);
    return device;
  }

  /**
   * Get an existing fingerprint. Returns null if none exists.
   */
  async get(accountId: string): Promise<DeviceFingerprint | null> {
    const key = `${REDIS_KEYS.DEVICE}:${accountId}`;
    return (await this.cache.get(key)) as DeviceFingerprint | null;
  }

  /**
   * Explicitly store a fingerprint (for importing from external sources).
   */
  async set(accountId: string, device: DeviceFingerprint): Promise<void> {
    const key = `${REDIS_KEYS.DEVICE}:${accountId}`;
    await this.cache.set(key, device, DEFAULT_SESSION_CONFIG.deviceTtlSeconds);
    this.logger.log(`Stored device fingerprint for account: ${accountId}`);
  }

  /**
   * Check if a device fingerprint exists for an account.
   */
  async exists(accountId: string): Promise<boolean> {
    const key = `${REDIS_KEYS.DEVICE}:${accountId}`;
    return (await this.cache.get(key)) !== null;
  }

  /**
   * Generate a realistic Android device fingerprint.
   * Based on common Samsung Galaxy devices (most popular on Instagram).
   */
  private generateFingerprint(): DeviceFingerprint {
    const devices = [
      { manufacturer: 'samsung', model: 'SM-G991B' },
      { manufacturer: 'samsung', model: 'SM-S908B' },
      { manufacturer: 'samsung', model: 'SM-S918B' },
      { manufacturer: 'samsung', model: 'SM-A546B' },
      { manufacturer: 'Google', model: 'Pixel 7 Pro' },
      { manufacturer: 'Google', model: 'Pixel 8' },
      { manufacturer: 'OnePlus', model: 'IN2025' },
    ];

    const androidVersions = [
      { version: '13', sdk: '33' },
      { version: '14', sdk: '34' },
    ];

    const device = devices[Math.floor(Math.random() * devices.length)];
    const android = androidVersions[Math.floor(Math.random() * androidVersions.length)];

    const deviceId = `android-${this.randomHex(16)}`;
    const phoneId = randomUUID();
    const uuid = randomUUID();
    const advertisingId = randomUUID();
    const familyDeviceId = randomUUID();
    const androidId = this.randomHex(16);

    const userAgent = [
      `Instagram ${INSTAGRAM.APP_VERSION}`,
      `Android (${android.sdk}/${android.version};`,
      `480dpi; 1080x2400; ${device.manufacturer};`,
      `${device.model}; ${device.model};`,
      `qcom; en_US; ${INSTAGRAM.VERSION_CODE})`,
    ].join(' ');

    return {
      deviceId,
      phoneId,
      uuid,
      advertisingId,
      familyDeviceId,
      androidId,
      androidVersion: android.sdk,
      androidRelease: android.version,
      manufacturer: device.manufacturer,
      model: device.model,
      appVersion: INSTAGRAM.APP_VERSION,
      versionCode: INSTAGRAM.VERSION_CODE,
      userAgent,
      createdAt: new Date().toISOString(),
    };
  }

  private randomHex(length: number): string {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  }
}
