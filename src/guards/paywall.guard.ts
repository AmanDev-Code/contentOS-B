import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionService } from '../services/subscription.service';
import { getPlanConfig } from '../config/plans.config';
import { REQUIRE_PLAN_FEATURE_KEY } from './paywall.decorator';

/**
 * Centralized subscription gate for paywalled features.
 *
 * Note: This is intentionally "authorization-only" (no credit deduction here).
 * All credit deduction + refund logic stays in controllers/services where
 * the exact credit cost is known.
 */
@Injectable()
export class PaywallGuard implements CanActivate {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<any>();
    const url: string = req?.originalUrl || req?.url || '';
    const method: string = (req?.method || '').toUpperCase();
    const userId: string | undefined = req?.user?.id;

    // Never block public/unauthed requests.
    if (!userId) return true;

    // Allow these routes even if a user has no active subscription
    // (needed for the user to manage billing or view non-paywalled resources).
    const allowlistPrefixes = [
      '/health',
      '/auth',
      '/onboarding',
      '/webhook',
      '/public',
      '/subscription',
      '/billing',
      '/quota',
    ];
    if (allowlistPrefixes.some((p) => url.startsWith(p))) return true;

    // Admin endpoints are already protected by AdminGuard.
    if (url.startsWith('/admin')) return true;

    // Payload-less preflight requests should never be blocked.
    if (method === 'OPTIONS') return true;

    // Decide which controllers are paywalled.
    // These endpoints represent the paid features (credits/subscription-gated).
    const paywallPrefixes = ['/generation', '/posts', '/media', '/linkedin', '/content'];
    const isPaywalled = paywallPrefixes.some((p) => url.startsWith(p));
    if (!isPaywalled) return true;

    const subscription = await this.subscriptionService.getUserSubscription(
      userId,
    );

    if (!subscription || !subscription.isActive) {
      throw new HttpException(
        'Subscription required to use this feature.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // Optional: enforce specific plan features using decorator metadata.
    const requiredFeature = this.reflector.getAllAndOverride<string>(
      REQUIRE_PLAN_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredFeature) {
      const planConfig = getPlanConfig(subscription.planType);
      if (!planConfig) {
        throw new HttpException(
          'Invalid plan configuration.',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      if (!planConfig.features.includes(requiredFeature)) {
        throw new HttpException(
          'Your plan does not include this feature.',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
    }

    return true;
  }
}

