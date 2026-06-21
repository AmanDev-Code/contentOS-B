import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { QuotaService } from '../services/quota.service';
import {
  calculateTotalCredits,
  buildCreditSlices,
  CreditSlice,
  normalizeCustomTopicContentType,
} from '../modules/credits/pricing';

export interface CreditPreflightData {
  totalCost: number;
  creditSlices: CreditSlice[];
}

/**
 * Runs AFTER AuthGuard. Computes the credit cost of the incoming custom-topic
 * request and rejects with 402 if the user's balance is insufficient.
 *
 * On success, attaches `req.creditPreflight` so the controller can forward
 * the pre-computed cost and slices without recalculating.
 */
@Injectable()
export class CreditPreflightGuard implements CanActivate {
  private readonly logger = new Logger(CreditPreflightGuard.name);

  constructor(private readonly quotaService: QuotaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<any>();

    const userId: string | undefined = req.user?.id;
    if (!userId) return true; // AuthGuard should have rejected already

    const body = req.body ?? {};
    const contentType = normalizeCustomTopicContentType(body.contentType);
    const imageCount: number | undefined = body.imageCount;
    const slideCount: number | undefined = body.slideCount;

    const totalCost = calculateTotalCredits(
      contentType,
      imageCount,
      slideCount,
    );
    const creditSlices = buildCreditSlices(contentType, imageCount, slideCount);

    const hasQuota = await this.quotaService.checkQuotaAvailable(
      userId,
      totalCost,
    );

    if (!hasQuota) {
      const quota = await this.quotaService.getUserQuota(userId);
      this.logger.warn(
        `Insufficient credits: user=${userId} required=${totalCost} available=${quota.remainingCredits}`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          code: 'insufficient_credits',
          message: `This generation requires ${totalCost} credits but you only have ${quota.remainingCredits} remaining.`,
          required: totalCost,
          available: quota.remainingCredits,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    req.creditPreflight = {
      totalCost,
      creditSlices,
    } satisfies CreditPreflightData;
    return true;
  }
}
