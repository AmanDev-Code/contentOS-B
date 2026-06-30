import { Controller, Get, Logger, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../guards/admin.guard';
import { SupabaseService } from '../services/supabase.service';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../common/constants';

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

@Controller('admin/soak-test')
@UseGuards(AdminGuard)
export class SoakTestController {
  private readonly logger = new Logger(SoakTestController.name);

  constructor(
    private readonly supabase: SupabaseService,
    @InjectQueue(QUEUE_NAMES.SOCIAL_PUBLISH)
    private readonly publishQueue: Queue,
  ) {}

  @Get('stats')
  async getSoakTestStats(): Promise<SoakTestStats> {
    const client = this.supabase.getServiceClient();

    // Find soak test users
    const { data: users } = await client
      .from('profiles')
      .select('id')
      .ilike('email', '%soak-%@trndinn-test.internal');

    if (!users || users.length === 0) {
      // Return empty stats if no soak test users
      return this.getEmptyStats();
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

  private getEmptyStats(): SoakTestStats {
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
}
