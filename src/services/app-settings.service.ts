import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from './cache.service';
import { SupabaseService } from './supabase.service';

const SETTINGS_CACHE_PREFIX = 'app:settings:';
const SETTINGS_CACHE_TTL = 3600; // 1 hour

export interface AppSetting {
  key: string;
  value: unknown;
  updated_at: string;
  updated_by?: string;
}

export const APP_SETTING_KEYS = {
  FREE_CREDIT_LIMIT: 'free_credit_limit',
  /** Default + supported currencies for marketing / billing UI (checkout still uses Paddle). */
  PRICING_DISPLAY: 'pricing_display',
} as const;

@Injectable()
export class AppSettingsService {
  private readonly logger = new Logger(AppSettingsService.name);

  constructor(
    private readonly cacheService: CacheService,
    private readonly supabaseService: SupabaseService,
  ) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const cacheKey = `${SETTINGS_CACHE_PREFIX}${key}`;

    const cached = await this.cacheService.get(cacheKey);
    if (cached !== null) {
      return cached as T;
    }

    try {
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('app_settings')
        .select('value')
        .eq('key', key)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return null;
        }
        this.logger.error(`Failed to get setting ${key}: ${error.message}`);
        return null;
      }

      const value = data?.value as T;
      await this.cacheService.set(cacheKey, value, SETTINGS_CACHE_TTL);
      return value;
    } catch (error) {
      this.logger.error(`Error getting setting ${key}:`, error);
      return null;
    }
  }

  async set<T = unknown>(
    key: string,
    value: T,
    updatedBy?: string,
  ): Promise<boolean> {
    try {
      const { error } = await this.supabaseService
        .getServiceClient()
        .from('app_settings')
        .upsert(
          {
            key,
            value,
            updated_at: new Date().toISOString(),
            updated_by: updatedBy,
          },
          { onConflict: 'key' },
        );

      if (error) {
        this.logger.error(`Failed to set setting ${key}: ${error.message}`);
        return false;
      }

      const cacheKey = `${SETTINGS_CACHE_PREFIX}${key}`;
      await this.cacheService.set(cacheKey, value, SETTINGS_CACHE_TTL);

      return true;
    } catch (error) {
      this.logger.error(`Error setting ${key}:`, error);
      return false;
    }
  }

  async getFreeCreditLimit(): Promise<number> {
    const value = await this.get<number>(APP_SETTING_KEYS.FREE_CREDIT_LIMIT);
    return value ?? 50; // Default to 50 if not set
  }

  async setFreeCreditLimit(limit: number, updatedBy?: string): Promise<boolean> {
    if (limit < 0 || !Number.isInteger(limit)) {
      this.logger.warn(`Invalid free credit limit: ${limit}`);
      return false;
    }
    return this.set(APP_SETTING_KEYS.FREE_CREDIT_LIMIT, limit, updatedBy);
  }

  async invalidateCache(key: string): Promise<void> {
    const cacheKey = `${SETTINGS_CACHE_PREFIX}${key}`;
    await this.cacheService.delete(cacheKey);
  }
}
