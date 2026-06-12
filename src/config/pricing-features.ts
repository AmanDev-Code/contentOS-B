/**
 * Pricing display Single-Source-Of-Truth (Phase 1.5 GTM).
 *
 * Marketing/billing must never drift: public plan names, credit allotments, and
 * default feature bullets are defined ONCE here and mirror the credit system
 * (backend/src/modules/credits/credit-costs.ts PLAN_CREDIT_ALLOTMENTS).
 *
 * Prices are NOT defined here — they are pulled live from Polar at runtime.
 * Feature bullets / descriptions / highlights are overridable via the
 * `site_content` table (key `pricing_meta`) from /admin/site-content.
 *
 * Public plan names (LOCKED #1036/Phase 1.5): Free / Creator / Team / Agency,
 * mapped onto the internal plan_type enum free / standard / pro / ultimate.
 */

export type InternalPlanType = 'free' | 'standard' | 'pro' | 'ultimate';

export interface PlanDisplayMeta {
  planType: InternalPlanType;
  /** Public marketing name (LOCKED). */
  publicName: string;
  tagline: string;
  /** Monthly credit allotment — mirrors credit-costs PLAN_CREDIT_ALLOTMENTS. */
  credits: number;
  /** Output translation shown next to credits (Predis-style), approximate. */
  creditsAsOutput: string;
  /** Marketing highlight badge, e.g. "Most popular". Empty = none. */
  highlight: string;
  /** Whether this tier is featured/most-popular in the grid. */
  featured: boolean;
  features: string[];
  ctaLabel: string;
}

/** Mirror of credit-costs.ts PLAN_CREDIT_ALLOTMENTS — keep in sync. */
export const PLAN_CREDIT_ALLOTMENTS: Record<InternalPlanType, number> = {
  free: 150,
  standard: 500,
  pro: 2000,
  ultimate: 10000,
};

export const PUBLIC_PLAN_NAMES: Record<InternalPlanType, string> = {
  free: 'Free',
  standard: 'Creator',
  pro: 'Team',
  ultimate: 'Agency',
};

/** Display order for the public pricing grid. */
export const PUBLIC_PLAN_ORDER: InternalPlanType[] = [
  'free',
  'standard',
  'pro',
  'ultimate',
];

export const DEFAULT_PLAN_DISPLAY_META: Record<InternalPlanType, PlanDisplayMeta> = {
  free: {
    planType: 'free',
    publicName: 'Free',
    tagline: 'Start creating with AI — no card required.',
    credits: PLAN_CREDIT_ALLOTMENTS.free,
    creditsAsOutput: '~25 AI posts to try the workflow',
    highlight: '',
    featured: false,
    ctaLabel: 'Start free',
    features: [
      '150 credits to start (14-day trial credits)',
      'Connect 1 LinkedIn account',
      'AI drafts from the examples you provide',
      'Schedule & publish to your connected account',
      'Calendar with drag-and-drop',
    ],
  },
  standard: {
    planType: 'standard',
    publicName: 'Creator',
    tagline: 'For solo creators publishing consistently.',
    credits: PLAN_CREDIT_ALLOTMENTS.standard,
    creditsAsOutput: '~80 AI posts or ~60 image posts / month',
    highlight: '',
    featured: false,
    ctaLabel: 'Choose Creator',
    features: [
      '500 credits / month',
      'Connect 1 LinkedIn account',
      'Brand Voice from your examples',
      'AI images & carousels',
      'Recurring schedules',
      'Publish history & logs',
    ],
  },
  pro: {
    planType: 'pro',
    publicName: 'Team',
    tagline: 'For teams that ship content as a system.',
    credits: PLAN_CREDIT_ALLOTMENTS.pro,
    creditsAsOutput: '~320 AI posts or ~130 carousels / month',
    highlight: 'Most popular',
    featured: true,
    ctaLabel: 'Choose Team',
    features: [
      '2,000 credits / month',
      'Everything in Creator',
      'Priority AI generation',
      'Public API v1 + webhooks',
      'Advanced analytics',
      'Priority support',
    ],
  },
  ultimate: {
    planType: 'ultimate',
    publicName: 'Agency',
    tagline: 'For agencies managing many brands at scale.',
    credits: PLAN_CREDIT_ALLOTMENTS.ultimate,
    creditsAsOutput: '~1,600 AI posts / month for multiple brands',
    highlight: 'Best value',
    featured: false,
    ctaLabel: 'Choose Agency',
    features: [
      '10,000 credits / month',
      'Everything in Team',
      'Highest rate limits',
      'Multi-brand workflows',
      'Dedicated onboarding',
      'SLA & priority support',
    ],
  },
};

export interface PricingMeta {
  plans: PlanDisplayMeta[];
  /** FAQ shown on the pricing page (admin-editable). */
  faqs: { q: string; a: string }[];
  /** Trust badges row labels. */
  trustBadges: string[];
  /** Annual discount note shown near the toggle. */
  annualNote: string;
}

export const DEFAULT_PRICING_META: PricingMeta = {
  plans: PUBLIC_PLAN_ORDER.map((pt) => DEFAULT_PLAN_DISPLAY_META[pt]),
  trustBadges: [
    'Cancel anytime',
    'Secure checkout via Polar',
    'You own your data',
    'GDPR · CCPA · DPDP aligned',
  ],
  annualNote: 'Save with annual billing — discount applied automatically at checkout.',
  faqs: [
    {
      q: 'How do credits work?',
      a: 'Credits power actions like generating, scheduling, and publishing. Each plan includes a monthly allotment; you can use credits on any action until your balance runs out.',
    },
    {
      q: 'Do credits roll over?',
      a: 'Plan credits reset each billing period. Trial credits expire 14 days after signup. Bonus/reward credits never expire.',
    },
    {
      q: 'Where does Trndinn’s AI get its “voice”?',
      a: 'Your Brand Voice is built only from the examples you provide. We never scrape your social feeds or train on connected-platform data.',
    },
    {
      q: 'Can I change or cancel my plan?',
      a: 'Yes — upgrade, downgrade, or cancel anytime. Cancellation stops future renewals and you keep access until the end of the period.',
    },
    {
      q: 'Which platforms are supported?',
      a: 'LinkedIn is live today, with more channels on the roadmap. You publish only to accounts you connect, and we comply with each platform’s policies.',
    },
  ],
};

export function publicPlanName(planType: string): string {
  return (
    PUBLIC_PLAN_NAMES[planType as InternalPlanType] ?? planType
  );
}
