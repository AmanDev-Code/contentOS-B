import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';
import { PlatformStaffGuard } from '../guards/platform-staff.guard';
import { AdminGuard } from '../guards/admin.guard';
import { SupabaseService } from '../services/supabase.service';
import { NotificationService } from '../services/notification.service';
import { SubscriptionService } from '../services/subscription.service';
import { QuotaService } from '../services/quota.service';
import { CacheService } from '../services/cache.service';
import { OnboardingService } from '../services/onboarding.service';

interface AuthReq extends Request {
  user: { id: string; email: string };
}

const ALLOWED_STATUS = new Set(['active', 'suspended', 'banned']);

@ApiTags('platform-admin')
@Controller('platform-admin/users')
@UseGuards(AuthGuard, PaywallGuard, PlatformStaffGuard)
@ApiBearerAuth()
export class PlatformUsersController {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly notificationService: NotificationService,
    private readonly subscriptionService: SubscriptionService,
    private readonly quotaService: QuotaService,
    private readonly cacheService: CacheService,
    private readonly onboardingService: OnboardingService,
  ) {}

  /** Same semantics as QuotaService when `user_quota_view` has no row (no active subscription). */
  private freeQuotaFallback() {
    return {
      remainingCredits: 150,
      usedCredits: 0,
      totalCredits: 150,
      percentageUsed: 0,
      planType: 'free' as const,
      resetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  private async quotasForUserIds(userIds: string[]) {
    const map = new Map<
      string,
      {
        remainingCredits: number;
        usedCredits: number;
        totalCredits: number;
        percentageUsed: number;
        planType: string;
        resetDate: string | null;
      }
    >();
    if (userIds.length === 0) return map;

    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('user_quota_view')
      .select(
        'user_id, remaining_credits, used_credits, total_credits, plan_type, percentage_used, reset_date',
      )
      .in('user_id', userIds);

    if (error) {
      throw new BadRequestException(error.message);
    }

    for (const row of data ?? []) {
      const uid = row.user_id as string;
      map.set(uid, {
        remainingCredits: Number(row.remaining_credits ?? 0),
        usedCredits: Number(row.used_credits ?? 0),
        totalCredits: Number(row.total_credits ?? 0),
        percentageUsed: Number(row.percentage_used ?? 0),
        planType: String(row.plan_type ?? 'free'),
        resetDate: row.reset_date
          ? new Date(row.reset_date as string).toISOString()
          : null,
      });
    }

    return map;
  }

  private async metricsSummaryPayload() {
    const client = this.supabaseService.getServiceClient();

    const users = await client
      .from('profiles')
      .select('*', { count: 'exact', head: true });

    const feedback = await client
      .from('product_feedback')
      .select('*', { count: 'exact', head: true });

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recent = await client
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', sevenDaysAgo.toISOString());

    return {
      totalUsers: users.count ?? 0,
      feedbackSubmissions: feedback.count ?? 0,
      signupsLast7Days: recent.count ?? 0,
    };
  }

  @Get('metrics/summary')
  @ApiOperation({ summary: 'Counts for growth / retention stubs (staff)' })
  async metricsSummary() {
    return this.metricsSummaryPayload();
  }

  @Get('metrics/dashboard')
  @ApiOperation({
    summary:
      'Summary + daily series for charts (staff); requires DB fn when deployed',
  })
  async metricsDashboard(@Query('days') days?: string) {
    const d = Math.min(90, Math.max(1, parseInt(days || '30', 10) || 30));
    const summary = await this.metricsSummaryPayload();

    const client = this.supabaseService.getServiceClient();
    const { data: tsRaw, error } = await client.rpc(
      'admin_metrics_timeseries_agg',
      {
        p_days: d,
      },
    );

    let signupsByDay: { date: string; count: number }[] = [];
    let feedbackByDay: { date: string; count: number }[] = [];

    if (!error && tsRaw && typeof tsRaw === 'object') {
      const ts = tsRaw as {
        signupsByDay?: { date: string; count: number }[];
        feedbackByDay?: { date: string; count: number }[];
      };
      signupsByDay = Array.isArray(ts.signupsByDay) ? ts.signupsByDay : [];
      feedbackByDay = Array.isArray(ts.feedbackByDay) ? ts.feedbackByDay : [];
    }

    return {
      summary,
      signupsByDay,
      feedbackByDay,
      days: d,
      timeseriesAvailable: !error,
    };
  }

  @Get()
  @ApiOperation({ summary: 'Search profiles (staff)' })
  async list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
  ) {
    const p = Math.max(1, page ? parseInt(page, 10) || 1 : 1);
    const l = Math.min(50, Math.max(1, limit ? parseInt(limit, 10) || 20 : 20));
    const offset = (p - 1) * l;
    const term = (q || '').trim();

    let query = this.supabaseService
      .getServiceClient()
      .from('profiles')
      .select(
        'id, username, full_name, plan, account_status, credits_remaining, created_at',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + l - 1);

    if (term.length > 0) {
      const safe = term.replace(/%/g, '').slice(0, 80);
      query = query.or(`username.ilike.%${safe}%,full_name.ilike.%${safe}%`);
    }

    const { data, error, count } = await query;
    if (error) {
      throw new BadRequestException(error.message);
    }

    const rows = data || [];
    const quotaMap = await this.quotasForUserIds(
      rows.map((r) => r.id as string),
    );
    const items = rows.map((row) => {
      const q = quotaMap.get(row.id as string) ?? this.freeQuotaFallback();
      return {
        ...row,
        quota: q,
      };
    });

    return {
      items,
      total: count ?? 0,
      page: p,
      limit: l,
    };
  }

  @Get(':userId/billing')
  @ApiOperation({
    summary: 'Invoice rows persisted from billing webhooks (staff)',
  })
  async userBilling(@Param('userId') userId: string) {
    const { data, error } = await this.supabaseService
      .getServiceClient()
      .from('billing_invoices')
      .select(
        'id, polar_order_id, invoice_number, status, amount, currency, invoice_url, issued_at',
      )
      .eq('user_id', userId)
      .order('issued_at', { ascending: false, nullsFirst: false })
      .limit(80);

    if (error) {
      throw new BadRequestException(error.message);
    }

    return {
      items: data ?? [],
      source: 'billing_invoices',
    };
  }

  @Patch(':userId/credits')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Adjust credits (+/-); notifies user in-app (super-admin)',
  })
  async adjustCredits(
    @Param('userId') userId: string,
    @Body() body: { delta?: number; reason?: string },
    @Request() req: AuthReq,
  ) {
    const delta = Math.round(Number(body?.delta));
    if (!Number.isFinite(delta) || delta === 0) {
      throw new BadRequestException('delta must be a non-zero finite number');
    }

    const { data: profileRow, error: loadErr } = await this.supabaseService
      .getServiceClient()
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (loadErr) {
      throw new BadRequestException(loadErr.message);
    }
    if (!profileRow) {
      throw new NotFoundException('User not found');
    }

    const reason = (body?.reason || '').trim();
    const description = `Admin credit adjustment${reason ? `: ${reason}` : ''}`;
    const adminId = req?.user?.id ?? null;

    // Sprint 1.9b: route admin adjustments through the bucket-aware paths so the
    // change actually moves the authoritative multi-bucket balance (the legacy
    // logTransaction call only wrote a credit_transactions audit row and did not
    // touch any bucket, so it no longer affected the displayed balance).
    if (delta > 0) {
      // Positive grant -> never-expiring REWARD bucket (operation_type 'admin_grant').
      await this.quotaService.grantCredits(
        userId,
        delta,
        description,
        'admin_grant',
        {
          source: 'admin',
          admin_id: adminId,
          reason: reason || undefined,
        },
      );
    } else {
      // Negative adjustment/correction -> bucket-aware debit (deducts trial -> plan
      // -> reward), recorded as operation_type 'admin_adjustment'.
      await this.quotaService.consumeCredits(
        userId,
        Math.abs(delta),
        description,
        'admin_adjustment',
        undefined,
        undefined,
        { source: 'admin', admin_id: adminId, reason: reason || undefined },
      );
    }

    await this.cacheService.delete(`quota:${userId}`);

    const quota = await this.quotaService.getUserQuota(userId, {
      bypassCache: true,
    });
    const nextRemaining = Math.max(0, Math.round(quota.remainingCredits));

    const { error: syncErr } = await this.supabaseService
      .getServiceClient()
      .from('profiles')
      .update({
        credits_remaining: nextRemaining,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (syncErr) {
      throw new BadRequestException(syncErr.message);
    }

    await this.notificationService.createNotification({
      userId,
      title: 'Credits adjusted',
      message: `Your balance was updated by ${delta > 0 ? '+' : ''}${delta} credits.${reason ? ` Reason: ${reason}` : ''}`,
      type: 'info',
      category: 'credits',
      data: { credits: delta, reason: reason || undefined },
    });

    const resetIso =
      quota.resetDate instanceof Date
        ? quota.resetDate.toISOString()
        : new Date(quota.resetDate).toISOString();

    return {
      success: true,
      credits_remaining: nextRemaining,
      quota: {
        remainingCredits: quota.remainingCredits,
        usedCredits: quota.usedCredits,
        totalCredits: quota.totalCredits,
        percentageUsed: quota.percentageUsed,
        planType: quota.planType,
        resetDate: resetIso,
      },
    };
  }

  @Patch(':userId/plan')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary:
      'Set plan in DB (super-admin). Does not call Polar checkout — use for support overrides.',
  })
  async setPlan(
    @Param('userId') userId: string,
    @Body()
    body: {
      planType?: string;
      billingCycle?: 'monthly' | 'yearly';
    },
  ) {
    const planType = (body?.planType || '').trim();
    const billingCycle = body?.billingCycle;
    const allowed = new Set(['free', 'standard', 'pro', 'ultimate']);
    if (!allowed.has(planType)) {
      throw new BadRequestException(
        'planType must be free, standard, pro, or ultimate',
      );
    }
    if (billingCycle !== 'monthly' && billingCycle !== 'yearly') {
      throw new BadRequestException('billingCycle must be monthly or yearly');
    }

    const { data: row, error: loadErr } = await this.supabaseService
      .getServiceClient()
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (loadErr) {
      throw new BadRequestException(loadErr.message);
    }
    if (!row) {
      throw new NotFoundException('User not found');
    }

    await this.subscriptionService.updateSubscription(
      userId,
      planType,
      billingCycle,
    );

    const { error: planSyncErr } = await this.supabaseService
      .getServiceClient()
      .from('profiles')
      .update({
        plan: planType,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (planSyncErr) {
      throw new BadRequestException(planSyncErr.message);
    }

    await this.notificationService.createNotification({
      userId,
      title: 'Subscription updated',
      message: `Your plan was set to ${planType} (${billingCycle}) by an administrator.`,
      type: 'info',
      category: 'system',
    });

    return { success: true };
  }

  @Patch(':userId/status')
  @ApiOperation({ summary: 'Set account status + notify user (staff)' })
  async setStatus(
    @Request() req: AuthReq,
    @Param('userId') userId: string,
    @Body() body: { status: string; message?: string },
  ) {
    void req;
    const status = (body?.status || '').trim();
    if (!ALLOWED_STATUS.has(status)) {
      throw new BadRequestException(
        'status must be active, suspended, or banned',
      );
    }

    const { error } = await this.supabaseService
      .getServiceClient()
      .from('profiles')
      .update({
        account_status: status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) {
      throw new BadRequestException(error.message);
    }

    const msg =
      body.message?.trim() ||
      (status === 'active'
        ? 'Your account is active.'
        : status === 'suspended'
          ? 'Your account has been suspended. Contact support if this is unexpected.'
          : 'Your account access has been restricted.');

    await this.notificationService.createNotification({
      userId,
      title: 'Account status update',
      message: msg,
      type: status === 'active' ? 'info' : 'warning',
      category: 'system',
    });

    return { success: true, status };
  }

  @Get(':userId')
  @ApiOperation({ summary: 'Single profile + subscription row (staff)' })
  async getOne(@Param('userId') userId: string) {
    const client = this.supabaseService.getServiceClient();

    const { data: profile, error: pErr } = await client
      .from('profiles')
      .select(
        'id, username, full_name, plan, account_status, credits_remaining, created_at, updated_at',
      )
      .eq('id', userId)
      .maybeSingle();

    if (pErr) {
      throw new BadRequestException(pErr.message);
    }
    if (!profile) {
      throw new NotFoundException('User not found');
    }

    const { data: subscription } = await client
      .from('user_subscriptions')
      .select(
        'id, user_id, plan_type, billing_cycle, credits_limit, is_active, subscription_start_date, subscription_end_date, polar_subscription_id, polar_customer_id',
      )
      .eq('user_id', userId)
      .maybeSingle();

    // Always read `user_quota_view` fresh here. `getUserQuota` caches for interactive
    // endpoints; billing reads the view directly, so staff detail must match that source.
    const quota = await this.quotaService.getUserQuota(userId, {
      bypassCache: true,
    });

    const resetIso =
      quota.resetDate instanceof Date
        ? quota.resetDate.toISOString()
        : new Date(quota.resetDate).toISOString();

    return {
      profile,
      subscription,
      quota: {
        remainingCredits: quota.remainingCredits,
        usedCredits: quota.usedCredits,
        totalCredits: quota.totalCredits,
        percentageUsed: quota.percentageUsed,
        planType: quota.planType,
        resetDate: resetIso,
      },
    };
  }

  @Get(':userId/onboarding-responses')
  @ApiOperation({ summary: 'Get user onboarding responses (staff)' })
  async getUserOnboardingResponses(@Param('userId') userId: string) {
    const { data: profile, error: pErr } = await this.supabaseService
      .getServiceClient()
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (pErr) {
      throw new BadRequestException(pErr.message);
    }
    if (!profile) {
      throw new NotFoundException('User not found');
    }

    try {
      const responses =
        await this.onboardingService.getUserResponsesForAdmin(userId);
      const hasCompleted =
        await this.onboardingService.hasUserCompletedOnboarding(userId);

      return {
        success: true,
        data: {
          responses,
          hasCompletedOnboarding: hasCompleted,
          responseCount: responses.length,
        },
      };
    } catch (error) {
      throw new BadRequestException(
        error.message || 'Failed to fetch onboarding responses',
      );
    }
  }

  @Delete(':userId')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary:
      'Delete a user completely (super-admin). Cascades to all related data.',
  })
  async deleteUser(@Request() req: AuthReq, @Param('userId') userId: string) {
    if (req.user.id === userId) {
      throw new ForbiddenException('Cannot delete your own account');
    }

    const client = this.supabaseService.getServiceClient();

    const { data: profile, error: loadErr } = await client
      .from('profiles')
      .select('id, username, full_name')
      .eq('id', userId)
      .maybeSingle();

    if (loadErr) {
      throw new BadRequestException(loadErr.message);
    }
    if (!profile) {
      throw new NotFoundException('User not found');
    }

    const userIdentifier =
      profile.username || profile.full_name || userId.slice(0, 8);

    const { error: deleteErr } = await client.auth.admin.deleteUser(userId);

    if (deleteErr) {
      console.error(
        `[AdminDeleteUser] Failed to delete user ${userId}:`,
        deleteErr,
      );
      throw new BadRequestException(
        `Failed to delete user: ${deleteErr.message}`,
      );
    }

    console.log(
      `[AdminDeleteUser] User deleted by admin ${req.user.id}: userId=${userId}, identifier=${userIdentifier}`,
    );

    return {
      success: true,
      message: `User ${userIdentifier} has been permanently deleted`,
      deletedUserId: userId,
    };
  }
}
