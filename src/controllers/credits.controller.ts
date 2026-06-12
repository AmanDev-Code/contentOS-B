import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import {
  CreditBucketService,
  type CreditBalance,
} from '../services/credit-bucket.service';
import {
  buildCreditCostMatrix,
  type CreditCostMatrix,
} from '../modules/credits/credit-costs';

/**
 * Sprint 1.9b — credit endpoints.
 *
 * `GET /credits/costs`   — the canonical cost matrix (single source of truth)
 *                          so the frontend computes the same numbers / strings.
 * `GET /credits/balance` — the authoritative multi-bucket balance for the
 *                          authed user (trial / plan / reward + expiry/reset).
 *
 * Neither endpoint blocks anything; the only credit gate remains the existing
 * "insufficient credits for this action's cost" check at charge time.
 *
 * NOTE: not behind PaywallGuard — balance + costs must be readable for
 * over-limit / lapsed / trial-expired users so the panel always renders.
 */
@Controller('credits')
@UseGuards(AuthGuard)
export class CreditsController {
  constructor(private readonly creditBucketService: CreditBucketService) {}

  /** Public-to-authed cost matrix. Cacheable; identical for everyone. */
  @Get('costs')
  getCosts(): { costs: CreditCostMatrix } {
    return { costs: buildCreditCostMatrix() };
  }

  /** Authed user's current multi-bucket balance. */
  @Get('balance')
  async getBalance(
    @Req() req: { user?: { id?: string } },
  ): Promise<CreditBalance> {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    return this.creditBucketService.getBalance(userId);
  }
}
