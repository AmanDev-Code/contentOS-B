#!/usr/bin/env node
/**
 * Polar Products Setup Script
 *
 * Creates products and prices in Polar for the SaaS application via API.
 * Run with: npx ts-node scripts/setup-polar-products.ts
 *
 * Required Environment Variables:
 * - POLAR_ACCESS_TOKEN - Your Polar API access token
 * - POLAR_ORGANIZATION_ID - Your Polar organization ID
 * - POLAR_MODE - 'sandbox' or 'production'
 * - POLAR_WEBHOOK_SECRET - Your webhook secret (for output)
 * - FRONTEND_URL - Your frontend URL for success redirects
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from backend/.env
config({ path: resolve(__dirname, '../.env') });

// Plan configuration - Polar only allows 1 static price per product
// So we create separate products for monthly and yearly
const PLANS = [
  {
    planType: 'standard_monthly',
    basePlanId: 'standard',
    name: 'Trndinn Standard (Monthly)',
    description: 'Perfect for individual creators and small teams. Monthly billing.',
    price: 1500, // cents
    displayPrice: 15,
    interval: 'month',
  },
  {
    planType: 'standard_yearly',
    basePlanId: 'standard',
    name: 'Trndinn Standard (Yearly)',
    description: 'Perfect for individual creators and small teams. Yearly billing (~17% off).',
    price: 15000, // cents
    displayPrice: 150,
    interval: 'year',
  },
  {
    planType: 'pro_monthly',
    basePlanId: 'pro',
    name: 'Trndinn Pro (Monthly)',
    description: 'For growing teams with collaboration features. Monthly billing.',
    price: 2900, // cents
    displayPrice: 29,
    interval: 'month',
  },
  {
    planType: 'pro_yearly',
    basePlanId: 'pro',
    name: 'Trndinn Pro (Yearly)',
    description: 'For growing teams with collaboration features. Yearly billing (~17% off).',
    price: 29000, // cents
    displayPrice: 290,
    interval: 'year',
  },
  {
    planType: 'ultimate_monthly',
    basePlanId: 'ultimate',
    name: 'Trndinn Ultimate (Monthly)',
    description: 'For agencies and enterprises. Monthly billing.',
    price: 4900, // cents
    displayPrice: 49,
    interval: 'month',
  },
  {
    planType: 'ultimate_yearly',
    basePlanId: 'ultimate',
    name: 'Trndinn Ultimate (Yearly)',
    description: 'For agencies and enterprises. Yearly billing (~17% off).',
    price: 49000, // cents
    displayPrice: 490,
    interval: 'year',
  },
] as const;

// Get configuration from environment variables
const ACCESS_TOKEN = process.env.POLAR_ACCESS_TOKEN || '';
const ORG_ID = process.env.POLAR_ORGANIZATION_ID || '';
const MODE = (process.env.POLAR_MODE || 'sandbox').toLowerCase();
const WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const BASE_URL = MODE === 'production' ? 'https://api.polar.sh' : 'https://sandbox-api.polar.sh';

// Validate required environment variables
function validateEnv(): boolean {
  const missing: string[] = [];

  if (!ACCESS_TOKEN) {
    missing.push('POLAR_ACCESS_TOKEN');
  }
  if (!ORG_ID) {
    missing.push('POLAR_ORGANIZATION_ID');
  }

  if (missing.length > 0) {
    console.error('❌ ERROR: Missing required environment variables:');
    for (const env of missing) {
      console.error(`   - ${env}`);
    }
    console.error('');
    console.error('To fix this, run the following commands in your terminal:');
    console.error('');
    if (!ACCESS_TOKEN) {
      console.error('  echo "POLAR_ACCESS_TOKEN=your_polar_access_token" >> backend/.env');
    }
    if (!ORG_ID) {
      console.error('  echo "POLAR_ORGANIZATION_ID=your_organization_id" >> backend/.env');
    }
    console.error('');
    console.error('Then re-run this script.');
    return false;
  }

  return true;
}

interface ProductResult {
  productId: string;
  priceId: string;
  checkoutUrl: string;
  basePlanId: string;
  interval: string;
  displayPrice: number;
  error?: string;
}

async function polarApiRequest(endpoint: string, method: string, body?: any): Promise<any> {
  const url = `${BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`API Error ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function createProduct(plan: typeof PLANS[number]): Promise<ProductResult> {
  console.log(`\n--- Creating ${plan.name} ---`);

  // Create product with one price
  const productData = {
    name: plan.name,
    description: plan.description,
    recurring_interval: plan.interval,
    prices: [
      {
        amount_type: 'fixed',
        price_amount: plan.price,
        price_currency: 'usd',
      },
    ],
    metadata: {
      plan_type: plan.basePlanId,
      billing_interval: plan.interval,
    },
  };

  const product = await polarApiRequest('/v1/products', 'POST', productData);

  const productId = product.id;
  const prices = product.prices || [];
  const priceId = prices[0]?.id;

  console.log(`  ✅ Product: ${productId}`);
  console.log(`  ✅ Price: ${priceId} ($${plan.displayPrice}/${plan.interval})`);

  // Create checkout session
  let checkoutUrl = '';
  try {
    const checkout = await polarApiRequest('/v1/checkouts', 'POST', {
      products: [productId],
      success_url: `${FRONTEND_URL}/checkout/success?checkout_id={CHECKOUT_ID}`,
    });
    checkoutUrl = checkout.url;
    console.log(`  ✅ Checkout URL: ${checkoutUrl}`);
  } catch (e: any) {
    console.error(`  ⚠️  Checkout creation failed: ${e.message}`);
    checkoutUrl = `${BASE_URL.replace('-api', '')}/checkout/${productId}`;
  }

  return {
    productId,
    priceId,
    checkoutUrl,
    basePlanId: plan.basePlanId,
    interval: plan.interval,
    displayPrice: plan.displayPrice,
  };
}

async function main() {
  // Validate environment variables
  if (!validateEnv()) {
    process.exit(1);
  }

  console.log('='.repeat(80));
  console.log(`Setting up Polar products in ${MODE.toUpperCase()} mode`);
  console.log(`Organization ID: ${ORG_ID}`);
  console.log(`API Base URL: ${BASE_URL}`);
  console.log('='.repeat(80));
  console.log();

  const results: ProductResult[] = [];

  for (const plan of PLANS) {
    try {
      const result = await createProduct(plan);
      results.push(result);
    } catch (error: any) {
      console.error(`  ❌ Failed: ${error.message}`);
      results.push({
        productId: '',
        priceId: '',
        checkoutUrl: '',
        basePlanId: plan.basePlanId,
        interval: plan.interval,
        displayPrice: plan.displayPrice,
        error: error.message,
      });
    }
  }

  // Organize results by base plan
  const organized: Record<string, { monthly?: ProductResult; yearly?: ProductResult }> = {};
  for (const r of results) {
    if (!organized[r.basePlanId]) {
      organized[r.basePlanId] = {};
    }
    organized[r.basePlanId][r.interval as 'month' | 'year'] = r;
  }

  // Output summary
  printEnvVariables(organized);
  await saveResults(organized);
  printNextSteps();
}

function printEnvVariables(organized: Record<string, { monthly?: ProductResult; yearly?: ProductResult }>) {
  console.log('\n' + '='.repeat(80));
  console.log('ENVIRONMENT VARIABLES - Copy these to your .env files');
  console.log('='.repeat(80));

  // Backend .env
  console.log('\n# === Backend .env ===');
  console.log(`POLAR_ACCESS_TOKEN=${ACCESS_TOKEN}`);
  console.log(`POLAR_ENV=${MODE}`);
  console.log(`POLAR_ORGANIZATION_ID=${ORG_ID}`);
  if (WEBHOOK_SECRET) {
    console.log(`POLAR_WEBHOOK_SECRET=${WEBHOOK_SECRET}`);
  }

  console.log('\n# Product IDs');
  for (const [planType, data] of Object.entries(organized)) {
    if (data.monthly?.productId) {
      console.log(`POLAR_PRODUCT_${planType.toUpperCase()}_MONTHLY=${data.monthly.productId}`);
    }
    if (data.yearly?.productId) {
      console.log(`POLAR_PRODUCT_${planType.toUpperCase()}_YEARLY=${data.yearly.productId}`);
    }
  }

  console.log('\n# Price IDs');
  for (const [planType, data] of Object.entries(organized)) {
    if (data.monthly?.priceId) {
      console.log(`POLAR_PRICE_${planType.toUpperCase()}_MONTHLY=${data.monthly.priceId}`);
    }
    if (data.yearly?.priceId) {
      console.log(`POLAR_PRICE_${planType.toUpperCase()}_YEARLY=${data.yearly.priceId}`);
    }
  }

  // Frontend .env
  console.log('\n# === Frontend .env ===');
  console.log(`NEXT_PUBLIC_POLAR_MODE=${MODE}`);
  console.log(`NEXT_PUBLIC_POLAR_ORGANIZATION=${ORG_ID}`);

  console.log('\n# Price IDs (for SDK checkout)');
  for (const [planType, data] of Object.entries(organized)) {
    if (data.monthly?.priceId) {
      console.log(`NEXT_PUBLIC_POLAR_PRICE_${planType.toUpperCase()}_MONTHLY=${data.monthly.priceId}`);
    }
    if (data.yearly?.priceId) {
      console.log(`NEXT_PUBLIC_POLAR_PRICE_${planType.toUpperCase()}_YEARLY=${data.yearly.priceId}`);
    }
  }

  console.log('\n# Checkout URLs');
  for (const [planType, data] of Object.entries(organized)) {
    if (data.monthly?.checkoutUrl) {
      console.log(`NEXT_PUBLIC_POLAR_CHECKOUT_${planType.toUpperCase()}_MONTHLY=${data.monthly.checkoutUrl}`);
    }
    if (data.yearly?.checkoutUrl) {
      console.log(`NEXT_PUBLIC_POLAR_CHECKOUT_${planType.toUpperCase()}_YEARLY=${data.yearly.checkoutUrl}`);
    }
  }
}

async function saveResults(organized: Record<string, { monthly?: ProductResult; yearly?: ProductResult }>) {
  const fs = await import('fs/promises');
  const path = await import('path');

  const outputPath = path.join(process.cwd(), `polar-setup-results-${MODE}-${Date.now()}.json`);
  const output = {
    timestamp: new Date().toISOString(),
    mode: MODE,
    credentials: {
      orgId: ORG_ID,
    },
    results: organized,
    env_backend: generateEnvBackend(organized),
    env_frontend: generateEnvFrontend(organized),
  };

  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Full results saved to: ${outputPath}`);
}

function generateEnvBackend(organized: Record<string, { monthly?: ProductResult; yearly?: ProductResult }>): string {
  let env = `# Polar Payment Configuration\n`;
  env += `POLAR_ACCESS_TOKEN=${ACCESS_TOKEN}\n`;
  env += `POLAR_ENV=${MODE}\n`;
  env += `POLAR_ORGANIZATION_ID=${ORG_ID}\n`;
  if (WEBHOOK_SECRET) {
    env += `POLAR_WEBHOOK_SECRET=${WEBHOOK_SECRET}\n`;
  }
  env += `\n`;

  env += `# Product IDs\n`;
  for (const [planType, data] of Object.entries(organized)) {
    if (data.monthly?.productId) {
      env += `POLAR_PRODUCT_${planType.toUpperCase()}_MONTHLY=${data.monthly.productId}\n`;
    }
    if (data.yearly?.productId) {
      env += `POLAR_PRODUCT_${planType.toUpperCase()}_YEARLY=${data.yearly.productId}\n`;
    }
  }

  env += `\n# Price IDs\n`;
  for (const [planType, data] of Object.entries(organized)) {
    if (data.monthly?.priceId) {
      env += `POLAR_PRICE_${planType.toUpperCase()}_MONTHLY=${data.monthly.priceId}\n`;
    }
    if (data.yearly?.priceId) {
      env += `POLAR_PRICE_${planType.toUpperCase()}_YEARLY=${data.yearly.priceId}\n`;
    }
  }

  return env;
}

function generateEnvFrontend(organized: Record<string, { monthly?: ProductResult; yearly?: ProductResult }>): string {
  let env = `# Polar Payment Configuration\n`;
  env += `NEXT_PUBLIC_POLAR_MODE=${MODE}\n`;
  env += `NEXT_PUBLIC_POLAR_ORGANIZATION=${ORG_ID}\n\n`;

  env += `# Price IDs (for SDK checkout)\n`;
  for (const [planType, data] of Object.entries(organized)) {
    if (data.monthly?.priceId) {
      env += `NEXT_PUBLIC_POLAR_PRICE_${planType.toUpperCase()}_MONTHLY=${data.monthly.priceId}\n`;
    }
    if (data.yearly?.priceId) {
      env += `NEXT_PUBLIC_POLAR_PRICE_${planType.toUpperCase()}_YEARLY=${data.yearly.priceId}\n`;
    }
  }

  env += `\n# Checkout URLs\n`;
  for (const [planType, data] of Object.entries(organized)) {
    if (data.monthly?.checkoutUrl) {
      env += `NEXT_PUBLIC_POLAR_CHECKOUT_${planType.toUpperCase()}_MONTHLY=${data.monthly.checkoutUrl}\n`;
    }
    if (data.yearly?.checkoutUrl) {
      env += `NEXT_PUBLIC_POLAR_CHECKOUT_${planType.toUpperCase()}_YEARLY=${data.yearly.checkoutUrl}\n`;
    }
  }

  return env;
}

function printNextSteps() {
  const dashboardUrl = MODE === 'production' ? 'https://polar.sh' : 'https://sandbox.polar.sh';

  console.log('\n' + '='.repeat(80));
  console.log('NEXT STEPS:');
  console.log('='.repeat(80));
  console.log('1. Copy the environment variables above to:');
  console.log('   - backend/.env');
  console.log('   - frontend/.env.local');
  console.log('');
  console.log('2. Test the checkout flow:');
  console.log('   - Use the checkout URLs from above');
  console.log('   - Test with test card: 4242 4242 4242 4242');
  console.log('');
  console.log('3. Configure webhook in Polar Dashboard:');
  console.log(`   - Go to: ${dashboardUrl}`);
  console.log('   - Navigate to Settings → Webhooks');
  console.log('   - Add webhook URL: https://your-domain.com/api/polar/webhook');
  console.log('   - Enable events: checkout.created, checkout.completed,');
  console.log('     subscription.created, subscription.active, subscription.updated,');
  console.log('     subscription.canceled, order.paid, order.refunded');
  console.log('='.repeat(80));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
