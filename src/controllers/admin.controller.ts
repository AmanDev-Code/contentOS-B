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
import { TwitterScraperService } from '../services/scrapers/twitter.scraper';
import { LinkedinScraperService } from '../services/scrapers/linkedin.scraper';
import { ScraperCredentialsService } from '../services/scrapers/scraper-credentials.service';
import { BrowserPoolService } from '../services/scrapers/browser-pool.service';
import { SupabaseService } from '../services/supabase.service';
import { CacheService } from '../services/cache.service';
import { TrendingHashtagEngineService } from '../services/trending-hashtag-engine.service';
import { AppSettingsService } from '../services/app-settings.service';
import { GenerationService } from '../services/generation.service';

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
        Number(sb.instagram || 0) + Number(sb.twitter || 0) + Number(sb.linkedin || 0);
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
        throw new HttpException(delErr.message, HttpStatus.INTERNAL_SERVER_ERROR);
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
    return { success: true, data: { deletedRows: deleted, cacheCleared: true } };
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
      const { error: delErr } = await client.from('trending_hashtags').delete().in('id', ids);
      if (delErr) {
        throw new HttpException(delErr.message, HttpStatus.INTERNAL_SERVER_ERROR);
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
    const health = verify ? await this.scraperSessionHealthService.check() : null;
    return { success: true, data: { credentials, health } };
  }

  @Post('scraper/credentials/verify')
  @ApiOperation({ summary: 'Re-run session health probes with current effective credentials' })
  async verifyScraperCredentials() {
    const health = await this.scraperSessionHealthService.check();
    const credentials = await this.scraperCredentials.getAdminView();
    return { success: true, data: { credentials, health } };
  }

  @Get('scraper/session-health')
  @ApiOperation({ summary: 'Check scraper session cookie validity per platform' })
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
    @Body() body: { platform: 'instagram' | 'twitter' | 'linkedin'; tag: string; limit?: number },
  ) {
    const { platform, tag } = body || ({} as any);
    if (!platform || !tag) {
      throw new HttpException('platform and tag are required', HttpStatus.BAD_REQUEST);
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
      const maxAgeMs = Math.max(1, Math.min(body?.maxAgeMinutes ?? 5, 60)) * 60 * 1000;
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
        throw new HttpException(fetchError.message, HttpStatus.INTERNAL_SERVER_ERROR);
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
            throw new HttpException(singleUpdateError.message, HttpStatus.INTERNAL_SERVER_ERROR);
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
        console.error(`Credit refund errors during admin cleanup:`, refundErrors);
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
}
