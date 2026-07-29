import {
  Controller,
  Post,
  Get,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
  HttpException,
  HttpStatus,
  Headers,
  Query,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationService } from '../services/notification.service';
import { OnboardingService } from '../services/onboarding.service';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { TrendingTagsService } from '../services/trending-tags.service';
import { TrendingHashtagOrchestratorService } from '../services/trending-hashtag-orchestrator.service';
import { ScraperSessionHealthService } from '../services/scrapers/session-health.service';
import { ScraperEventLogService } from '../services/scrapers/scraper-event-log.service';
import { InstagramScraperService } from '../services/scrapers/instagram.scraper';
import { InstagramMobileApiService } from '../services/instagram-mobile-api.service';
import { TwitterScraperService } from '../services/scrapers/twitter.scraper';
import { LinkedinScraperService } from '../services/scrapers/linkedin.scraper';
import { ScraperCredentialsService } from '../services/scrapers/scraper-credentials.service';
import { BrowserPoolService } from '../services/scrapers/browser-pool.service';
import { SupabaseService } from '../services/supabase.service';
import { CacheService } from '../services/cache.service';
import { TrendingHashtagEngineService } from '../services/trending-hashtag-engine.service';
import { AppSettingsService } from '../services/app-settings.service';
import { GenerationService } from '../services/generation.service';
import { exec, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../common/constants';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    sub: string;
  };
}

interface CreateBroadcastDto {
  title: string;
  message: string;
  type?: 'info' | 'warning' | 'success';
  category?: 'marketing' | 'announcement';
  priority?: number;
  expiresAt?: string;
}

interface SoakTestStats {
  totalScheduled: number;
  published: number;
  failed: number;
  processing: number;
  successRate: number;
  meanLatencySeconds: number;
  p50LatencySeconds: number;
  p95LatencySeconds: number;
  p99LatencySeconds: number;
  queueDepth: number;
  dlqCount: number;
  tokenRefreshEvents: number;
  webhookSuccessRate: number;
}

interface UpdateOnboardingConfigDto {
  enabled?: boolean;
  enabledAt?: string | null;
  questionVersion?: number;
  tourVersion?: number;
  tourSteps?: Record<string, boolean>;
}

interface CreateTagDto {
  tag: string;
  priority?: number;
}

interface UpdateTagDto {
  isActive?: boolean;
  priority?: number;
}

@ApiTags('admin')
@Controller('admin')
@UseGuards(AuthGuard, PaywallGuard, AdminGuard)
@ApiBearerAuth()
export class AdminController {
  private readonly logger = new Logger(AdminController.name);
  private soakTestProcess: ChildProcess | null = null;
  private soakTestStatus: 'idle' | 'running' | 'completed' | 'failed' = 'idle';
  private soakTestStartTime: Date | null = null;

  constructor(
    private readonly notificationService: NotificationService,
    private readonly onboardingService: OnboardingService,
    private readonly trendingTagsService: TrendingTagsService,
    private readonly trendingOrchestratorService: TrendingHashtagOrchestratorService,
    private readonly scraperSessionHealthService: ScraperSessionHealthService,
    private readonly scraperEventLog: ScraperEventLogService,
    private readonly instagramScraper: InstagramScraperService,
    private readonly twitterScraper: TwitterScraperService,
    private readonly linkedinScraper: LinkedinScraperService,
    private readonly scraperCredentials: ScraperCredentialsService,
    private readonly browserPool: BrowserPoolService,
    private readonly supabaseService: SupabaseService,
    private readonly cacheService: CacheService,
    private readonly trendingHashtagEngine: TrendingHashtagEngineService,
    private readonly appSettingsService: AppSettingsService,
    private readonly generationService: GenerationService,
    private readonly instagramMobileApi: InstagramMobileApiService,
    @InjectQueue(QUEUE_NAMES.SOCIAL_PUBLISH)
    private readonly publishQueue: Queue,
  ) {}

  @Post('scraper/purge-inhouse')
  @ApiOperation({
    summary:
      'Delete trending_hashtags rows that have no external signal (IG/X/LinkedIn all zero) and flush trending cache',
  })
  async purgeInhouseTrending() {
    const client = this.supabaseService.getServiceClient();
    // Fetch candidates; filter in JS since PostgREST lacks a computed-sum filter.
    const { data, error } = await client
      .from('trending_hashtags')
      .select('id, source_breakdown')
      .limit(5000);
    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const stale = (data || []).filter((r: any) => {
      const sb = r?.source_breakdown || {};
      const total =
        Number(sb.instagram || 0) +
        Number(sb.twitter || 0) +
        Number(sb.linkedin || 0);
      return total === 0;
    });
    let deleted = 0;
    if (stale.length > 0) {
      const ids = stale.map((r: any) => r.id);
      const { error: delErr } = await client
        .from('trending_hashtags')
        .delete()
        .in('id', ids);
      if (delErr) {
        throw new HttpException(
          delErr.message,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      deleted = ids.length;
    }
    // Nuke all trending cache keys — use pattern delete if supported.
    try {
      await this.cacheService.delete('trending:global');
      await this.cacheService.delete('trending:global:list');
    } catch {
      /* ignore */
    }
    return {
      success: true,
      data: { deletedRows: deleted, cacheCleared: true },
    };
  }

  @Post('trending/prune-oldest')
  @ApiOperation({
    summary:
      'Delete the oldest trending_hashtags rows by last_updated (stale index cleanup), then rebuild global cache',
  })
  async pruneOldestTrending(@Body() body?: { count?: number }) {
    const count = Math.max(1, Math.min(Number(body?.count ?? 200), 5000));
    const client = this.supabaseService.getServiceClient();
    const { data: rows, error } = await client
      .from('trending_hashtags')
      .select('id')
      .order('last_updated', { ascending: true })
      .limit(count);
    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const ids = (rows || []).map((r: { id: string }) => r.id).filter(Boolean);
    if (ids.length > 0) {
      const { error: delErr } = await client
        .from('trending_hashtags')
        .delete()
        .in('id', ids);
      if (delErr) {
        throw new HttpException(
          delErr.message,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }
    await this.cacheService.delete('trending:global').catch(() => {});
    await this.cacheService.delete('trending:global:list').catch(() => {});
    await this.trendingHashtagEngine.refreshGlobalCache();
    return { success: true, data: { deletedRows: ids.length } };
  }

  @Get('scraper/credentials')
  @ApiOperation({
    summary: 'Masked scraper credentials (Redis override + env fallback)',
  })
  async getScraperCredentials() {
    const data = await this.scraperCredentials.getAdminView();
    return { success: true, data };
  }

  @Put('scraper/credentials')
  @ApiOperation({
    summary:
      'Save scraper secrets to Redis (admin). Empty fields are ignored. clearFields removes overrides.',
  })
  async putScraperCredentials(
    @Body()
    body: {
      instagramSession?: string;
      instagramCsrfToken?: string;
      instagramDsUserId?: string;
      instagramIgDid?: string;
      instagramMid?: string;
      xAuthToken?: string;
      linkedinCookie?: string;
      linkedinApiVersion?: string;
      clearFields?: string[];
      verify?: boolean;
    },
  ) {
    const { verify: _verify, ...toSave } = body || {};
    await this.scraperCredentials.save(toSave);
    await this.browserPool.recycle();
    const credentials = await this.scraperCredentials.getAdminView();
    const verify = body?.verify !== false;
    const health = verify
      ? await this.scraperSessionHealthService.check()
      : null;
    return { success: true, data: { credentials, health } };
  }

  @Post('scraper/credentials/verify')
  @ApiOperation({
    summary: 'Re-run session health probes with current effective credentials',
  })
  async verifyScraperCredentials() {
    const health = await this.scraperSessionHealthService.check();
    const credentials = await this.scraperCredentials.getAdminView();
    return { success: true, data: { credentials, health } };
  }

  @Post('scraper/instagram-connect')
  @ApiOperation({
    summary:
      'Launch browser for Instagram login. User logs in manually, then cookies are extracted automatically.',
  })
  async instagramConnect() {
    const { chromium } = await import('playwright');
    let browser;
    try {
      browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      });
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        viewport: { width: 420, height: 740 },
      });
      const page = await context.newPage();
      await page.goto('https://www.instagram.com/accounts/login/', {
        waitUntil: 'domcontentloaded',
      });

      // Wait for user to complete login + any challenges/captchas
      // Instead of checking URL, poll for the sessionid cookie which only
      // appears after ALL challenges (captcha, 2FA, etc.) are completed.
      // Timeout after 10 minutes to give user time for captcha/challenges.
      try {
        await page.waitForFunction(
          () => document.cookie.includes('sessionid='),
          { timeout: 600_000, polling: 2000 },
        );
      } catch {
        // Before giving up, check if sessionid exists in context cookies
        // (it might not be in document.cookie due to httpOnly flag)
        const checkCookies = await context.cookies('https://www.instagram.com');
        const hasSession = checkCookies.some((c) => c.name === 'sessionid' && c.value.length > 5);
        if (!hasSession) {
          await browser.close();
          return {
            success: false,
            error: 'Login timed out (10 minutes). Complete all challenges and try again.',
          };
        }
      }

      // Small delay to let cookies finalize
      await page.waitForTimeout(2000);

      // Extract cookies
      const cookies = await context.cookies('https://www.instagram.com');
      const cookieMap = Object.fromEntries(
        cookies.map((c) => [c.name, c.value]),
      );

      const extracted = {
        instagramSession: cookieMap['sessionid'] || '',
        instagramCsrfToken: cookieMap['csrftoken'] || '',
        instagramDsUserId: cookieMap['ds_user_id'] || '',
        instagramIgDid: cookieMap['ig_did'] || '',
        instagramMid: cookieMap['mid'] || '',
      };

      await browser.close();

      if (!extracted.instagramSession) {
        return {
          success: false,
          error:
            'Could not find sessionid cookie. Login may not have completed successfully.',
        };
      }

      // Save to Redis via ScraperCredentialsService
      await this.scraperCredentials.save(extracted);
      await this.browserPool.recycle();

      // Verify the session works
      const health = await this.scraperSessionHealthService.check();
      const credentials = await this.scraperCredentials.getAdminView();

      return {
        success: true,
        data: {
          message: 'Instagram session extracted and saved successfully.',
          credentials,
          health,
        },
      };
    } catch (error) {
      if (browser) await browser.close().catch(() => {});
      throw new HttpException(
        {
          success: false,
          error: `Instagram connect failed: ${(error as Error).message}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('scraper/instagram-extract-now')
  @ApiOperation({
    summary:
      'Fallback: Extract Instagram cookies from a currently open browser window. Opens IG, grabs cookies if already logged in.',
  })
  async instagramExtractNow() {
    const { chromium } = await import('playwright');
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      });
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      });

      // If we already have a session, inject it and verify
      const creds = await this.scraperCredentials.getEffective();
      if (creds.instagramSession) {
        await context.addCookies([
          {
            name: 'sessionid',
            value: creds.instagramSession,
            domain: '.instagram.com',
            path: '/',
            secure: true,
            sameSite: 'None',
            httpOnly: true,
          },
          ...(creds.instagramCsrfToken
            ? [
                {
                  name: 'csrftoken',
                  value: creds.instagramCsrfToken,
                  domain: '.instagram.com',
                  path: '/',
                  secure: true,
                  sameSite: 'Lax' as const,
                },
              ]
            : []),
          ...(creds.instagramDsUserId
            ? [
                {
                  name: 'ds_user_id',
                  value: creds.instagramDsUserId,
                  domain: '.instagram.com',
                  path: '/',
                  secure: true,
                  sameSite: 'None' as const,
                },
              ]
            : []),
        ]);
      }

      const page = await context.newPage();
      await page.goto('https://www.instagram.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });

      // Check if we're logged in
      const finalUrl = page.url();
      const isLoggedIn =
        !finalUrl.includes('/accounts/login') &&
        !finalUrl.includes('/challenge');

      if (!isLoggedIn) {
        await browser.close();
        return {
          success: false,
          error:
            'Not logged in. Use "Connect Instagram" to open a browser and log in first.',
        };
      }

      // Extract fresh cookies
      const cookies = await context.cookies('https://www.instagram.com');
      const cookieMap = Object.fromEntries(
        cookies.map((c) => [c.name, c.value]),
      );

      const extracted = {
        instagramSession: cookieMap['sessionid'] || '',
        instagramCsrfToken: cookieMap['csrftoken'] || '',
        instagramDsUserId: cookieMap['ds_user_id'] || '',
        instagramIgDid: cookieMap['ig_did'] || '',
        instagramMid: cookieMap['mid'] || '',
      };

      await browser.close();

      if (!extracted.instagramSession) {
        return {
          success: false,
          error: 'Session cookie not found. The session may have expired.',
        };
      }

      await this.scraperCredentials.save(extracted);
      await this.browserPool.recycle();
      const health = await this.scraperSessionHealthService.check();
      const credentials = await this.scraperCredentials.getAdminView();

      return {
        success: true,
        data: { message: 'Cookies refreshed successfully.', credentials, health },
      };
    } catch (error) {
      if (browser) await browser.close().catch(() => {});
      throw new HttpException(
        {
          success: false,
          error: `Extract failed: ${(error as Error).message}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('scraper/instagram-mobile-login')
  @ApiOperation({
    summary:
      'Login via Instagram Android Mobile API for long-lived sessions (90+ days).',
  })
  async instagramMobileLogin(@Body() body: { username: string; password: string }) {
    if (!body?.username?.trim() || !body?.password?.trim()) {
      throw new BadRequestException('Username and password are required.');
    }
    const result = await this.instagramMobileApi.login(
      body.username.trim(),
      body.password.trim(),
    );
    return { success: result.success, data: result };
  }

  @Post('scraper/instagram-mobile-verify-2fa')
  @ApiOperation({
    summary: 'Complete 2FA challenge for Instagram Mobile API login.',
  })
  async instagramMobileVerify2FA(@Body() body: { code: string }) {
    if (!body?.code?.trim()) {
      throw new BadRequestException('Verification code is required.');
    }
    const result = await this.instagramMobileApi.verify2FA(body.code.trim());
    return { success: result.success, data: result };
  }

  @Get('scraper/instagram-mobile-status')
  @ApiOperation({
    summary: 'Check if a valid Instagram Mobile API session exists.',
  })
  async instagramMobileStatus() {
    const status = await this.instagramMobileApi.getSessionStatus();
    return { success: true, data: status };
  }

  @Get('scraper/session-health')
  @ApiOperation({
    summary: 'Check scraper session cookie validity per platform',
  })
  async scraperSessionHealth() {
    try {
      const data = await this.scraperSessionHealthService.check();
      return { success: true, data };
    } catch (error) {
      throw new HttpException(
        (error as Error).message || 'Failed to check scraper sessions',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('scraper/events')
  @ApiOperation({ summary: 'Recent scraper events (ring buffer)' })
  async scraperEvents(@Query('limit') limit?: string) {
    const n = Math.max(1, Math.min(parseInt(limit || '50', 10) || 50, 200));
    return {
      success: true,
      data: {
        summary: this.scraperEventLog.summary(),
        events: this.scraperEventLog.list(n),
      },
    };
  }

  @Post('scraper/events/clear')
  @ApiOperation({ summary: 'Clear scraper event log' })
  async clearScraperEvents() {
    this.scraperEventLog.clear();
    return { success: true };
  }

  @Post('scraper/test-fetch')
  @ApiOperation({ summary: 'Test-fetch a single tag on a single platform' })
  async scraperTestFetch(
    @Body()
    body: {
      platform: 'instagram' | 'twitter' | 'linkedin';
      tag: string;
      limit?: number;
    },
  ) {
    const { platform, tag } = body || ({} as any);
    if (!platform || !tag) {
      throw new HttpException(
        'platform and tag are required',
        HttpStatus.BAD_REQUEST,
      );
    }
    const limit = Math.max(1, Math.min(Number(body.limit ?? 10), 30));
    const started = Date.now();
    const HARD_BUDGET_MS = 25_000;
    const withBudget = <T>(p: Promise<T>): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(
            () => reject(new Error(`hard_timeout after ${HARD_BUDGET_MS}ms`)),
            HARD_BUDGET_MS,
          ),
        ),
      ]);
    try {
      let posts: unknown[] = [];
      if (platform === 'instagram')
        posts = await withBudget(this.instagramScraper.fetch(tag, limit));
      else if (platform === 'twitter')
        posts = await withBudget(this.twitterScraper.fetch(tag, limit));
      else if (platform === 'linkedin')
        posts = await withBudget(this.linkedinScraper.fetch(tag, limit));
      else
        throw new HttpException(
          'platform must be instagram|twitter|linkedin',
          HttpStatus.BAD_REQUEST,
        );
      return {
        success: true,
        data: {
          platform,
          tag,
          count: posts.length,
          elapsedMs: Date.now() - started,
          sample: posts.slice(0, 5),
        },
      };
    } catch (error) {
      return {
        success: false,
        data: {
          platform,
          tag,
          elapsedMs: Date.now() - started,
          error: (error as Error).message,
        },
      };
    }
  }

  @Post('tags')
  @ApiOperation({ summary: 'Add admin managed tag' })
  async addTag(@Body() body: CreateTagDto) {
    const data = await this.trendingTagsService.addTag(
      body.tag,
      body.priority || 0,
    );
    return { success: true, data };
  }

  @Get('tags')
  @ApiOperation({ summary: 'List admin managed tags' })
  async listTags() {
    const data = await this.trendingTagsService.listTags();
    return { success: true, data };
  }

  @Patch('tags/:id')
  @ApiOperation({ summary: 'Update tag active state/priority' })
  async updateTag(@Param('id') id: string, @Body() body: UpdateTagDto) {
    const data = await this.trendingTagsService.updateTag(id, {
      isActive: body.isActive,
      priority: body.priority,
    });
    return { success: true, data };
  }

  @Delete('tags/:id')
  @ApiOperation({ summary: 'Delete tag' })
  async deleteTag(@Param('id') id: string) {
    await this.trendingTagsService.deleteTag(id);
    return { success: true };
  }

  @Post('tags/:id/refresh')
  @ApiOperation({ summary: 'Force refresh a single tag now' })
  async refreshTag(@Param('id') id: string) {
    try {
      await this.trendingOrchestratorService.enqueueSingleTag(id, true);
      return { success: true, message: 'Tag refresh queued' };
    } catch (error) {
      throw new HttpException(
        (error as Error).message || 'Failed to queue tag refresh',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('tags/refresh-all')
  @ApiOperation({ summary: 'Force refresh all active tags now' })
  async refreshAllTags() {
    try {
      await this.trendingOrchestratorService.enqueueSyncNow();
      return { success: true, message: 'Global tag sync queued' };
    } catch (error) {
      throw new HttpException(
        (error as Error).message || 'Failed to queue global tag sync',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Local/dev-only escape hatch to trigger refresh without a Supabase JWT.
   * Guarded by X-Admin-Action-Secret header matching ADMIN_ACTION_SECRET env var.
   */
  @Post('tags/refresh-all/secret')
  @ApiOperation({ summary: 'Force refresh all tags (secret header)' })
  async refreshAllTagsWithSecret(
    @Headers('x-admin-action-secret') secret?: string,
  ) {
    const expected = process.env.ADMIN_ACTION_SECRET || '';
    if (!expected || !secret || secret !== expected) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    try {
      await this.trendingOrchestratorService.enqueueSyncNow();
      return { success: true, message: 'Global tag sync queued' };
    } catch (error) {
      throw new HttpException(
        (error as Error).message || 'Failed to queue global tag sync',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('onboarding/config')
  @ApiOperation({ summary: 'Get onboarding feature flag config' })
  async getOnboardingConfig() {
    const data = await this.onboardingService.getConfig();
    return { success: true, data };
  }

  @Put('onboarding/config')
  @ApiOperation({ summary: 'Update onboarding feature flag config' })
  async updateOnboardingConfig(@Body() body: UpdateOnboardingConfigDto) {
    const data = await this.onboardingService.updateConfig({
      enabled: body.enabled,
      enabledAt: body.enabledAt,
      questionVersion: body.questionVersion,
      tourVersion: body.tourVersion,
      tourSteps: body.tourSteps,
    });
    return { success: true, data };
  }

  @Post('notifications/broadcast')
  @ApiOperation({ summary: 'Create a broadcast notification for all users' })
  async createBroadcastNotification(
    @Request() req: AuthenticatedRequest,
    @Body() body: CreateBroadcastDto,
  ) {
    try {
      // TODO: Add admin role check here
      // For now, allowing any authenticated user to create broadcast notifications
      // In production, you should check if the user has admin privileges
      // Example: if (!this.isAdmin(req.user.id)) throw new ForbiddenException();

      const { title, message, type, category, priority, expiresAt } = body;

      if (!title || !message) {
        throw new HttpException(
          'Title and message are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const notification =
        await this.notificationService.createBroadcastNotification(
          title,
          message,
          type || 'info',
          category || 'marketing',
          priority || 0,
          expiresAt ? new Date(expiresAt) : undefined,
        );

      if (!notification) {
        throw new HttpException(
          'Failed to create broadcast notification',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        message: 'Broadcast notification created successfully',
        data: notification,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to create broadcast notification',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('notifications/test-user')
  @ApiOperation({ summary: 'Send a test notification to a specific user' })
  async sendTestNotification(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      userId?: string;
      title: string;
      message: string;
      type?: 'success' | 'error' | 'warning' | 'info';
      category?: string;
    },
  ) {
    try {
      // TODO: Add admin role check here

      const { userId, title, message, type, category } = body;
      const targetUserId = userId || req.user.id; // Default to current user if no userId provided

      if (!title || !message) {
        throw new HttpException(
          'Title and message are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const validCategory =
        (category as
          | 'publishing'
          | 'generation'
          | 'scheduling'
          | 'system'
          | 'credits'
          | 'marketing'
          | 'announcement') || 'system';

      const notification = await this.notificationService.createNotification({
        userId: targetUserId,
        title,
        message,
        type: type || 'info',
        category: validCategory,
        data: { test: true, sentBy: req.user.id },
      });

      if (!notification) {
        throw new HttpException(
          'Failed to send test notification',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        message: 'Test notification sent successfully',
        data: notification,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to send test notification',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('notifications/stats')
  @ApiOperation({ summary: 'Get notification statistics' })
  async getNotificationStats(@Request() req: AuthenticatedRequest) {
    try {
      // TODO: Add admin role check here

      // This is a placeholder for notification statistics
      // In a real implementation, you would query the database for actual stats
      return {
        success: true,
        data: {
          totalNotifications: 0,
          totalBroadcasts: 0,
          activeUsers: 0,
          notificationsSentToday: 0,
          averageReadRate: 0,
          topCategories: [],
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get notification statistics',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('notifications/marketing-campaign')
  @ApiOperation({ summary: 'Create a marketing campaign notification' })
  async createMarketingCampaign(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      title: string;
      message: string;
      priority?: number;
      expiresAt?: string;
      targetSegment?: 'all' | 'free' | 'paid' | 'inactive';
    },
  ) {
    try {
      // TODO: Add admin role check here

      const { title, message, priority, expiresAt, targetSegment } = body;

      if (!title || !message) {
        throw new HttpException(
          'Title and message are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      // For now, we'll create a simple broadcast notification
      // In the future, you could implement user segmentation logic here
      const notification =
        await this.notificationService.createBroadcastNotification(
          title,
          message,
          'info',
          'marketing',
          priority || 0,
          expiresAt ? new Date(expiresAt) : undefined,
        );

      if (!notification) {
        throw new HttpException(
          'Failed to create marketing campaign',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        message: `Marketing campaign created successfully${targetSegment ? ` for ${targetSegment} users` : ''}`,
        data: {
          ...notification,
          targetSegment: targetSegment || 'all',
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to create marketing campaign',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('notifications/system-announcement')
  @ApiOperation({ summary: 'Create a system announcement' })
  async createSystemAnnouncement(
    @Request() req: AuthenticatedRequest,
    @Body()
    body: {
      title: string;
      message: string;
      type?: 'info' | 'warning' | 'success';
      priority?: number;
      expiresAt?: string;
    },
  ) {
    try {
      // TODO: Add admin role check here

      const { title, message, type, priority, expiresAt } = body;

      if (!title || !message) {
        throw new HttpException(
          'Title and message are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const notification =
        await this.notificationService.createBroadcastNotification(
          title,
          message,
          type || 'info',
          'announcement',
          priority || 1, // Higher priority for system announcements
          expiresAt ? new Date(expiresAt) : undefined,
        );

      if (!notification) {
        throw new HttpException(
          'Failed to create system announcement',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        message: 'System announcement created successfully',
        data: notification,
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to create system announcement',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Helper method to check if user is admin (placeholder)
  // private async isAdmin(userId: string): Promise<boolean> {
  //   // TODO: Implement admin role check
  //   // This could check a user_roles table, profile metadata, or environment variables
  //   return false;
  // }

  // ═══════════════════════════════════════════════════════════════════════════
  // REDIS / CACHE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  @Post('redis/flush')
  @ApiOperation({
    summary: 'Flush all Redis cache data (FLUSHALL equivalent for app cache)',
  })
  async flushRedisCache(@Request() req: AuthenticatedRequest) {
    try {
      await this.cacheService.clear();
      return {
        success: true,
        message: 'Redis cache flushed successfully',
        data: {
          flushedAt: new Date().toISOString(),
          flushedBy: req.user.id,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to flush Redis cache',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APP SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('settings/free-credit-limit')
  @ApiOperation({ summary: 'Get the global free user credit limit' })
  async getFreeCreditLimit() {
    try {
      const limit = await this.appSettingsService.getFreeCreditLimit();
      return {
        success: true,
        data: {
          freeCreditLimit: limit,
        },
      };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to get free credit limit',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Put('settings/free-credit-limit')
  @ApiOperation({ summary: 'Update the global free user credit limit' })
  async setFreeCreditLimit(
    @Request() req: AuthenticatedRequest,
    @Body() body: { limit: number },
  ) {
    const { limit } = body;

    if (limit === undefined || limit === null) {
      throw new HttpException('limit is required', HttpStatus.BAD_REQUEST);
    }

    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
      throw new HttpException(
        'limit must be a non-negative integer',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (limit > 100000) {
      throw new HttpException(
        'limit cannot exceed 100,000',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const success = await this.appSettingsService.setFreeCreditLimit(
        limit,
        req.user.id,
      );

      if (!success) {
        throw new HttpException(
          'Failed to update free credit limit',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        message: 'Free credit limit updated successfully',
        data: {
          freeCreditLimit: limit,
          updatedAt: new Date().toISOString(),
          updatedBy: req.user.id,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        error.message || 'Failed to update free credit limit',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GENERATION JOB CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  @Post('generation/cleanup-stale')
  @ApiOperation({
    summary: 'Clean up stale generation jobs that are stuck in active status',
  })
  async cleanupStaleGenerationJobs(
    @Request() req: AuthenticatedRequest,
    @Body() body?: { userId?: string; maxAgeMinutes?: number },
  ) {
    try {
      const maxAgeMs =
        Math.max(1, Math.min(body?.maxAgeMinutes ?? 5, 60)) * 60 * 1000;
      const client = this.supabaseService.getServiceClient();

      // Build query for stale jobs - clean ALL non-terminal statuses
      // Terminal statuses: ready, failed, cancelled (these are complete)
      // Everything else should be cleaned if stuck
      const terminalStatuses = ['ready', 'failed', 'cancelled'];
      let query = client
        .from('generation_jobs')
        .select('id, user_id, status, created_at, updated_at')
        .not('status', 'in', terminalStatuses)
        .lt('updated_at', new Date(Date.now() - maxAgeMs).toISOString())
        .order('updated_at', { ascending: true })
        .limit(100);

      if (body?.userId) {
        query = query.eq('user_id', body.userId);
      }

      const { data: staleJobs, error: fetchError } = await query;

      if (fetchError) {
        throw new HttpException(
          fetchError.message,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      if (!staleJobs || staleJobs.length === 0) {
        return {
          success: true,
          message: 'No stale jobs found',
          data: { cleanedCount: 0 },
        };
      }

      // Mark stale jobs as failed (individually to capture status in error message)
      let updateSuccessCount = 0;
      const updateErrors: string[] = [];
      for (const job of staleJobs) {
        try {
          const { error: singleUpdateError } = await client
            .from('generation_jobs')
            .update({
              status: 'failed',
              error: `Admin cleanup: job was stuck for more than ${Math.round(maxAgeMs / 60000)} minutes (was in status: ${job.status})`,
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id)
            .not('status', 'in', terminalStatuses);

          if (singleUpdateError) {
            throw new HttpException(
              singleUpdateError.message,
              HttpStatus.INTERNAL_SERVER_ERROR,
            );
          }
          updateSuccessCount++;
        } catch (err: any) {
          const errorMsg = `Failed to update job ${job.id}: ${err?.message || String(err)}`;
          console.error(errorMsg);
          updateErrors.push(errorMsg);
        }
      }

      if (updateErrors.length === staleJobs.length) {
        // All updates failed
        throw new HttpException(
          'Failed to update any stale jobs',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Refund credits for each cleaned job
      let refundedCount = 0;
      const refundErrors: string[] = [];
      for (const job of staleJobs) {
        try {
          await this.generationService.refundGenerationCredits(
            job.user_id,
            job.id,
            `Admin cleanup: stale job (was ${job.status})`,
          );
          refundedCount++;
        } catch (err: any) {
          // Log but don't fail the cleanup if refund fails
          const errorMsg = `Failed to refund credits for job ${job.id}: ${err?.message || String(err)}`;
          console.error(errorMsg);
          refundErrors.push(errorMsg);
        }
      }

      if (refundErrors.length > 0) {
        console.error(
          `Credit refund errors during admin cleanup:`,
          refundErrors,
        );
      }

      const cleanedJobIds = staleJobs.map((j: any) => j.id);
      return {
        success: true,
        message: `Cleaned up ${updateSuccessCount} stale generation jobs`,
        data: {
          cleanedCount: updateSuccessCount,
          refundedCount,
          refundErrors: refundErrors.length > 0 ? refundErrors : undefined,
          updateErrors: updateErrors.length > 0 ? updateErrors : undefined,
          cleanedJobIds,
          maxAgeMinutes: Math.round(maxAgeMs / 60000),
          cleanedBy: req.user.id,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        error.message || 'Failed to clean up stale jobs',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SOAK TEST CONTROL ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════════

  @Post('soak-test/start')
  @ApiOperation({ summary: 'Start 7-hour soak test in background' })
  async startSoakTest() {
    if (this.soakTestStatus === 'running') {
      throw new BadRequestException('Soak test already running');
    }

    this.soakTestStatus = 'running';
    this.soakTestStartTime = new Date();

    const backendDir = path.join(process.cwd());

    this.soakTestProcess = exec(
      'npm run soak-test:run:fast',
      { cwd: backendDir },
      (error) => {
        if (error) {
          this.soakTestStatus = 'failed';
          this.logger.error('Soak test failed', error);
        } else {
          this.soakTestStatus = 'completed';
          this.logger.log('Soak test completed');
        }
        this.soakTestProcess = null;
      },
    );

    const estimatedCompletionMs = 7 * 60 * 60 * 1000; // 7 hours

    return {
      success: true,
      message: 'Soak test started',
      data: {
        startedAt: this.soakTestStartTime,
        estimatedCompletionAt: new Date(
          Date.now() + estimatedCompletionMs,
        ).toISOString(),
        durationHours: 7,
      },
    };
  }

  @Get('soak-test/status')
  @ApiOperation({ summary: 'Get current soak test status and progress' })
  async getSoakTestStatus() {
    const elapsed = this.soakTestStartTime
      ? Date.now() - this.soakTestStartTime.getTime()
      : 0;

    const totalDurationMs = 7 * 60 * 60 * 1000; // 7 hours
    const progress =
      this.soakTestStatus === 'running'
        ? Math.min((elapsed / totalDurationMs) * 100, 100)
        : this.soakTestStatus === 'completed'
          ? 100
          : 0;

    const estimatedRemainingMs =
      this.soakTestStatus === 'running'
        ? Math.max(totalDurationMs - elapsed, 0)
        : 0;

    return {
      success: true,
      data: {
        status: this.soakTestStatus,
        startedAt: this.soakTestStartTime?.toISOString() || null,
        elapsedMs: elapsed,
        elapsedHours: parseFloat((elapsed / (60 * 60 * 1000)).toFixed(2)),
        progressPercent: parseFloat(progress.toFixed(2)),
        estimatedRemainingMs,
        estimatedRemainingHours: parseFloat(
          (estimatedRemainingMs / (60 * 60 * 1000)).toFixed(2),
        ),
      },
    };
  }

  @Get('soak-test/stats')
  @ApiOperation({ summary: 'Get soak test metrics and statistics' })
  async getSoakTestStats(): Promise<SoakTestStats> {
    const client = this.supabaseService.getServiceClient();

    // Find soak test users
    const { data: users } = await client
      .from('profiles')
      .select('id')
      .ilike('email', '%soak-%@trndinn-test.internal');

    if (!users || users.length === 0) {
      return this.getEmptySoakTestStats();
    }

    const userIds = users.map((u) => u.id);

    // Query scheduled_posts
    const { data: scheduledPosts } = await client
      .from('scheduled_posts')
      .select('*')
      .in('user_id', userIds);

    // Query webhook_deliveries
    const webhookResult = await client
      .from('webhook_deliveries')
      .select('*')
      .in('user_id', userIds);
    const webhooks = webhookResult.error ? [] : webhookResult.data;

    // Calculate stats
    const totalScheduled = scheduledPosts?.length || 0;
    const published =
      scheduledPosts?.filter((p) => p.status === 'published').length || 0;
    const failed =
      scheduledPosts?.filter((p) => p.status === 'failed').length || 0;
    const processing =
      scheduledPosts?.filter((p) => p.status === 'processing').length || 0;

    const successRate =
      totalScheduled > 0 ? (published / totalScheduled) * 100 : 0;

    // Calculate latency
    const latencies: number[] = [];
    for (const post of scheduledPosts || []) {
      if (
        post.status === 'published' &&
        post.published_at &&
        post.scheduled_for
      ) {
        const scheduled = new Date(post.scheduled_for).getTime();
        const actual = new Date(post.published_at).getTime();
        const latencySeconds = Math.abs(actual - scheduled) / 1000;
        latencies.push(latencySeconds);
      }
    }

    latencies.sort((a, b) => a - b);

    const meanLatency =
      latencies.length > 0
        ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length
        : 0;
    const p50Latency =
      latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : 0;
    const p95Latency =
      latencies.length > 0
        ? latencies[Math.floor(latencies.length * 0.95)]
        : 0;
    const p99Latency =
      latencies.length > 0
        ? latencies[Math.floor(latencies.length * 0.99)]
        : 0;

    // Get queue depth
    const queueDepth = await this.publishQueue.count();

    // DLQ count (status=failed and retry_count >= 3)
    const dlqCount =
      scheduledPosts?.filter(
        (p) => p.status === 'failed' && (p.retry_count || 0) >= 3,
      ).length || 0;

    // Token refresh events (mock for soak test)
    const tokenRefreshEvents = 0;

    // Webhook success rate
    const webhookTotal = webhooks?.length || 0;
    const webhookSuccess =
      webhooks?.filter((w) => w.status === 'delivered').length || 0;
    const webhookSuccessRate =
      webhookTotal > 0 ? (webhookSuccess / webhookTotal) * 100 : 100;

    return {
      totalScheduled,
      published,
      failed,
      processing,
      successRate: parseFloat(successRate.toFixed(2)),
      meanLatencySeconds: parseFloat(meanLatency.toFixed(2)),
      p50LatencySeconds: parseFloat(p50Latency.toFixed(2)),
      p95LatencySeconds: parseFloat(p95Latency.toFixed(2)),
      p99LatencySeconds: parseFloat(p99Latency.toFixed(2)),
      queueDepth,
      dlqCount,
      tokenRefreshEvents,
      webhookSuccessRate: parseFloat(webhookSuccessRate.toFixed(2)),
    };
  }

  private getEmptySoakTestStats(): SoakTestStats {
    return {
      totalScheduled: 0,
      published: 0,
      failed: 0,
      processing: 0,
      successRate: 0,
      meanLatencySeconds: 0,
      p50LatencySeconds: 0,
      p95LatencySeconds: 0,
      p99LatencySeconds: 0,
      queueDepth: 0,
      dlqCount: 0,
      tokenRefreshEvents: 0,
      webhookSuccessRate: 0,
    };
  }

  @Post('soak-test/stop')
  @ApiOperation({ summary: 'Stop running soak test gracefully' })
  async stopSoakTest() {
    if (this.soakTestStatus !== 'running') {
      throw new BadRequestException('No soak test running');
    }

    if (this.soakTestProcess) {
      try {
        this.soakTestProcess.kill('SIGTERM');
        this.logger.log('Sent SIGTERM to soak test process');
      } catch (error) {
        this.logger.error('Failed to kill soak test process', error);
      }
    }

    this.soakTestStatus = 'idle';
    this.soakTestStartTime = null;

    return {
      success: true,
      message: 'Soak test stop signal sent',
    };
  }

  @Get('soak-test/reports')
  @ApiOperation({ summary: 'List all past soak test reports' })
  async getSoakTestReports() {
    const reportsDir = path.join(process.cwd(), 'soak-test-reports');

    try {
      const files = await fs.readdir(reportsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      const reports = await Promise.all(
        jsonFiles.map(async (file) => {
          const filePath = path.join(reportsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const data = JSON.parse(content);

          const stats = await fs.stat(filePath);

          return {
            filename: file,
            timestamp: file.replace('.json', ''),
            createdAt: stats.birthtime.toISOString(),
            size: stats.size,
            passed: data.passed,
            successRate: data.stats?.successRate || 0,
            totalScheduled: data.stats?.totalScheduled || 0,
            data,
          };
        }),
      );

      reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      return {
        success: true,
        data: {
          count: reports.length,
          reports,
        },
      };
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return {
          success: true,
          data: {
            count: 0,
            reports: [],
          },
        };
      }
      throw new HttpException(
        error.message || 'Failed to read soak test reports',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
