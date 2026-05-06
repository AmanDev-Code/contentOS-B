import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../common/constants';
import { SupabaseService } from '../services/supabase.service';

/**
 * Repeatable sweep hook for metrics/alerts. Client UX relies on GET /feedback/eligibility.
 */
@Processor(QUEUE_NAMES.FEEDBACK_REMINDER)
export class FeedbackReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(FeedbackReminderProcessor.name);

  constructor(private readonly supabaseService: SupabaseService) {
    super();
  }

  async process(job: Job) {
    if (job.name !== 'daily-sweep') {
      return;
    }

    const { count, error } = await this.supabaseService
      .getServiceClient()
      .from('feedback_eligibility')
      .select('*', { count: 'exact', head: true })
      .eq('feedback_pending', true)
      .is('feedback_submitted_at', null)
      .not('first_action_completed_at', 'is', null);

    if (error) {
      this.logger.warn(`Reminder sweep count failed: ${error.message}`);
      return { pendingApprox: null };
    }

    this.logger.log(
      `Feedback reminder sweep: users with pending skip ≈ ${count ?? 0}`,
    );
    return { pendingApprox: count ?? 0 };
  }
}
