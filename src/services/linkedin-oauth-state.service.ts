import { Injectable, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { CacheService } from './cache.service';

const PREFIX = 'linkedin_oauth_state:';
const TTL_SEC = 600;

@Injectable()
export class LinkedinOAuthStateService {
  constructor(private readonly cacheService: CacheService) {}

  /** Opaque state for LinkedIn OAuth (stored server-side, not the user id). */
  async createStateForUser(userId: string): Promise<string> {
    const state = randomBytes(32).toString('hex');
    await this.cacheService.set(PREFIX + state, userId, TTL_SEC);
    return state;
  }

  /**
   * Returns userId and invalidates state (one-time use).
   * Rejects malformed state to avoid accidental misuse.
   */
  async consumeState(state: string | undefined): Promise<string> {
    if (!state || !/^[a-f0-9]{64}$/i.test(state)) {
      throw new BadRequestException('Invalid OAuth state');
    }
    const key = PREFIX + state;
    const userId = await this.cacheService.get(key);
    await this.cacheService.delete(key);
    if (!userId || typeof userId !== 'string') {
      throw new BadRequestException('OAuth state expired or already used');
    }
    return userId;
  }
}
