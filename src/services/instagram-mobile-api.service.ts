import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from './cache.service';
import {
  ScraperCredentialsService,
} from './scrapers/scraper-credentials.service';
import { SessionPoolService } from '../modules/media-engine/services/session-pool.service';
import { CircuitBreakerService } from '../modules/media-engine/services/circuit-breaker.service';
import axios from 'axios';
import * as crypto from 'crypto';

/**
 * Instagram Mobile API Service (instagrapi-style).
 *
 * Pretends to be the Instagram Android app to obtain long-lived sessions (90+ days).
 * Instagram trusts mobile app sessions more than web sessions, making this
 * significantly more reliable for automated access from server IPs.
 *
 * Flow:
 *  1. Generate a fake Android device fingerprint
 *  2. Login with username/password via i.instagram.com/api/v1/accounts/login/
 *  3. Handle 2FA challenge if required (returns challenge info for admin to complete)
 *  4. Store session token encrypted in Redis
 *  5. Auto-refresh before expiry
 */

const CACHE_KEY_DEVICE = 'ig:mobile:device';
const CACHE_KEY_SESSION = 'ig:mobile:session';
const CACHE_KEY_CHALLENGE = 'ig:mobile:challenge';
const SESSION_TTL = 60 * 60 * 24 * 90; // 90 days

const IG_API_BASE = 'https://i.instagram.com/api/v1';
const IG_APP_ID = '567067343352427'; // Instagram Android app ID

interface DeviceProfile {
  deviceId: string;
  phoneId: string;
  uuid: string;
  advertisingId: string;
  deviceString: string;
  appVersion: string;
  versionCode: string;
  userAgent: string;
}

interface MobileSession {
  sessionId: string;
  csrfToken: string;
  userId: string;
  username: string;
  mid: string;
  createdAt: string;
  expiresAt: string;
}

export interface MobileLoginResult {
  success: boolean;
  challengeRequired?: boolean;
  challengeType?: string; // 'sms' | 'email' | 'totp'
  message?: string;
  username?: string;
}

@Injectable()
export class InstagramMobileApiService {
  private readonly logger = new Logger(InstagramMobileApiService.name);

  constructor(
    private readonly cacheService: CacheService,
    private readonly credentials: ScraperCredentialsService,
    private readonly sessionPool: SessionPoolService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  /**
   * Generate or retrieve a persistent device fingerprint.
   * Reusing the same device profile avoids "new device" challenges.
   */
  async getOrCreateDevice(): Promise<DeviceProfile> {
    const cached = await this.cacheService.get(CACHE_KEY_DEVICE);
    if (cached) return cached as DeviceProfile;

    const device = this.generateDevice();
    await this.cacheService.set(CACHE_KEY_DEVICE, device, SESSION_TTL);
    return device;
  }

  /**
   * Login to Instagram via the Android Mobile API.
   * Returns success or challenge info if 2FA is required.
   */
  async login(username: string, password: string): Promise<MobileLoginResult> {
    const device = await this.getOrCreateDevice();

    const encPassword = this.encryptPassword(password);
    const signedBody = this.generateSignedBody({
      jazoest: this.generateJazoest(device.phoneId),
      phone_id: device.phoneId,
      _csrftoken: 'missing',
      username,
      guid: device.uuid,
      device_id: device.deviceId,
      password: encPassword,
      login_attempt_count: '0',
    });

    try {
      const response = await axios.post(
        `${IG_API_BASE}/accounts/login/`,
        signedBody,
        {
          headers: this.buildHeaders(device),
          timeout: 15000,
          validateStatus: () => true,
        },
      );

      const data = response.data;

      // Success
      if (data.logged_in_user) {
        const session = this.extractSession(response, data, device);
        await this.saveSession(session);
        await this.syncToScraperCredentials(session);

        this.logger.log(
          `Mobile API login successful for @${data.logged_in_user.username}`,
        );

        return {
          success: true,
          username: data.logged_in_user.username,
          message: 'Login successful. Session saved.',
        };
      }

      // Challenge required (2FA)
      if (data.two_factor_required) {
        const challengeInfo = {
          twoFactorIdentifier: data.two_factor_info?.two_factor_identifier,
          methods: data.two_factor_info?.totp_two_factor_on
            ? 'totp'
            : data.two_factor_info?.sms_two_factor_on
              ? 'sms'
              : 'email',
          phoneNumber: data.two_factor_info?.obfuscated_phone_number,
          username,
        };

        await this.cacheService.set(CACHE_KEY_CHALLENGE, challengeInfo, 600); // 10 min TTL

        return {
          success: false,
          challengeRequired: true,
          challengeType: challengeInfo.methods,
          message: `2FA required (${challengeInfo.methods}). Enter the code to complete login.`,
        };
      }

      // Challenge (suspicious login — verify identity)
      if (data.message === 'challenge_required') {
        return {
          success: false,
          challengeRequired: true,
          challengeType: 'verification',
          message:
            'Instagram requires identity verification. Check your email/phone for a security code.',
        };
      }

      // Bad credentials
      if (data.message === 'The password you entered is incorrect') {
        return { success: false, message: 'Incorrect password.' };
      }

      if (data.message?.includes('username you entered')) {
        return { success: false, message: 'Username not found.' };
      }

      // Generic failure
      return {
        success: false,
        message: data.message || 'Login failed. Please try again.',
      };
    } catch (error) {
      this.logger.error(
        `Mobile API login error: ${(error as Error).message}`,
      );
      return {
        success: false,
        message: `Login request failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Complete 2FA challenge with the code from SMS/email/TOTP.
   */
  async verify2FA(code: string): Promise<MobileLoginResult> {
    const challenge = await this.cacheService.get(CACHE_KEY_CHALLENGE);
    if (!challenge) {
      return {
        success: false,
        message: 'No pending challenge. Please login again.',
      };
    }

    const { twoFactorIdentifier, username } = challenge as any;
    const device = await this.getOrCreateDevice();

    const body = this.generateSignedBody({
      two_factor_identifier: twoFactorIdentifier,
      username,
      verification_code: code,
      trust_this_device: '1',
      device_id: device.deviceId,
    });

    try {
      const response = await axios.post(
        `${IG_API_BASE}/accounts/two_factor_login/`,
        body,
        {
          headers: this.buildHeaders(device),
          timeout: 15000,
          validateStatus: () => true,
        },
      );

      const data = response.data;

      if (data.logged_in_user) {
        const session = this.extractSession(response, data, device);
        await this.saveSession(session);
        await this.syncToScraperCredentials(session);
        await this.cacheService.delete(CACHE_KEY_CHALLENGE);

        this.logger.log(
          `2FA verified for @${data.logged_in_user.username}`,
        );

        return {
          success: true,
          username: data.logged_in_user.username,
          message: '2FA verified. Session saved.',
        };
      }

      return {
        success: false,
        message: data.message || 'Invalid verification code.',
      };
    } catch (error) {
      return {
        success: false,
        message: `2FA verification failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Check if we have a valid mobile session stored.
   */
  async getSessionStatus(): Promise<{
    hasSession: boolean;
    username?: string;
    expiresAt?: string;
  }> {
    const session = (await this.cacheService.get(
      CACHE_KEY_SESSION,
    )) as MobileSession | null;
    if (!session) return { hasSession: false };

    return {
      hasSession: true,
      username: session.username,
      expiresAt: session.expiresAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private generateDevice(): DeviceProfile {
    const deviceId = `android-${crypto.randomBytes(8).toString('hex')}`;
    const phoneId = crypto.randomUUID();
    const uuid = crypto.randomUUID();
    const advertisingId = crypto.randomUUID();

    return {
      deviceId,
      phoneId,
      uuid,
      advertisingId,
      deviceString: '33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100',
      appVersion: '382.0.0.42.112',
      versionCode: '604247862',
      userAgent: `Instagram 382.0.0.42.112 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 604247862)`,
    };
  }

  private buildHeaders(device: DeviceProfile): Record<string, string> {
    return {
      'User-Agent': device.userAgent,
      'X-IG-App-ID': IG_APP_ID,
      'X-IG-Device-ID': device.uuid,
      'X-IG-Android-ID': device.deviceId,
      'X-FB-HTTP-Engine': 'Liger',
      'X-FB-Client-IP': 'True',
      'X-FB-Server-Cluster': 'True',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Connection: 'keep-alive',
    };
  }

  private encryptPassword(password: string): string {
    // Instagram uses a simple time-based password encoding
    const time = Math.floor(Date.now() / 1000).toString();
    return `#PWD_INSTAGRAM:0:${time}:${password}`;
  }

  private generateSignedBody(data: Record<string, string>): string {
    // Instagram's signed body format for mobile API
    const json = JSON.stringify(data);
    const signature =
      'SIGNATURE.' + encodeURIComponent(json);
    return `signed_body=${signature}`;
  }

  private generateJazoest(phoneId: string): string {
    let sum = 0;
    for (const char of `22${phoneId}`) {
      sum += char.charCodeAt(0);
    }
    return `22${sum}`;
  }

  private extractSession(
    response: any,
    data: any,
    device: DeviceProfile,
  ): MobileSession {
    // Extract session cookies from response headers
    const cookies = response.headers['set-cookie'] || [];
    const cookieMap: Record<string, string> = {};
    for (const cookie of cookies) {
      const match = cookie.match(/^([^=]+)=([^;]+)/);
      if (match) cookieMap[match[1]] = match[2];
    }

    const now = new Date();
    const expires = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days

    return {
      sessionId: cookieMap['sessionid'] || '',
      csrfToken: cookieMap['csrftoken'] || '',
      userId: data.logged_in_user?.pk_id?.toString() || cookieMap['ds_user_id'] || '',
      username: data.logged_in_user?.username || '',
      mid: cookieMap['mid'] || device.uuid,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    };
  }

  private async saveSession(session: MobileSession): Promise<void> {
    await this.cacheService.set(CACHE_KEY_SESSION, session, SESSION_TTL);
  }

  /**
   * Sync the mobile session cookies back to the main ScraperCredentialsService
   * so the Instagram Reel Downloader (and trending scraper) can use them.
   * Also pushes to the Media Engine session pool + resets circuit breakers.
   */
  private async syncToScraperCredentials(
    session: MobileSession,
  ): Promise<void> {
    // Legacy credential store (trending scraper)
    await this.credentials.save({
      instagramSession: session.sessionId,
      instagramCsrfToken: session.csrfToken,
      instagramDsUserId: session.userId,
      instagramMid: session.mid,
    });

    // Media Engine session pool (reel downloader)
    try {
      const cookies: Record<string, string> = {
        sessionid: session.sessionId,
        csrftoken: session.csrfToken,
        ds_user_id: session.userId,
        mid: session.mid,
      };
      await this.sessionPool.addSession(session.userId, 'instagram', cookies);

      // Reset all circuit breakers — fresh login = clean slate
      const engines = ['private-api', 'mobile-api', 'browser', 'embed', 'oembed'] as const;
      for (const engine of engines) {
        await this.circuitBreaker.reset(engine);
      }
      this.logger.log(
        `Mobile session pushed to media engine pool + circuits reset for @${session.username}`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to push mobile session to pool: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `Mobile session synced to ScraperCredentials for @${session.username}`,
    );
  }
}
