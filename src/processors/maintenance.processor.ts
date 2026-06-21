import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MAINTENANCE_JOB_NAMES, QUEUE_NAMES } from '../common/constants';
import { MaintenanceService } from '../services/maintenance.service';

interface MaintenanceJobPayload {
  scheduleVersion?: string;
}

@Processor(QUEUE_NAMES.MAINTENANCE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(private readonly maintenanceService: MaintenanceService) {
    super();
  }

  async process(job: Job<MaintenanceJobPayload>) {
    if (job.name === MAINTENANCE_JOB_NAMES.ENABLE) {
      await this.maintenanceService.handleScheduledEnable(
        job.data?.scheduleVersion,
      );
      return;
    }

    if (job.name === MAINTENANCE_JOB_NAMES.DISABLE) {
      await this.maintenanceService.handleScheduledDisable(
        job.data?.scheduleVersion,
      );
      return;
    }

    this.logger.warn(`Unknown maintenance job: ${job.name}`);
  }
}
