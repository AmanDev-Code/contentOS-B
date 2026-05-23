#!/usr/bin/env node
/**
 * Polar Checkout Links Creator
 *
 * Creates proper Checkout Links (visible in Polar Dashboard) via API.
 * These are different from Checkout Sessions - they are reusable and manageable.
 *
 * Checkout Links API: POST /v1/checkout-links/
 * - Creates persistent checkout URLs that appear in dashboard
 * - Can be retrieved via GET /v1/checkout-links/
 * - Can be updated/deleted via API
 *
 * Checkout Sessions API: POST /v1/checkouts
 * - Creates temporary one-time checkouts
 * - Do NOT appear in dashboard
 * - Used for dynamic per-user checkout creation
 *
 * Run with: npx ts-node scripts/create-polar-checkout-links.ts
 *
 * Required Environment Variables:
 * - POLAR_ACCESS_TOKEN - Your Polar API access token
 * - POLAR_ORGANIZATION_ID - Your Polar organization ID
 * - POLAR_MODE - 'sandbox' or 'production'
 * - FRONTEND_URL - Your frontend URL for success/cancel redirects
 * - POLAR_PRODUCT_* - Product IDs from your .env (will be loaded automatically)
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from backend/.env
config({ path: resolve(__dirname, '../.env') });

// Get configuration from environment variables
const ACCESS_TOKEN = process.env.POLAR_ACCESS_TOKEN || '';
const ORG_ID = process.env.POLAR_ORGANIZATION_ID || '';
const MODE = (process.env.POLAR_MODE || 'sandbox').toLowerCase();
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

// Product configuration - reads product IDs from environment
const PRODUCTS = [
  {
    key: 'STANDARD_MONTHLY',
    name: 'Trndinn Standard (Monthly)',
    get productId() {
      const id = process.env.POLAR_PRODUCT_STANDARD_MONTHLY || '';
      if (!id) {
        throw new Error('POLAR_PRODUCT_STANDARD_MONTHLY is not set in backend/.env');
      }
      return id;
    },
    plan: 'standard',
    interval: 'monthly',
    price: 1500,
  },
  {
    key: 'STANDARD_YEARLY',
    name: 'Trndinn Standard (Yearly)',
    get productId() {
      const id = process.env.POLAR_PRODUCT_STANDARD_YEARLY || '';
      if (!id) {
        throw new Error('POLAR_PRODUCT_STANDARD_YEARLY is not set in backend/.env');
      }
      return id;
    },
    plan: 'standard',
    interval: 'yearly',
    price: 15000,
  },
  {
    key: 'PRO_MONTHLY',
    name: 'Trndinn Pro (Monthly)',
    get productId() {
      const id = process.env.POLAR_PRODUCT_PRO_MONTHLY || '';
      if (!id) {
        throw new Error('POLAR_PRODUCT_PRO_MONTHLY is not set in backend/.env');
      }
      return id;
    },
    plan: 'pro',
    interval: 'monthly',
    price: 2900,
  },
  {
    key: 'PRO_YEARLY',
    name: 'Trndinn Pro (Yearly)',
    get productId() {
      const id = process.env.POLAR_PRODUCT_PRO_YEARLY || '';
      if (!id) {
        throw new Error('POLAR_PRODUCT_PRO_YEARLY is not set in backend/.env');
      }
      return id;
    },
    plan: 'pro',
    interval: 'yearly',
    price: 29000,
  },
  {
    key: 'ULTIMATE_MONTHLY',
    name: 'Trndinn Ultimate (Monthly)',
    get productId() {
      const id = process.env.POLAR_PRODUCT_ULTIMATE_MONTHLY || '';
      if (!id) {
        throw new Error('POLAR_PRODUCT_ULTIMATE_MONTHLY is not set in backend/.env');
      }
      return id;
    },
    plan: 'ultimate',
    interval: 'monthly',
    price: 4900,
  },
  {
    key: 'ULTIMATE_YEARLY',
    name: 'Trndinn Ultimate (Yearly)',
    get productId() {
      const id = process.env.POLAR_PRODUCT_ULTIMATE_YEARLY || '';
      if (!id) {
        throw new Error('POLAR_PRODUCT_ULTIMATE_YEARLY is not set in backend/.env');
      }
      return id;
    },
    plan: 'ultimate',
    interval: 'yearly',
    price: 49000,
  },
];

interface CheckoutLinkResult {
  key: string;
  checkoutLinkId: string;
  checkoutUrl: string;
  label: string;
  productId: string;
  success?: boolean;
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

async function listExistingCheckoutLinks(): Promise<any[]> {
  try {
    const result = await polarApiRequest('/v1/checkout-links/', 'GET');
    return result.items || result || [];
  } catch (e: any) {
    console.log(`  ℹ️  Could not list existing checkout links: ${e.message}`);
    return [];
  }
}

async function createCheckoutLink(product: typeof PRODUCTS[number]): Promise<CheckoutLinkResult> {
  console.log(`\n→ Creating checkout link for ${product.name}...`);

  try {
    // Get the product ID (will throw if not set)
    const productId = product.productId;

    // Create checkout link via /v1/checkout-links/ endpoint
    // These links are persistent and appear in dashboard
    // Note: payment_processor is REQUIRED and must be "stripe"
    const checkoutLink = await polarApiRequest('/v1/checkout-links/', 'POST', {
      products: [productId],
      payment_processor: 'stripe',
      label: `${product.plan}_${product.interval}`,
      allow_discount_codes: true,
      success_url: `${FRONTEND_URL}/billing?polar=success`,
      return_url: `${FRONTEND_URL}/billing?polar=cancel`,
      metadata: {
        plan_type: product.plan,
        billing_cycle: product.interval,
        app: 'trndinn',
      },
    });

    console.log(`  ✅ Checkout Link ID: ${checkoutLink.id}`);
    console.log(`  ✅ Checkout URL: ${checkoutLink.url}`);

    return {
      key: product.key,
      checkoutLinkId: checkoutLink.id,
      checkoutUrl: checkoutLink.url,
      label: checkoutLink.label || `${product.plan}_${product.interval}`,
      productId: productId,
      success: true,
    };
  } catch (e: any) {
    console.error(`  ❌ Failed: ${e.message}`);
    return {
      key: product.key,
      checkoutLinkId: '',
      checkoutUrl: '',
      label: '',
      productId: '',
      success: false,
      error: e.message,
    };
  }
}

async function deleteCheckoutLink(checkoutLinkId: string): Promise<void> {
  try {
    await polarApiRequest(`/v1/checkout-links/${checkoutLinkId}`, 'DELETE');
    console.log(`  🗑️  Deleted old checkout link: ${checkoutLinkId}`);
  } catch (e: any) {
    console.log(`  ⚠️  Could not delete: ${e.message}`);
  }
}

async function main() {
  // Validate environment variables
  if (!validateEnv()) {
    process.exit(1);
  }

  console.log('='.repeat(80));
  console.log('Polar Checkout Links Creator');
  console.log(`Organization ID: ${ORG_ID}`);
  console.log(`Mode: ${MODE.toUpperCase()}`);
  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log('='.repeat(80));
  console.log();
  console.log('This script creates persistent Checkout Links that appear in:');
  console.log('  Polar Dashboard → Settings → Checkout Links');
  console.log();
  console.log('NOTE: Checkout Links are different from Checkout Sessions!');
  console.log('  - Checkout Links: Reusable, visible in dashboard');
  console.log('  - Checkout Sessions: One-time, NOT visible in dashboard');
  console.log();

  // Check existing checkout links
  console.log('Checking existing checkout links...');
  const existingLinks = await listExistingCheckoutLinks();
  if (existingLinks.length > 0) {
    console.log(`  Found ${existingLinks.length} existing checkout links:`);
    for (const link of existingLinks) {
      console.log(`    - ${link.label || link.id}: ${link.url}`);
    }
    console.log();
  } else {
    console.log('  No existing checkout links found.\n');
  }

  // Create new checkout links
  const results: CheckoutLinkResult[] = [];
  for (const product of PRODUCTS) {
    const result = await createCheckoutLink(product);
    results.push(result);
  }

  // Print results
  printResults(results);
  await saveResults(results);
  printSummary(results);
}

function printResults(results: CheckoutLinkResult[]) {
  console.log('\n' + '='.repeat(80));
  console.log('ENVIRONMENT VARIABLES - Add these to your .env files');
  console.log('='.repeat(80));

  // Backend
  console.log('\n# === Backend .env (no changes needed - uses product IDs) ===');
  console.log('# Product IDs remain the same');

  // Frontend
  console.log('\n# === Frontend .env.local ===');
  console.log('# New Checkout Links (visible in Polar Dashboard)');
  console.log('# Generated:', new Date().toISOString());
  console.log();

  for (const r of results) {
    if (r.success) {
      console.log(`NEXT_PUBLIC_POLAR_CHECKOUT_${r.key}=${r.checkoutUrl}`);
    }
  }
}

async function saveResults(results: CheckoutLinkResult[]) {
  const fs = await import('fs/promises');
  const path = await import('path');

  const outputPath = path.join(process.cwd(), `polar-checkout-links-${Date.now()}.json`);
  const output = {
    timestamp: new Date().toISOString(),
    mode: MODE,
    organization: ORG_ID,
    results,
    env_frontend: generateFrontendEnv(results),
  };

  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Full results saved to: ${outputPath}`);
}

function generateFrontendEnv(results: CheckoutLinkResult[]): string {
  let env = `# Polar Checkout Links - Generated ${new Date().toISOString()}\n`;
  env += `# These are persistent Checkout Links visible in Polar Dashboard\n`;
  env += `# Organization: ${ORG_ID} (${MODE.toUpperCase()})\n\n`;

  for (const r of results) {
    if (r.success) {
      env += `NEXT_PUBLIC_POLAR_CHECKOUT_${r.key}=${r.checkoutUrl}\n`;
    }
  }

  return env;
}

function printSummary(results: CheckoutLinkResult[]) {
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`✅ Successfully created: ${successful}/${results.length}`);
  if (failed > 0) {
    console.log(`❌ Failed: ${failed}`);
    console.log('\nFailed products:');
    for (const r of results.filter(r => !r.success)) {
      console.log(`  - ${r.key}: ${r.error}`);
    }
  }

  console.log('\nNext Steps:');
  console.log('1. Copy the environment variables above to frontend/.env.local');
  console.log(`2. Verify links in Polar Dashboard: ${BASE_URL.replace('-api', '')}/dashboard`);
  console.log('   → Settings → Checkout Links');
  console.log('3. Test checkout flow with a test card: 4242 4242 4242 4242');
  console.log('\nNote: If you need to create links for PRODUCTION:');
  console.log('  - Set POLAR_MODE=production in your .env');
  console.log('  - Change FRONTEND_URL to your production URL');
  console.log('  - Use production access token');
  console.log('='.repeat(80));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
