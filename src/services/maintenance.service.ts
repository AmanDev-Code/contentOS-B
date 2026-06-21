import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { MAINTENANCE_JOB_NAMES, QUEUE_NAMES } from '../common/constants';
import { CacheService } from './cache.service';

const MAINTENANCE_KEY = 'maintenance:config';
// 1-year TTL — this is a persistent admin config, not a transient cache entry
const MAINTENANCE_TTL_SECONDS = 365 * 24 * 3600;

export interface MaintenanceConfig {
  enabled: boolean;
  scheduledStart?: string;
  scheduledEnd?: string;
  message?: string;
  updatedAt: string;
  updatedBy: string;
  scheduleVersion?: string;
}

export interface MaintenanceStatus {
  active: boolean;
  message?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
}

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly cacheService: CacheService,
    @InjectQueue(QUEUE_NAMES.MAINTENANCE)
    private readonly maintenanceQueue: Queue,
  ) {}

  private parseTimestamp(value?: string): number | null {
    if (!value) return null;
    const ts = Date.parse(value);
    return Number.isNaN(ts) ? null : ts;
  }

  async getConfig(): Promise<MaintenanceConfig | null> {
    return this.cacheService.get(
      MAINTENANCE_KEY,
    ) as Promise<MaintenanceConfig | null>;
  }

  async setConfig(
    updates: {
      enabled?: boolean;
      scheduledStart?: string | null;
      scheduledEnd?: string | null;
      message?: string | null;
    },
    updatedBy: string,
  ): Promise<MaintenanceConfig> {
    const existing = await this.getConfig();
    const hasStart = updates.scheduledStart !== undefined;
    const hasEnd = updates.scheduledEnd !== undefined;

    if (hasStart !== hasEnd) {
      throw new BadRequestException(
        'scheduledStart and scheduledEnd must both be provided together',
      );
    }

    if (hasStart && hasEnd && updates.scheduledStart && updates.scheduledEnd) {
      const start = new Date(updates.scheduledStart).getTime();
      const end = new Date(updates.scheduledEnd).getTime();
      if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
        throw new BadRequestException(
          'scheduledEnd must be after scheduledStart',
        );
      }
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const requestedEnabled =
      updates.enabled !== undefined
        ? updates.enabled
        : (existing?.enabled ?? false);
    const requestedStart =
      updates.scheduledStart !== undefined
        ? (updates.scheduledStart ?? undefined)
        : existing?.scheduledStart;
    const requestedEnd =
      updates.scheduledEnd !== undefined
        ? (updates.scheduledEnd ?? undefined)
        : existing?.scheduledEnd;
    const hasWindow = Boolean(requestedStart && requestedEnd);
    const scheduleUpdated = hasStart && hasEnd;
    const startTs = this.parseTimestamp(requestedStart);
    const endTs = this.parseTimestamp(requestedEnd);

    let enabled = requestedEnabled;
    let scheduledStart = requestedStart;
    let scheduledEnd = requestedEnd;
    let scheduleVersion = existing?.scheduleVersion;

    if (scheduleUpdated && !hasWindow) {
      await this.clearPendingJobs();
      scheduledStart = undefined;
      scheduledEnd = undefined;
      scheduleVersion = undefined;
    } else if (hasWindow && startTs !== null && endTs !== null) {
      scheduleVersion = nowIso;
      await this.clearPendingJobs();

      if (endTs <= now) {
        enabled = false;
        scheduledStart = undefined;
        scheduledEnd = undefined;
        scheduleVersion = undefined;
      } else if (startTs <= now) {
        enabled = true;
        await this.scheduleDisableJob(endTs, scheduleVersion);
      } else {
        enabled = false;
        await this.scheduleEnableJob(startTs, scheduleVersion);
        await this.scheduleDisableJob(endTs, scheduleVersion);
      }
    }

    const config: MaintenanceConfig = {
      enabled,
      updatedAt: new Date().toISOString(),
      updatedBy,
      scheduleVersion,
    };

    config.scheduledStart = scheduledStart;
    config.scheduledEnd = scheduledEnd;
    config.message =
      updates.message !== undefined
        ? (updates.message ?? undefined)
        : existing?.message;

    await this.cacheService.set(
      MAINTENANCE_KEY,
      config,
      MAINTENANCE_TTL_SECONDS,
    );
    return config;
  }

  async clearSchedule(updatedBy: string): Promise<MaintenanceConfig> {
    const existing = await this.getConfig();
    await this.clearPendingJobs();
    const config: MaintenanceConfig = {
      enabled: existing?.enabled ?? false,
      message: existing?.message,
      updatedAt: new Date().toISOString(),
      updatedBy,
      scheduleVersion: undefined,
    };
    await this.cacheService.set(
      MAINTENANCE_KEY,
      config,
      MAINTENANCE_TTL_SECONDS,
    );
    return config;
  }

  async getStatus(): Promise<MaintenanceStatus> {
    const config = await this.getConfig();
    if (!config) return { active: false };

    const active = Boolean(config.enabled);

    return {
      active,
      ...(config.message ? { message: config.message } : {}),
      ...(config.scheduledStart
        ? { scheduledStart: config.scheduledStart }
        : {}),
      ...(config.scheduledEnd ? { scheduledEnd: config.scheduledEnd } : {}),
    };
  }

  async handleScheduledEnable(scheduleVersion?: string): Promise<void> {
    if (!scheduleVersion) return;
    const existing = await this.getConfig();
    if (!existing || existing.scheduleVersion !== scheduleVersion) {
      this.logger.debug('Skipped stale maintenance-enable job');
      return;
    }

    await this.persistConfig(
      {
        ...existing,
        enabled: true,
      },
      existing.updatedBy,
    );
  }

  async handleScheduledDisable(scheduleVersion?: string): Promise<void> {
    if (!scheduleVersion) return;
    const existing = await this.getConfig();
    if (!existing || existing.scheduleVersion !== scheduleVersion) {
      this.logger.debug('Skipped stale maintenance-disable job');
      return;
    }

    await this.persistConfig(
      {
        ...existing,
        enabled: false,
        scheduledStart: undefined,
        scheduledEnd: undefined,
        scheduleVersion: undefined,
      },
      existing.updatedBy,
    );
  }

  private async scheduleEnableJob(
    startTs: number,
    scheduleVersion: string,
  ): Promise<void> {
    await this.maintenanceQueue.add(
      MAINTENANCE_JOB_NAMES.ENABLE,
      { scheduleVersion },
      {
        jobId: `${MAINTENANCE_JOB_NAMES.ENABLE}:${scheduleVersion}`,
        delay: Math.max(0, startTs - Date.now()),
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  }

  private async scheduleDisableJob(
    endTs: number,
    scheduleVersion: string,
  ): Promise<void> {
    await this.maintenanceQueue.add(
      MAINTENANCE_JOB_NAMES.DISABLE,
      { scheduleVersion },
      {
        jobId: `${MAINTENANCE_JOB_NAMES.DISABLE}:${scheduleVersion}`,
        delay: Math.max(0, endTs - Date.now()),
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  }

  private async clearPendingJobs(): Promise<void> {
    const jobs = await this.maintenanceQueue.getJobs([
      'delayed',
      'waiting',
      'paused',
      'prioritized',
    ]);
    await Promise.all(
      jobs
        .filter(
          (job) =>
            job.name === MAINTENANCE_JOB_NAMES.ENABLE ||
            job.name === MAINTENANCE_JOB_NAMES.DISABLE,
        )
        .map((job) => job.remove()),
    );
  }

  private async persistConfig(
    config: MaintenanceConfig,
    updatedBy: string,
  ): Promise<MaintenanceConfig> {
    const nextConfig: MaintenanceConfig = {
      enabled: config.enabled,
      scheduledStart: config.scheduledStart,
      scheduledEnd: config.scheduledEnd,
      message: config.message,
      scheduleVersion: config.scheduleVersion,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    await this.cacheService.set(
      MAINTENANCE_KEY,
      nextConfig,
      MAINTENANCE_TTL_SECONDS,
    );
    return nextConfig;
  }
}
