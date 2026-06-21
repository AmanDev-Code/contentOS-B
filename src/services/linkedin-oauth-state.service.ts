import { Injectable, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { CacheService } from './cache.service';

const PREFIX = 'linkedin_oauth_state:';
const TTL_SEC = 600;

export interface OAuthStateResult {
  userId: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class LinkedinOAuthStateService {
  constructor(private readonly cacheService: CacheService) {}

  async createStateForUser(
    userId: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const state = randomBytes(32).toString('hex');
    const value = metadata ? JSON.stringify({ userId, metadata }) : userId;
    await this.cacheService.set(PREFIX + state, value, TTL_SEC);
    return state;
  }

  async consumeState(
    state: string | undefined,
  ): Promise<string | OAuthStateResult> {
    if (!state || !/^[a-f0-9]{64}$/i.test(state)) {
      throw new BadRequestException('Invalid OAuth state');
    }
    const key = PREFIX + state;
    const raw = await this.cacheService.get(key);
    await this.cacheService.delete(key);
    if (!raw || typeof raw !== 'string') {
      throw new BadRequestException('OAuth state expired or already used');
    }
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as OAuthStateResult;
        if (parsed.userId) return parsed;
      } catch {
        // fall through to treat as plain userId
      }
    }
    return raw;
  }
}
