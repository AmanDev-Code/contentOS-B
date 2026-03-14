// Backend Subscription Plans Configuration
// This should match the frontend config and database

export interface PlanConfiguration {
  planType: string;
  name: string;
  description: string;
  creditsLimit: number;
  priceMonthly: number;
  priceYearly: number;
  features: string[];
  isPublic: boolean; // Whether to show in public APIs
  trialDays?: number;
}

export const PLAN_CONFIGURATIONS: PlanConfiguration[] = [
  {
    planType: 'free',
    name: 'Free Trial',
    description: '14-day free trial for new users',
    creditsLimit: 50,
    priceMonthly: 0.0,
    priceYearly: 0.0,
    features: [
      '50 AI credits per month',
      'Basic content generation',
      'Community support',
      '14-day trial',
    ],
    isPublic: false, // Hidden from billing page
    trialDays: 14,
  },
  {
    planType: 'standard',
    name: 'Standard',
    description: 'Great for regular content creators',
    creditsLimit: 500,
    priceMonthly: 15.0,
    priceYearly: 150.0,
    features: [
      '500 AI credits per month',
      'Advanced content generation',
      'Priority support',
      'Analytics dashboard',
      'Content scheduling',
    ],
    isPublic: true,
  },
  {
    planType: 'pro',
    name: 'Pro',
    description: 'Perfect for businesses and agencies',
    creditsLimit: 2000,
    priceMonthly: 25.0,
    priceYearly: 250.0,
    features: [
      '2000 AI credits per month',
      'Premium content generation',
      'Advanced analytics',
      'Priority support',
      'Custom templates',
      'Team collaboration',
      'API access',
    ],
    isPublic: true,
  },
  {
    planType: 'ultimate',
    name: 'Ultimate',
    description: 'For enterprise and high-volume users',
    creditsLimit: 10000,
    priceMonthly: 49.0,
    priceYearly: 490.0,
    features: [
      '10000 AI credits per month',
      'Unlimited content generation',
      'Enterprise analytics',
      '24/7 support',
      'Custom integrations',
      'White-label options',
      'Dedicated account manager',
      'Custom workflows',
    ],
    isPublic: true,
  },
];

// Helper functions
export const getPublicPlans = () =>
  PLAN_CONFIGURATIONS.filter((plan) => plan.isPublic);

export const getPlanConfig = (planType: string) =>
  PLAN_CONFIGURATIONS.find((plan) => plan.planType === planType);

export const getFreePlan = () =>
  PLAN_CONFIGURATIONS.find((plan) => plan.planType === 'free');

export const calculateDiscount = (monthly: number, yearly: number) => {
  const monthlyTotal = monthly * 12;
  return Math.round(((monthlyTotal - yearly) / monthlyTotal) * 100);
};
