import { Injectable, Logger } from '@nestjs/common';

import {
  Session,
  Platform,
  EngineType,
  PoolStats,
  CircuitState,
  REDIS_KEYS,
} from '../core';
import { CacheService } from '../../../services/cache.service';
import { EmailService } from '../../../services/email.service';
import { ConfigService } from '@nestjs/config';

/**
 * Media Engine Alert & Observability Service.
 *
 * Tracks events, emits structured logs with correlation IDs,
 * and triggers alerts when pool health degrades.
 *
 * Alert thresholds:
 * - CRITICAL: 0 healthy sessions (pool exhausted)
 * - WARNING: <2 healthy sessions (pool degraded)
 * - INFO: account entered cooldown, checkpoint, etc.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface MediaEngineEvent {
  timestamp: string;
  correlationId: string;
  event: string;
  severity: AlertSeverity;
  accountId?: string;
  engine?: EngineType;
  platform?: Platform;
  details?: Record<string, any>;
}

@Injectable()
export class MediaEngineAlertService {
  private readonly logger = new Logger('MediaEngine:Alert');
  private readonly adminEmail: string;

  /** In-memory ring buffer of last 200 events (also queryable via admin endpoint) */
  private readonly eventLog: MediaEngineEvent[] = [];
  private readonly MAX_EVENTS = 200;

  /** Throttle: don't email more than once per 15 minutes for same event type */
  private readonly lastEmailSent: Map<string, number> = new Map();
  private readonly EMAIL_THROTTLE_MS = 15 * 60 * 1000;

  constructor(
    private readonly cache: CacheService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {
    this.adminEmail = this.configService.get<string>('ADMIN_ALERT_EMAIL') ||
      this.configService.get<string>('SMTP2GO_FROM_EMAIL') ||
      'admin@trndinn.com';
  }

  // ─── Event Emitters ──────────────────────────────────────────────────────

  /**
   * Account entered cooldown (rate limited).
   */
  emitCooldown(accountId: string, platform: Platform, cooldownMs: number, consecutiveFailures: number): void {
    this.emit({
      event: 'SESSION_COOLDOWN',
      severity: 'info',
      accountId,
      platform,
      details: { cooldownMs, consecutiveFailures },
    });
  }

  /**
   * Account marked dead (too many consecutive failures).
   */
  emitSessionDead(accountId: string, platform: Platform, consecutiveFailures: number): void {
    this.emit({
      event: 'SESSION_DEAD',
      severity: 'warning',
      accountId,
      platform,
      details: { consecutiveFailures, action: 'Re-extract cookies via extension or fix manually' },
    });

    // Check if pool is now critical
    this.checkPoolHealth(platform);
  }

  /**
   * Account hit checkpoint/challenge.
   */
  emitCheckpoint(accountId: string, platform: Platform): void {
    this.emit({
      event: 'SESSION_CHECKPOINT',
      severity: 'warning',
      accountId,
      platform,
      details: { action: 'Log into this account in browser, resolve challenge, re-extract cookies' },
    });

    this.checkPoolHealth(platform);
  }

  /**
   * All engines failed for a URL.
   */
  emitAllEnginesFailed(url: string, platform: Platform, engineErrors: string[]): void {
    this.emit({
      event: 'ALL_ENGINES_FAILED',
      severity: 'critical',
      platform,
      details: { url, errors: engineErrors },
    });
  }

  /**
   * Circuit breaker opened for an engine.
   */
  emitCircuitOpen(engine: EngineType): void {
    this.emit({
      event: 'CIRCUIT_OPEN',
      severity: 'warning',
      engine,
      details: { action: 'Engine will be retried after reset timeout (60s)' },
    });
  }

  /**
   * Session pool exhausted (no healthy sessions).
   */
  emitPoolExhausted(platform: Platform, stats: PoolStats): void {
    this.emit({
      event: 'POOL_EXHAUSTED',
      severity: 'critical',
      platform,
      details: {
        ...stats,
        action: 'ALL sessions are unavailable. Add more accounts via the Chrome extension immediately.',
      },
    });
  }

  /**
   * Pool degraded (fewer than 2 healthy sessions).
   */
  emitPoolDegraded(platform: Platform, stats: PoolStats): void {
    this.emit({
      event: 'POOL_DEGRADED',
      severity: 'warning',
      platform,
      details: {
        ...stats,
        action: 'Pool is running low on healthy sessions. Consider adding more accounts.',
      },
    });
  }

  /**
   * Successful extraction (debug trace).
   */
  emitExtractionSuccess(url: string, engine: EngineType, accountId: string | undefined, durationMs: number): void {
    this.emit({
      event: 'EXTRACTION_SUCCESS',
      severity: 'info',
      engine,
      accountId,
      details: { url: url.slice(0, 80), durationMs },
    });
  }

  /**
   * Health check completed.
   */
  emitHealthCheckComplete(platform: Platform, healthy: number, total: number): void {
    if (total === 0) {
      this.emit({
        event: 'POOL_EMPTY',
        severity: 'critical',
        platform,
        details: { total: 0, action: 'No sessions in pool. Add accounts via Chrome extension at /admin/media-engine.' },
      });
    } else if (healthy === 0 && total > 0) {
      this.emitPoolExhausted(platform, { total, healthy: 0, cooldown: 0, dead: total, checkpoint: 0 });
    } else if (healthy < 2 && total >= 2) {
      this.emit({
        event: 'HEALTH_CHECK_WARNING',
        severity: 'warning',
        platform,
        details: { healthy, total, message: `Only ${healthy}/${total} sessions healthy` },
      });
    }
  }

  // ─── Query Methods (for admin endpoint) ──────────────────────────────────

  /**
   * Get recent events (newest first).
   */
  getRecentEvents(limit = 50, severity?: AlertSeverity): MediaEngineEvent[] {
    let events = [...this.eventLog].reverse();
    if (severity) {
      events = events.filter((e) => e.severity === severity);
    }
    return events.slice(0, limit);
  }

  /**
   * Get critical/warning alerts only.
   */
  getAlerts(limit = 20): MediaEngineEvent[] {
    return this.getRecentEvents(limit).filter(
      (e) => e.severity === 'critical' || e.severity === 'warning',
    );
  }

  /**
   * Get events for a specific account.
   */
  getAccountEvents(accountId: string, limit = 20): MediaEngineEvent[] {
    return [...this.eventLog]
      .reverse()
      .filter((e) => e.accountId === accountId)
      .slice(0, limit);
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private emit(partial: Omit<MediaEngineEvent, 'timestamp' | 'correlationId'>): void {
    const event: MediaEngineEvent = {
      ...partial,
      timestamp: new Date().toISOString(),
      correlationId: this.generateCorrelationId(),
    };

    // Structured log output (easily parseable by log aggregators)
    const logLine = `[${event.severity.toUpperCase()}] ${event.event} | account=${event.accountId || '-'} engine=${event.engine || '-'} | ${JSON.stringify(event.details || {})}`;

    switch (event.severity) {
      case 'critical':
        this.logger.error(logLine);
        this.sendAlertEmail(event);
        break;
      case 'warning':
        this.logger.warn(logLine);
        this.sendAlertEmail(event);
        break;
      default:
        this.logger.debug(logLine);
    }

    // Store in ring buffer
    this.eventLog.push(event);
    if (this.eventLog.length > this.MAX_EVENTS) {
      this.eventLog.shift();
    }

    // Persist critical alerts to Redis for cross-restart visibility
    if (event.severity === 'critical' || event.severity === 'warning') {
      this.persistAlert(event);
    }
  }

  /**
   * Send email alert for critical/warning events.
   * Throttled: same event type won't email more than once per 15 minutes.
   */
  private async sendAlertEmail(event: MediaEngineEvent): Promise<void> {
    try {
      // Throttle check
      const throttleKey = `${event.event}:${event.accountId || 'global'}`;
      const lastSent = this.lastEmailSent.get(throttleKey) || 0;
      if (Date.now() - lastSent < this.EMAIL_THROTTLE_MS) {
        return; // Already emailed recently for this event type
      }

      const severityEmoji = event.severity === 'critical' ? '🚨' : '⚠️';
      const subject = `${severityEmoji} Media Engine: ${event.event.replace(/_/g, ' ')}`;

      const html = this.buildAlertEmailHtml(event);

      await this.emailService.sendEmail({
        to: this.adminEmail,
        subject,
        html_body: html,
        text_body: `[${event.severity.toUpperCase()}] ${event.event}\nAccount: ${event.accountId || 'N/A'}\nEngine: ${event.engine || 'N/A'}\nTime: ${event.timestamp}\nDetails: ${JSON.stringify(event.details, null, 2)}`,
      });

      this.lastEmailSent.set(throttleKey, Date.now());
      this.logger.log(`Alert email sent for ${event.event} to ${this.adminEmail}`);
    } catch (err) {
      // Never let email failure break the system
      this.logger.warn(`Failed to send alert email: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Build a clean HTML email for the alert.
   */
  private buildAlertEmailHtml(event: MediaEngineEvent): string {
    const severityColor = event.severity === 'critical' ? '#ef4444' : '#f59e0b';
    const severityLabel = event.severity.toUpperCase();
    const action = (event.details as any)?.action || 'Check the admin dashboard for details.';

    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; padding: 32px;">
  <div style="max-width: 560px; margin: 0 auto; background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden;">
    <div style="background: ${severityColor}; padding: 16px 24px;">
      <h1 style="margin: 0; color: #fff; font-size: 16px; font-weight: 600;">
        ${event.severity === 'critical' ? '🚨' : '⚠️'} ${severityLabel}: ${event.event.replace(/_/g, ' ')}
      </h1>
    </div>
    <div style="padding: 24px;">
      <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #64748b; width: 100px;">Time</td>
          <td style="padding: 8px 0; color: #1e293b; font-weight: 500;">${event.timestamp}</td>
        </tr>
        ${event.accountId ? `
        <tr>
          <td style="padding: 8px 0; color: #64748b;">Account</td>
          <td style="padding: 8px 0; color: #1e293b; font-family: monospace;">${event.accountId}</td>
        </tr>` : ''}
        ${event.engine ? `
        <tr>
          <td style="padding: 8px 0; color: #64748b;">Engine</td>
          <td style="padding: 8px 0; color: #1e293b;">${event.engine}</td>
        </tr>` : ''}
        ${event.platform ? `
        <tr>
          <td style="padding: 8px 0; color: #64748b;">Platform</td>
          <td style="padding: 8px 0; color: #1e293b;">${event.platform}</td>
        </tr>` : ''}
        <tr>
          <td style="padding: 8px 0; color: #64748b;">Correlation</td>
          <td style="padding: 8px 0; color: #1e293b; font-family: monospace; font-size: 12px;">${event.correlationId}</td>
        </tr>
      </table>

      <div style="margin-top: 16px; padding: 12px 16px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px;">
        <p style="margin: 0; font-size: 13px; color: #92400e; font-weight: 500;">Action Required:</p>
        <p style="margin: 4px 0 0; font-size: 13px; color: #78350f;">${action}</p>
      </div>

      ${event.details ? `
      <details style="margin-top: 16px;">
        <summary style="font-size: 12px; color: #64748b; cursor: pointer;">Raw Details</summary>
        <pre style="margin-top: 8px; padding: 12px; background: #f1f5f9; border-radius: 6px; font-size: 11px; overflow-x: auto;">${JSON.stringify(event.details, null, 2)}</pre>
      </details>` : ''}
    </div>
    <div style="padding: 16px 24px; background: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center;">
      <p style="margin: 0; font-size: 11px; color: #94a3b8;">Trndinn Media Engine · Automated Alert</p>
    </div>
  </div>
</body>
</html>`;
  }

  private async persistAlert(event: MediaEngineEvent): Promise<void> {
    try {
      const key = `${REDIS_KEYS.POOL_STATS}:alerts:latest`;
      const existing = ((await this.cache.get(key)) || []) as MediaEngineEvent[];
      existing.push(event);
      // Keep last 50 alerts in Redis
      const trimmed = existing.slice(-50);
      await this.cache.set(key, trimmed, 86400); // 24 hour TTL
    } catch {
      // Non-critical — don't let alert persistence failure break anything
    }
  }

  private async checkPoolHealth(platform: Platform): Promise<void> {
    // This is called reactively when a session degrades.
    // The actual stats check happens in the health checker cron.
    // Here we just log for immediate visibility.
  }

  private generateCorrelationId(): string {
    return `me-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
