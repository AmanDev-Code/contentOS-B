import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { SessionPoolService, MediaEngineAlertService } from '../modules/media-engine';
import { CircuitBreakerService } from '../modules/media-engine/services/circuit-breaker.service';

/**
 * Admin Media Engine Controller — Session pool management + observability.
 *
 * Used by the Chrome extension to add accounts to the session pool.
 * Also exposes alerts, event log, and circuit breaker status for monitoring.
 */
@ApiTags('Admin — Media Engine')
@ApiBearerAuth()
@UseGuards(AuthGuard, AdminGuard)
@Controller('admin/media-engine')
export class AdminMediaEngineController {
  private readonly logger = new Logger(AdminMediaEngineController.name);

  constructor(
    private readonly sessionPool: SessionPoolService,
    private readonly alerts: MediaEngineAlertService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  // ─── Session Pool ──────────────────────────────────────────────────────────

  /**
   * Add a session to the pool (called by Chrome extension).
   * When re-adding an existing account, resets health + all circuit breakers
   * so fresh cookies get a clean slate.
   */
  @Post('sessions')
  @ApiOperation({ summary: 'Add Instagram session to pool (from extension)' })
  async addSession(
    @Body() body: { accountId: string; platform?: string; cookies: Record<string, string>; proxy?: string },
  ) {
    if (!body.accountId) {
      throw new BadRequestException('accountId is required (ds_user_id)');
    }
    if (!body.cookies || Object.keys(body.cookies).length === 0) {
      throw new BadRequestException('cookies object is required and cannot be empty');
    }
    if (!body.cookies['sessionid']) {
      throw new BadRequestException('sessionid cookie is required');
    }

    const platform = (body.platform || 'instagram') as 'instagram';

    const session = await this.sessionPool.addSession(
      body.accountId,
      platform,
      body.cookies,
      body.proxy,
    );

    // Reset ALL circuit breakers when fresh cookies are uploaded.
    // Stale cookies cause cascading failures that trip circuits;
    // fresh cookies deserve a clean slate.
    const engines = ['private-api', 'mobile-api', 'browser', 'embed', 'oembed'] as const;
    for (const engine of engines) {
      await this.circuitBreaker.reset(engine);
    }

    const stats = await this.sessionPool.getStats(platform);

    this.logger.log(
      `Session added to pool: account=${body.accountId}, cookies=${Object.keys(body.cookies).length}, pool=${stats.total}, circuits=reset`,
    );

    this.alerts.emitSessionRegistered(body.accountId, platform);

    return {
      success: true,
      accountId: body.accountId,
      cookieCount: Object.keys(body.cookies).length,
      health: session.health,
      poolSize: stats.total,
      poolStats: stats,
      circuitsReset: true,
    };
  }

  /**
   * Get pool stats for a platform.
   */
  @Get('sessions/stats')
  @ApiOperation({ summary: 'Get session pool statistics' })
  async getPoolStats() {
    const stats = await this.sessionPool.getStats('instagram');
    const sessions = await this.sessionPool.listAll('instagram');

    return {
      platform: 'instagram',
      stats,
      sessions: sessions.map((s) => ({
        accountId: s.accountId,
        health: s.health,
        lastUsed: s.lastUsed,
        totalRequests: s.totalRequests,
        consecutiveFailures: s.consecutiveFailures,
        failedRequests: s.failedRequests,
        cooldownUntil: s.cooldownUntil,
        cookieCount: Object.keys(s.cookies.cookies).length,
        createdAt: s.createdAt,
      })),
    };
  }

  /**
   * Remove a session from the pool.
   */
  @Delete('sessions/:accountId')
  @ApiOperation({ summary: 'Remove a session from the pool' })
  async removeSession(@Param('accountId') accountId: string) {
    await this.sessionPool.removeSession(accountId, 'instagram');
    const stats = await this.sessionPool.getStats('instagram');

    return {
      success: true,
      removed: accountId,
      poolSize: stats.total,
    };
  }

  // ─── Alerts & Observability ────────────────────────────────────────────────

  /**
   * Get recent alerts (warnings + critical only).
   */
  @Get('alerts')
  @ApiOperation({ summary: 'Get media engine alerts' })
  async getAlerts(@Query('limit') limit?: string) {
    const n = Math.min(parseInt(limit || '20', 10), 100);
    return {
      alerts: this.alerts.getAlerts(n),
    };
  }

  /**
   * Get full event log (all severities).
   */
  @Get('events')
  @ApiOperation({ summary: 'Get media engine event log' })
  async getEvents(
    @Query('limit') limit?: string,
    @Query('severity') severity?: string,
  ) {
    const n = Math.min(parseInt(limit || '50', 10), 200);
    const sev = severity as 'info' | 'warning' | 'critical' | undefined;
    return {
      events: this.alerts.getRecentEvents(n, sev),
    };
  }

  /**
   * Get events for a specific account.
   */
  @Get('events/:accountId')
  @ApiOperation({ summary: 'Get events for a specific account' })
  async getAccountEvents(
    @Param('accountId') accountId: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(parseInt(limit || '20', 10), 100);
    return {
      accountId,
      events: this.alerts.getAccountEvents(accountId, n),
    };
  }

  /**
   * Get circuit breaker status for all engines.
   */
  @Get('circuits')
  @ApiOperation({ summary: 'Get circuit breaker states for all engines' })
  async getCircuitStates() {
    const states = await this.circuitBreaker.getAllStates();
    return { circuits: states };
  }

  /**
   * Reset a circuit breaker (admin override).
   */
  @Post('circuits/:engine/reset')
  @ApiOperation({ summary: 'Reset a circuit breaker to closed state' })
  async resetCircuit(@Param('engine') engine: string) {
    await this.circuitBreaker.reset(engine as any);
    return { success: true, engine, state: 'closed' };
  }

  /**
   * Full health dashboard — one endpoint for everything.
   */
  @Get('health')
  @ApiOperation({ summary: 'Complete media engine health dashboard' })
  async getHealthDashboard() {
    const poolStats = await this.sessionPool.getStats('instagram');
    const sessions = await this.sessionPool.listAll('instagram');
    const circuits = await this.circuitBreaker.getAllStates();
    const recentAlerts = this.alerts.getAlerts(10);

    // Determine overall health
    let overallHealth: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (poolStats.healthy === 0 && poolStats.total > 0) {
      overallHealth = 'critical';
    } else if (poolStats.healthy < 2 && poolStats.total >= 2) {
      overallHealth = 'degraded';
    }

    return {
      status: overallHealth,
      pool: {
        ...poolStats,
        sessions: sessions.map((s) => ({
          accountId: s.accountId,
          health: s.health,
          lastUsed: s.lastUsed,
          totalRequests: s.totalRequests,
          consecutiveFailures: s.consecutiveFailures,
        })),
      },
      circuits,
      recentAlerts,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Send a test alert email to verify email delivery is working.
   * Also triggers a real POOL_EMPTY alert if the pool is actually empty.
   */
  @Post('test-alert')
  @ApiOperation({ summary: 'Send a test alert email' })
  async sendTestAlert() {
    const stats = await this.sessionPool.getStats('instagram');

    // Emit a real alert based on actual pool state
    this.alerts.emitHealthCheckComplete('instagram', stats.healthy, stats.total);

    return {
      success: true,
      message: `Test alert fired. Pool has ${stats.total} total sessions, ${stats.healthy} healthy. Check your email.`,
      emailTarget: 'ADMIN_ALERT_EMAIL from .env',
    };
  }
}
