import { Injectable } from '@nestjs/common';
import { CacheService } from './cache.service';

@Injectable()
export class IdempotencyService {
  constructor(private readonly cacheService: CacheService) {}

  private key(scope: string, key: string, userId: string): string {
    return `idempotency:${scope}:${userId}:${key}`;
  }

  async lock(
    scope: string,
    key: string,
    userId: string,
    ttlSeconds = 15 * 60,
  ): Promise<boolean> {
    return this.cacheService.setIfAbsent(
      this.key(scope, key, userId),
      { status: 'locked', at: new Date().toISOString() },
      ttlSeconds,
    );
  }

  async setResult(
    scope: string,
    key: string,
    userId: string,
    result: unknown,
    ttlSeconds = 24 * 60 * 60,
  ): Promise<void> {
    await this.cacheService.set(
      this.key(scope, key, userId),
      { status: 'completed', result, at: new Date().toISOString() },
      ttlSeconds,
    );
  }

  async getResult(scope: string, key: string, userId: string): Promise<any> {
    return this.cacheService.get(this.key(scope, key, userId));
  }
}

