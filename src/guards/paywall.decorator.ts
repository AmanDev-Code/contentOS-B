import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PLAN_FEATURE_KEY = 'require_plan_feature';

/**
 * Require a specific plan feature (from `plans.config.ts`) for this route.
 *
 * Example:
 *   @RequirePlanFeature('Content scheduling')
 *   some handler...
 */
export function RequirePlanFeature(feature: string) {
  return SetMetadata(REQUIRE_PLAN_FEATURE_KEY, feature);
}

