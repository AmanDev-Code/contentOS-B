import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private cache = new Map<string, { data: any; expires: number }>();

  /**
   * Get data from cache
   */
  get(key: string): any | null {
    const item = this.cache.get(key);
    
    if (!item) {
      return null;
    }

    // Check if expired
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return null;
    }

    return item.data;
  }

  /**
   * Set data in cache
   */
  set(key: string, data: any, ttlSeconds: number = 3600): void {
    const expires = Date.now() + (ttlSeconds * 1000);
    this.cache.set(key, { data, expires });
    this.logger.log(`Cache set: ${key} (TTL: ${ttlSeconds}s)`);
  }

  /**
   * Delete specific key from cache
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.logger.log(`Cache deleted: ${key}`);
    }
    return deleted;
  }

  /**
   * Invalidate all cache for a user
   */
  invalidateUser(userId: string): number {
    let deletedCount = 0;
    
    for (const [key] of this.cache) {
      if (key.includes(userId)) {
        this.cache.delete(key);
        deletedCount++;
      }
    }
    
    this.logger.log(`Invalidated ${deletedCount} cache entries for user: ${userId}`);
    return deletedCount;
  }

  /**
   * Clear all cache (for testing/debugging)
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.logger.log(`Cleared all cache (${size} entries)`);
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }
}