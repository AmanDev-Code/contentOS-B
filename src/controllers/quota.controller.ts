import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { QuotaService, UserQuota } from '../services/quota.service';
import { AuthGuard } from '../guards/auth.guard';
import { PaywallGuard } from '../guards/paywall.guard';

@Controller('quota')
@UseGuards(AuthGuard, PaywallGuard)
export class QuotaController {
  constructor(private readonly quotaService: QuotaService) {}

  @Get()
  async getUserQuota(@Req() req: any): Promise<UserQuota> {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('User not authenticated');
    }

    return this.quotaService.getUserQuota(userId);
  }

  @Get('check')
  async checkQuota(
    @Req() req: any,
  ): Promise<{ hasQuota: boolean; quota: UserQuota }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('User not authenticated');
    }

    const quota = await this.quotaService.getUserQuota(userId);
    const hasQuota = await this.quotaService.checkQuotaAvailable(userId, 1);

    return {
      hasQuota,
      quota,
    };
  }
}
