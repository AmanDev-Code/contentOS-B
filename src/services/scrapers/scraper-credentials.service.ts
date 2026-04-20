import { Injectable } from '@nestjs/common';
import { CacheService } from '../cache.service';

const REDIS_KEY = 'scraper:credentials';
const CREDENTIALS_TTL_SEC = 60 * 60 * 24 * 365 * 3;

export interface StoredScraperCredentials {
  instagramSession?: string;
  instagramCsrfToken?: string;
  instagramDsUserId?: string;
  instagramIgDid?: string;
  instagramMid?: string;
  xAuthToken?: string;
  linkedinCookie?: string;
  linkedinApiVersion?: string;
  updatedAt?: string;
}

export interface MaskedSecret {
  set: boolean;
  source: 'override' | 'env' | 'none';
  preview: string;
}

export interface ScraperCredentialsAdminView {
  instagram: {
    sessionId: MaskedSecret;
    csrftoken: MaskedSecret;
    dsUserId: MaskedSecret;
    igDid: MaskedSecret;
    mid: MaskedSecret;
  };
  twitter: { authToken: MaskedSecret };
  linkedin: { liAt: MaskedSecret; apiVersion: MaskedSecret };
  updatedAt?: string;
}

export interface EffectiveScraperCredentials {
  instagramSession: string;
  instagramCsrfToken: string;
  instagramDsUserId: string;
  instagramIgDid: string;
  instagramMid: string;
  xAuthToken: string;
  linkedinCookie: string;
  linkedinApiVersion: string;
}

@Injectable()
export class ScraperCredentialsService {
  constructor(private readonly cache: CacheService) {}

  private mask(value: string | undefined): string {
    if (!value) return '';
    const v = value.trim();
    if (v.length <= 8) return '••••••••';
    return `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`;
  }

  private preview(
    overrideVal: string | undefined,
    envVal: string | undefined,
  ): MaskedSecret {
    const o = overrideVal?.trim();
    const e = envVal?.trim();
    if (o) {
      return { set: true, source: 'override', preview: this.mask(o) };
    }
    if (e) {
      return { set: true, source: 'env', preview: this.mask(e) };
    }
    return { set: false, source: 'none', preview: '—' };
  }

  async getStored(): Promise<StoredScraperCredentials | null> {
    return (await this.cache.get(REDIS_KEY)) as StoredScraperCredentials | null;
  }

  async save(
    body: Partial<StoredScraperCredentials> & { clearFields?: string[] },
  ): Promise<StoredScraperCredentials> {
    const prev = (await this.getStored()) || {};
    const next: StoredScraperCredentials = { ...prev };
    const clears = new Set(body.clearFields || []);
    const assign = (key: keyof StoredScraperCredentials, val?: string) => {
      if (clears.has(String(key))) {
        delete (next as any)[key];
        return;
      }
      if (val === undefined) return;
      const t = val.trim();
      if (t === '') return;
      (next as any)[key] = t;
    };
    assign('instagramSession', body.instagramSession);
    assign('instagramCsrfToken', body.instagramCsrfToken);
    assign('instagramDsUserId', body.instagramDsUserId);
    assign('instagramIgDid', body.instagramIgDid);
    assign('instagramMid', body.instagramMid);
    assign('xAuthToken', body.xAuthToken);
    assign('linkedinCookie', body.linkedinCookie);
    assign('linkedinApiVersion', body.linkedinApiVersion);
    next.updatedAt = new Date().toISOString();
    await this.cache.set(REDIS_KEY, next, CREDENTIALS_TTL_SEC);
    return next;
  }

  async getAdminView(): Promise<ScraperCredentialsAdminView> {
    const s = await this.getStored();
    return {
      instagram: {
        sessionId: this.preview(s?.instagramSession, process.env.INSTAGRAM_SESSION),
        csrftoken: this.preview(s?.instagramCsrfToken, process.env.INSTAGRAM_CSRFTOKEN),
        dsUserId: this.preview(s?.instagramDsUserId, process.env.INSTAGRAM_DS_USER_ID),
        igDid: this.preview(s?.instagramIgDid, process.env.INSTAGRAM_IG_DID),
        mid: this.preview(s?.instagramMid, process.env.INSTAGRAM_MID),
      },
      twitter: {
        authToken: this.preview(s?.xAuthToken, process.env.X_AUTH_TOKEN),
      },
      linkedin: {
        liAt: this.preview(s?.linkedinCookie, process.env.LINKEDIN_COOKIE),
        apiVersion: this.preview(
          s?.linkedinApiVersion,
          process.env.LINKEDIN_API_VERSION,
        ),
      },
      updatedAt: s?.updatedAt,
    };
  }

  async getEffective(): Promise<EffectiveScraperCredentials> {
    const s = await this.getStored();
    return {
      instagramSession:
        s?.instagramSession?.trim() || process.env.INSTAGRAM_SESSION || '',
      instagramCsrfToken:
        s?.instagramCsrfToken?.trim() || process.env.INSTAGRAM_CSRFTOKEN || '',
      instagramDsUserId:
        s?.instagramDsUserId?.trim() || process.env.INSTAGRAM_DS_USER_ID || '',
      instagramIgDid: s?.instagramIgDid?.trim() || process.env.INSTAGRAM_IG_DID || '',
      instagramMid: s?.instagramMid?.trim() || process.env.INSTAGRAM_MID || '',
      xAuthToken: s?.xAuthToken?.trim() || process.env.X_AUTH_TOKEN || '',
      linkedinCookie: s?.linkedinCookie?.trim() || process.env.LINKEDIN_COOKIE || '',
      linkedinApiVersion:
        s?.linkedinApiVersion?.trim() || process.env.LINKEDIN_API_VERSION || '',
    };
  }
}
