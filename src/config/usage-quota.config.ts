// Sprint 1.9 — Usage Tracking Foundation (DATA ONLY, NO ENFORCEMENT).
//
// Display-only quota numbers for the usage dashboard panel ("X of Y posts used
// this billing period"). These are NOT enforced anywhere — quota enforcement is
// deferred to Phase 2 (Sprint 1.9b). This file purely maps a stored
// `user_subscriptions.plan_type` to the numbers we *show* the user.
//
// The internal plan types stored in the DB are `free | standard | pro | ultimate`.
// The CEO-facing / marketing plan names are Solo / Growth / Agency. The mapping
// below pairs them together so the panel can render a friendly name + a cap.
//
// TODO(confirm-with-CEO): The Solo/Growth/Agency ↔ standard/pro/ultimate pairing
// and the exact post caps (Solo=30, Growth=200, Agency=1000, from the locked
// Phase 1 plan) are best-guess defaults pending CEO confirmation. Do NOT treat
// these as final, and do NOT hard-block on them — they are display-only.
// AI-generation caps are intentionally left null (no confirmed per-plan cap yet;
// the existing credit system governs AI cost). Per-plan AI-generation caps are a
// Phase 2 deliverable (see architecture map §10.3).

export interface UsagePlanQuota {
  /** Internal plan_type as stored in `user_subscriptions.plan_type`. */
  planType: 'free' | 'standard' | 'pro' | 'ultimate';
  /** CEO/marketing-facing display name shown in the UI. */
  displayName: string;
  /**
   * Posts the plan includes per billing period for DISPLAY ONLY.
   * `null` => unlimited / no cap shown (panel renders "X posts" with no "of Y").
   */
  postsPerPeriod: number | null;
  /**
   * AI generations included per billing period for DISPLAY ONLY.
   * `null` => no confirmed cap (panel renders "X generations" with no "of Y").
   */
  aiGenerationsPerPeriod: number | null;
}

/**
 * Plan → display-quota mapping. Keyed by internal `plan_type`.
 * TODO(confirm-with-CEO): numbers below are the locked-plan defaults, unconfirmed.
 */
export const USAGE_PLAN_QUOTAS: Record<string, UsagePlanQuota> = {
  free: {
    planType: 'free',
    displayName: 'Free Trial',
    postsPerPeriod: 5, // TODO(confirm-with-CEO): trial post cap not in locked plan.
    aiGenerationsPerPeriod: null,
  },
  standard: {
    planType: 'standard',
    displayName: 'Solo',
    postsPerPeriod: 30, // TODO(confirm-with-CEO): Solo=30 from locked Phase 1 plan.
    aiGenerationsPerPeriod: null,
  },
  pro: {
    planType: 'pro',
    displayName: 'Growth',
    postsPerPeriod: 200, // TODO(confirm-with-CEO): Growth=200 from locked Phase 1 plan.
    aiGenerationsPerPeriod: null,
  },
  ultimate: {
    planType: 'ultimate',
    displayName: 'Agency',
    postsPerPeriod: 1000, // TODO(confirm-with-CEO): Agency=1000 from locked Phase 1 plan.
    aiGenerationsPerPeriod: null,
  },
};

/**
 * Resolve display quota for a plan type. Unknown / missing plans fall back to a
 * graceful "no cap" tier so the panel never blocks or throws on unexpected data.
 */
export function getUsagePlanQuota(planType?: string | null): UsagePlanQuota {
  if (planType && USAGE_PLAN_QUOTAS[planType]) {
    return USAGE_PLAN_QUOTAS[planType];
  }
  return {
    planType: (planType as UsagePlanQuota['planType']) ?? 'free',
    displayName: planType ? planType : 'Free',
    postsPerPeriod: null,
    aiGenerationsPerPeriod: null,
  };
}
