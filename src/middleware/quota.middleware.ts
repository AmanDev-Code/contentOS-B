import {
  Injectable,
  NestMiddleware,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { QuotaService } from '../services/quota.service';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
}

@Injectable()
export class QuotaMiddleware implements NestMiddleware {
  constructor(private readonly quotaService: QuotaService) {}

  async use(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    // Skip quota check for non-generation endpoints
    const skipPaths = ['/auth', '/health', '/quota'];
    const isSkipPath = skipPaths.some((path) => req.path.startsWith(path));

    if (isSkipPath || req.method === 'GET') {
      return next();
    }

    // Skip if no user (will be handled by auth middleware)
    if (!req.user?.id) {
      return next();
    }

    try {
      // Check quota for generation endpoints
      const isGenerationEndpoint =
        req.path.includes('/generation/') &&
        (req.path.includes('/topics') || req.path.includes('/generate'));

      if (isGenerationEndpoint) {
        const hasQuota = await this.quotaService.checkQuotaAvailable(
          req.user.id,
          1,
        );

        if (!hasQuota) {
          const quota = await this.quotaService.getUserQuota(req.user.id);

          throw new HttpException(
            {
              statusCode: HttpStatus.PAYMENT_REQUIRED,
              message: 'Quota exceeded',
              error: 'Insufficient credits',
              quota: {
                totalCredits: quota.totalCredits,
                usedCredits: quota.usedCredits,
                remainingCredits: quota.remainingCredits,
                percentageUsed: quota.percentageUsed,
                planType: quota.planType,
                resetDate: quota.resetDate,
              },
            },
            HttpStatus.PAYMENT_REQUIRED,
          );
        }
      }

      next();
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      console.error('Quota middleware error:', error);
      next(); // Continue on error to avoid blocking requests
    }
  }
}
