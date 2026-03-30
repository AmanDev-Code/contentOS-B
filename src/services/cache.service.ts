import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

const CACHE_PREFIX = 'app:cache:';

@Injectable()
export class CacheService implements OnModuleInit {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis | null = null;
  private fallback = new Map<string, { data: any; expires: number }>();

  async onModuleInit() {
    try {
      this.redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 200, 3000),
        lazyConnect: true,
      });

      await this.redis.connect();
      this.logger.log('Redis cache connected');
    } catch (error) {
      this.logger.warn('Redis unavailable, using in-memory fallback:', error.message);
      this.redis = null;
    }
  }

  async get(key: string): Promise<any | null> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(CACHE_PREFIX + key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        this.logger.warn(`Redis GET failed for ${key}: ${e.message}`);
      }
    }

    const item = this.fallback.get(key);
    if (!item) return null;
    if (Date.now() > item.expires) {
      this.fallback.delete(key);
      return null;
    }
    return item.data;
  }

  async set(key: string, data: any, ttlSeconds = 300): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(CACHE_PREFIX + key, JSON.stringify(data), 'EX', ttlSeconds);
        return;
      } catch (e) {
        this.logger.warn(`Redis SET failed for ${key}: ${e.message}`);
      }
    }
    this.fallback.set(key, { data, expires: Date.now() + ttlSeconds * 1000 });
  }

  async setIfAbsent(
    key: string,
    data: any,
    ttlSeconds = 300,
  ): Promise<boolean> {
    if (this.redis) {
      try {
        const result = await this.redis.set(
          CACHE_PREFIX + key,
          JSON.stringify(data),
          'EX',
          ttlSeconds,
          'NX',
        );
        return result === 'OK';
      } catch (e) {
        this.logger.warn(`Redis SETNX failed for ${key}: ${e.message}`);
      }
    }

    const existing = this.fallback.get(key);
    if (existing && Date.now() <= existing.expires) {
      return false;
    }
    this.fallback.set(key, { data, expires: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  async delete(key: string): Promise<boolean> {
    if (this.redis) {
      try {
        const result = await this.redis.del(CACHE_PREFIX + key);
        return result > 0;
      } catch (e) {
        this.logger.warn(`Redis DEL failed for ${key}: ${e.message}`);
      }
    }
    return this.fallback.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let count = 0;

    if (this.redis) {
      try {
        const keys = await this.redis.keys(CACHE_PREFIX + prefix + '*');
        if (keys.length > 0) {
          count = await this.redis.del(...keys);
        }
        return count;
      } catch (e) {
        this.logger.warn(`Redis deleteByPrefix failed: ${e.message}`);
      }
    }

    for (const key of this.fallback.keys()) {
      if (key.startsWith(prefix)) {
        this.fallback.delete(key);
        count++;
      }
    }
    return count;
  }

  async invalidateUser(userId: string): Promise<number> {
    return this.deleteByPrefix(`user:${userId}:`);
  }

  async clear(): Promise<void> {
    if (this.redis) {
      try {
        const keys = await this.redis.keys(CACHE_PREFIX + '*');
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
        return;
      } catch (e) {
        this.logger.warn(`Redis clear failed: ${e.message}`);
      }
    }
    this.fallback.clear();
  }

  getStats(): { size: number; keys: string[] } {
    return {
      size: this.fallback.size,
      keys: Array.from(this.fallback.keys()),
    };
  }
}
