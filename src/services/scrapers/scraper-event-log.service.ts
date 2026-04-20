import { Injectable } from '@nestjs/common';

export interface ScraperEvent {
  ts: string;
  platform: 'instagram' | 'twitter' | 'linkedin';
  tag: string;
  status: 'ok' | 'error';
  count?: number;
  elapsedMs: number;
  reason?: string;
  error?: string;
}

@Injectable()
export class ScraperEventLogService {
  private events: ScraperEvent[] = [];
  private readonly maxEvents = 200;

  record(event: ScraperEvent): void {
    this.events.unshift(event);
    if (this.events.length > this.maxEvents) {
      this.events.length = this.maxEvents;
    }
  }

  list(limit = 50): ScraperEvent[] {
    return this.events.slice(0, Math.max(1, Math.min(limit, this.maxEvents)));
  }

  clear(): void {
    this.events = [];
  }

  summary(): {
    total: number;
    ok: number;
    errors: number;
    byPlatform: Record<string, { ok: number; errors: number }>;
    lastErrorAt?: string;
  } {
    const byPlatform: Record<string, { ok: number; errors: number }> = {
      instagram: { ok: 0, errors: 0 },
      twitter: { ok: 0, errors: 0 },
      linkedin: { ok: 0, errors: 0 },
    };
    let ok = 0;
    let errors = 0;
    let lastErrorAt: string | undefined;
    for (const e of this.events) {
      const bucket = byPlatform[e.platform] || (byPlatform[e.platform] = { ok: 0, errors: 0 });
      if (e.status === 'ok') {
        ok += 1;
        bucket.ok += 1;
      } else {
        errors += 1;
        bucket.errors += 1;
        if (!lastErrorAt) lastErrorAt = e.ts;
      }
    }
    return { total: this.events.length, ok, errors, byPlatform, lastErrorAt };
  }
}
