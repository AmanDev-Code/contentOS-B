import { Injectable } from '@nestjs/common';
import { BrowserPoolService } from './browser-pool.service';
import { ScraperCredentialsService } from './scraper-credentials.service';

export interface PlatformHealth {
  platform: 'instagram' | 'twitter' | 'linkedin';
  cookieConfigured: boolean;
  loggedIn: boolean;
  finalUrl: string;
  elapsedMs: number;
  reason?: string;
}

@Injectable()
export class ScraperSessionHealthService {
  constructor(
    private readonly pool: BrowserPoolService,
    private readonly credentials: ScraperCredentialsService,
  ) {}

  async check(): Promise<PlatformHealth[]> {
    const e = await this.credentials.getEffective();
    const [ig, tw, li] = await Promise.all([
      this.checkInstagram(e.instagramSession),
      this.checkTwitter(e.xAuthToken),
      this.checkLinkedin(e.linkedinCookie),
    ]);
    return [ig, tw, li];
  }

  private async probe(params: {
    platform: 'instagram' | 'twitter' | 'linkedin';
    cookieValue: string;
    cookieName: string;
    domain: string;
    targetUrl: string;
    loggedInCheck: (finalUrl: string) => { loggedIn: boolean; reason?: string };
  }): Promise<PlatformHealth> {
    const started = Date.now();
    const result: PlatformHealth = {
      platform: params.platform,
      cookieConfigured: Boolean(params.cookieValue),
      loggedIn: false,
      finalUrl: '',
      elapsedMs: 0,
    };
    if (!params.cookieValue) {
      result.reason =
        'not configured (paste in Admin → Scraper Debug or set env)';
      result.elapsedMs = Date.now() - started;
      return result;
    }
    try {
      // Fast probe: issue a raw HTTP request with cookie, inspect final URL + status.
      // This skips the entire browser render pipeline (~3-6s saved per platform).
      const { context } = await this.pool.createContext({
        cookies: [
          {
            name: params.cookieName,
            value: params.cookieValue,
            domain: params.domain,
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None',
          },
        ],
        blockResources: false,
      });
      try {
        const resp = await context.request.get(params.targetUrl, {
          timeout: 6000,
          maxRedirects: 5,
        });
        result.finalUrl = resp.url();
        const check = params.loggedInCheck(result.finalUrl);
        result.loggedIn = check.loggedIn && resp.ok();
        result.reason =
          check.reason || (!resp.ok() ? `http ${resp.status()}` : undefined);
      } finally {
        await context.close().catch(() => {});
      }
    } catch (e) {
      result.reason = (e as Error).message;
    }
    result.elapsedMs = Date.now() - started;
    return result;
  }

  private checkInstagram(session: string) {
    return this.probe({
      platform: 'instagram',
      cookieValue: session,
      cookieName: 'sessionid',
      domain: '.instagram.com',
      targetUrl: 'https://www.instagram.com/',
      loggedInCheck: (url) => {
        if (url.includes('/accounts/login') || url.includes('/challenge')) {
          return { loggedIn: false, reason: 'redirected to login/challenge' };
        }
        return { loggedIn: true };
      },
    });
  }

  private checkTwitter(token: string) {
    return this.probe({
      platform: 'twitter',
      cookieValue: token,
      cookieName: 'auth_token',
      domain: '.x.com',
      targetUrl: 'https://x.com/home',
      loggedInCheck: (url) => {
        if (url.includes('/i/flow/login') || url.includes('/account/access')) {
          return { loggedIn: false, reason: 'redirected to login flow' };
        }
        if (url === 'https://x.com/' || url.endsWith('x.com')) {
          return { loggedIn: false, reason: 'redirected away from /home' };
        }
        return { loggedIn: true };
      },
    });
  }

  private checkLinkedin(liAt: string) {
    return this.probe({
      platform: 'linkedin',
      cookieValue: liAt,
      cookieName: 'li_at',
      domain: '.linkedin.com',
      targetUrl: 'https://www.linkedin.com/feed/',
      loggedInCheck: (url) => {
        if (
          url.includes('/login') ||
          url.includes('/authwall') ||
          url.includes('/checkpoint')
        ) {
          return { loggedIn: false, reason: 'redirected to auth/checkpoint' };
        }
        return { loggedIn: true };
      },
    });
  }
}
