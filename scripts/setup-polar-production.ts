#!/usr/bin/env node
/**
 * Polar Production Setup Script for Trndinn
 *
 * This script completely sets up Polar production environment:
 * 1. Creates products in Polar production with INR and USD pricing
 * 2. Creates checkout links for each product
 * 3. Updates backend/.env and frontend/.env with production values
 * 4. Saves results to JSON file
 *
 * BEFORE RUNNING:
 * 1. Get production access token from: https://polar.sh/settings
 * 2. Set POLAR_ACCESS_TOKEN and POLAR_WEBHOOK_SECRET in your environment
 * 3. Ensure POLAR_MODE=production in your .env
 *
 * Run with: npx ts-node scripts/setup-polar-production.ts
 */

import { config } from 'dotenv';
import { resolve, join } from 'path';
import { readFile, writeFile, access } from 'fs/promises';

// ============================================================================
// CONFIGURATION
// ============================================================================

// Load environment variables from backend/.env
config({ path: resolve(__dirname, '../.env') });

// Constants
const PRODUCTION_BASE_URL = 'https://api.polar.sh';
const PRODUCTION_CHECKOUT_BASE = 'https://polar.sh/checkout';
const RESULTS_FILENAME = 'polar-production-setup-results.json';

// Pricing configuration (INR and USD) - both currencies required by Polar
const PRICING = {
  standard: {
    monthly: { inr: 9900, usd: 103 },       // ₹99, $1.03
    yearly: { inr: 98600, usd: 1027 },      // ₹986, $10.27
  },
  pro: {
    monthly: { inr: 14900, usd: 155 },      // ₹149, $1.55
    yearly: { inr: 148400, usd: 1546 },    // ₹1484, $15.46
  },
  ultimate: {
    monthly: { inr: 19900, usd: 207 },      // ₹199, $2.07
    yearly: { inr: 198200, usd: 2065 },     // ₹1982, $20.65
  },
};

// Product definitions with both INR and USD prices
const PRODUCTS = [
  {
    key: 'STANDARD_MONTHLY',
    planType: 'standard_monthly',
    basePlanId: 'standard',
    name: 'Trndinn Standard (Monthly)',
    description: 'Perfect for individual creators and small teams. Monthly billing.',
    prices: PRICING.standard.monthly,
    displayPrice: '₹99',
    interval: 'month',
  },
  {
    key: 'STANDARD_YEARLY',
    planType: 'standard_yearly',
    basePlanId: 'standard',
    name: 'Trndinn Standard (Yearly)',
    description: 'Perfect for individual creators and small teams. Yearly billing (17% off).',
    prices: PRICING.standard.yearly,
    displayPrice: '₹986',
    interval: 'year',
  },
  {
    key: 'PRO_MONTHLY',
    planType: 'pro_monthly',
    basePlanId: 'pro',
    name: 'Trndinn Pro (Monthly)',
    description: 'For growing teams with collaboration features. Monthly billing.',
    prices: PRICING.pro.monthly,
    displayPrice: '₹149',
    interval: 'month',
  },
  {
    key: 'PRO_YEARLY',
    planType: 'pro_yearly',
    basePlanId: 'pro',
    name: 'Trndinn Pro (Yearly)',
    description: 'For growing teams with collaboration features. Yearly billing (17% off).',
    prices: PRICING.pro.yearly,
    displayPrice: '₹1484',
    interval: 'year',
  },
  {
    key: 'ULTIMATE_MONTHLY',
    planType: 'ultimate_monthly',
    basePlanId: 'ultimate',
    name: 'Trndinn Ultimate (Monthly)',
    description: 'For agencies and enterprises. Monthly billing.',
    prices: PRICING.ultimate.monthly,
    displayPrice: '₹199',
    interval: 'month',
  },
  {
    key: 'ULTIMATE_YEARLY',
    planType: 'ultimate_yearly',
    basePlanId: 'ultimate',
    name: 'Trndinn Ultimate (Yearly)',
    description: 'For agencies and enterprises. Yearly billing (17% off).',
    prices: PRICING.ultimate.yearly,
    displayPrice: '₹1982',
    interval: 'year',
  },
] as const;

// ============================================================================
// TYPES
// ============================================================================

interface ProductResult {
  key: string;
  productId: string;
  priceId: string;
  basePlanId: string;
  interval: string;
  displayPrice: string;
  error?: string;
}

interface CheckoutLinkResult {
  key: string;
  checkoutLinkId: string;
  checkoutUrl: string;
  productId: string;
  label: string;
  success: boolean;
  error?: string;
}

interface SetupResults {
  timestamp: string;
  mode: string;
  organization: string;
  products: ProductResult[];
  checkoutLinks: CheckoutLinkResult[];
  envBackend: string;
  envFrontend: string;
}

// ============================================================================
// ENVIRONMENT VALIDATION
// ============================================================================

function getAccessToken(): string {
  return process.env.POLAR_ACCESS_TOKEN || '';
}

function getWebhookSecret(): string {
  return process.env.POLAR_WEBHOOK_SECRET || '';
}

function getOrgId(): string {
  // Support both POLAR_ORGANIZATION and POLAR_ORGANIZATION_ID
  return process.env.POLAR_ORGANIZATION || process.env.POLAR_ORGANIZATION_ID || '';
}

function getFrontendUrl(): string {
  // For production, default to production frontend URL
  return process.env.FRONTEND_URL || 'https://trndinn.com';
}

function validateEnv(): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const token = getAccessToken();
  const orgId = getOrgId();

  if (!token) {
    console.error('❌ ERROR: POLAR_ACCESS_TOKEN is required');
    console.error('   Get your production token from: https://polar.sh/settings');
    console.error('   Then set it as environment variable:');
    console.error('   export POLAR_ACCESS_TOKEN=polar_oat_xxxxxxxx');
    return { valid: false, warnings };
  }

  if (!orgId) {
    console.error('❌ ERROR: POLAR_ORGANIZATION (or POLAR_ORGANIZATION_ID) is required');
    console.error('   Set it as environment variable:');
    console.error('   export POLAR_ORGANIZATION=trndinn');
    return { valid: false, warnings };
  }

  if (!getWebhookSecret()) {
    warnings.push('POLAR_WEBHOOK_SECRET not set - you will need to set this after creating webhook in Polar dashboard');
  }

  // Check if this looks like a production token
  if (!token.includes('production') && process.env.POLAR_ENV !== 'production') {
    warnings.push('Polar environment does not appear to be set to production. Ensure you are using production credentials.');
  }

  return { valid: true, warnings };
}

// ============================================================================
// POLAR API HELPERS
// ============================================================================

async function polarApiRequest(endpoint: string, method: string, body?: any): Promise<any> {
  const url = `${PRODUCTION_BASE_URL}${endpoint}`;
  const token = getAccessToken();

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
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

async function listExistingProducts(): Promise<any[]> {
  try {
    const result = await polarApiRequest('/v1/products', 'GET');
    return result.items || [];
  } catch (e: any) {
    console.log(`  ℹ️  Could not list existing products: ${e.message}`);
    return [];
  }
}

async function listExistingCheckoutLinks(): Promise<any[]> {
  try {
    const result = await polarApiRequest('/v1/checkout-links/', 'GET');
    return result.items || [];
  } catch (e: any) {
    console.log(`  ℹ️  Could not list existing checkout links: ${e.message}`);
    return [];
  }
}

// ============================================================================
// PRODUCT CREATION
// ============================================================================

async function createProduct(product: typeof PRODUCTS[number]): Promise<ProductResult> {
  console.log(`\n📝 Creating product: ${product.name} (${product.displayPrice}/${product.interval})`);

  try {
    // Create product with BOTH INR and USD pricing (required by Polar)
    const productData = {
      name: product.name,
      description: product.description,
      recurring_interval: product.interval,
      prices: [
        {
          amount_type: 'fixed',
          price_amount: product.prices.inr,
          price_currency: 'inr',
        },
        {
          amount_type: 'fixed',
          price_amount: product.prices.usd,
          price_currency: 'usd',
        },
      ],
      metadata: {
        plan_type: product.basePlanId,
        billing_interval: product.interval,
        display_price: product.displayPrice,
        setup_script: 'setup-polar-production',
      },
    };

    const createdProduct = await polarApiRequest('/v1/products', 'POST', productData);

    const productId = createdProduct.id;
    const prices = createdProduct.prices || [];
    // Use INR price (first price) as the primary price ID
    const priceId = prices.find((p: any) => p.price_currency === 'inr')?.id || prices[0]?.id;

    if (!productId || !priceId) {
      throw new Error('Product created but missing ID or price ID');
    }

    console.log(`   ✅ Product ID: ${productId}`);
    console.log(`   ✅ INR Price ID: ${priceId}`);
    const usdPriceId = prices.find((p: any) => p.price_currency === 'usd')?.id;
    if (usdPriceId) {
      console.log(`   ✅ USD Price ID: ${usdPriceId}`);
    }

    return {
      key: product.key,
      productId,
      priceId,
      basePlanId: product.basePlanId,
      interval: product.interval,
      displayPrice: product.displayPrice,
    };
  } catch (error: any) {
    console.error(`   ❌ Failed: ${error.message}`);
    return {
      key: product.key,
      productId: '',
      priceId: '',
      basePlanId: product.basePlanId,
      interval: product.interval,
      displayPrice: product.displayPrice,
      error: error.message,
    };
  }
}

async function findExistingProduct(product: typeof PRODUCTS[number], existingProducts: any[]): Promise<any | null> {
  // Look for product by name
  return existingProducts.find(p => p.name === product.name) || null;
}

async function createOrGetProduct(
  product: typeof PRODUCTS[number],
  existingProducts: any[],
  skipExisting: boolean
): Promise<ProductResult> {
  const existing = await findExistingProduct(product, existingProducts);

  if (existing) {
    if (skipExisting) {
      console.log(`\n⏭️  Skipping ${product.name} (already exists)`);
      const price = existing.prices?.find((p: any) => p.price_currency === 'inr') || existing.prices?.[0];
      return {
        key: product.key,
        productId: existing.id,
        priceId: price?.id || '',
        basePlanId: product.basePlanId,
        interval: product.interval,
        displayPrice: product.displayPrice,
      };
    } else {
      console.log(`\n📝 Product ${product.name} already exists, using existing`);
      const price = existing.prices?.find((p: any) => p.price_currency === 'inr') || existing.prices?.[0];
      return {
        key: product.key,
        productId: existing.id,
        priceId: price?.id || '',
        basePlanId: product.basePlanId,
        interval: product.interval,
        displayPrice: product.displayPrice,
      };
    }
  }

  return createProduct(product);
}

// ============================================================================
// CHECKOUT LINK CREATION
// ============================================================================

async function createCheckoutLink(
  product: typeof PRODUCTS[number],
  productId: string
): Promise<CheckoutLinkResult> {
  console.log(`\n🔗 Creating checkout link for: ${product.name}`);

  try {
    const frontendUrl = getFrontendUrl();

    const checkoutLink = await polarApiRequest('/v1/checkout-links/', 'POST', {
      products: [productId],
      payment_processor: 'stripe',
      label: `trndinn_${product.basePlanId}_${product.interval}`,
      allow_discount_codes: true,
      success_url: `${frontendUrl}/billing?polar=success`,
      return_url: `${frontendUrl}/billing?polar=cancel`,
      metadata: {
        plan_type: product.basePlanId,
        billing_cycle: product.interval,
        app: 'trndinn',
        setup_script: 'setup-polar-production',
      },
    });

    console.log(`   ✅ Checkout Link ID: ${checkoutLink.id}`);
    console.log(`   ✅ Checkout URL: ${checkoutLink.url}`);

    return {
      key: product.key,
      checkoutLinkId: checkoutLink.id,
      checkoutUrl: checkoutLink.url,
      productId: productId,
      label: checkoutLink.label || `trndinn_${product.basePlanId}_${product.interval}`,
      success: true,
    };
  } catch (error: any) {
    console.error(`   ❌ Failed: ${error.message}`);
    return {
      key: product.key,
      checkoutLinkId: '',
      checkoutUrl: '',
      productId: productId,
      label: '',
      success: false,
      error: error.message,
    };
  }
}

async function findExistingCheckoutLink(
  product: typeof PRODUCTS[number],
  existingLinks: any[]
): Promise<any | null> {
  // Look for checkout link by label or product ID
  const label = `trndinn_${product.basePlanId}_${product.interval}`;
  return existingLinks.find(
    link => link.label === label || link.products?.includes(product.key)
  ) || null;
}

async function createOrGetCheckoutLink(
  product: typeof PRODUCTS[number],
  productId: string,
  existingLinks: any[],
  skipExisting: boolean
): Promise<CheckoutLinkResult> {
  const existing = await findExistingCheckoutLink(product, existingLinks);

  if (existing) {
    if (skipExisting) {
      console.log(`\n⏭️  Skipping checkout link for ${product.name} (already exists)`);
      return {
        key: product.key,
        checkoutLinkId: existing.id,
        checkoutUrl: existing.url,
        productId: productId,
        label: existing.label || '',
        success: true,
      };
    } else {
      console.log(`\n🔗 Checkout link for ${product.name} already exists, using existing`);
      return {
        key: product.key,
        checkoutLinkId: existing.id,
        checkoutUrl: existing.url,
        productId: productId,
        label: existing.label || '',
        success: true,
      };
    }
  }

  return createCheckoutLink(product, productId);
}

// ============================================================================
// ENV FILE UPDATES
// ============================================================================

function generateBackendEnv(
  products: ProductResult[],
  accessToken: string,
  webhookSecret: string,
  orgId: string
): string {
  let env = `# ============================================\n`;
  env += `# POLAR PRODUCTION CONFIGURATION\n`;
  env += `# Generated: ${new Date().toISOString()}\n`;
  env += `# ============================================\n\n`;

  env += `BILLING_PROVIDER=polar\n`;
  env += `POLAR_ENV=production\n`;
  env += `POLAR_ORGANIZATION=${orgId}\n\n`;

  env += `# Get your token from: https://polar.sh/settings\n`;
  env += `POLAR_ACCESS_TOKEN=${accessToken}\n`;

  if (webhookSecret) {
    env += `POLAR_WEBHOOK_SECRET=${webhookSecret}\n`;
  } else {
    env += `# POLAR_WEBHOOK_SECRET=your_webhook_secret_here\n`;
    env += `# Set this after configuring webhook in Polar Dashboard → Settings → Webhooks\n`;
  }

  env += `\n# Product IDs (DO NOT MODIFY - tied to Polar production)\n`;
  for (const p of products) {
    if (p.productId) {
      env += `POLAR_PRODUCT_${p.key}=${p.productId}\n`;
    }
  }

  env += `\n# Price IDs (DO NOT MODIFY - tied to Polar production)\n`;
  for (const p of products) {
    if (p.priceId) {
      env += `POLAR_PRICE_${p.key}=${p.priceId}\n`;
    }
  }

  return env;
}

function generateFrontendEnv(
  products: ProductResult[],
  checkoutLinks: CheckoutLinkResult[],
  orgId: string
): string {
  let env = `# ============================================\n`;
  env += `# POLAR PRODUCTION CONFIGURATION\n`;
  env += `# Generated: ${new Date().toISOString()}\n`;
  env += `# ============================================\n\n`;

  env += `NEXT_PUBLIC_BILLING_PROVIDER=polar\n`;
  env += `NEXT_PUBLIC_POLAR_MODE=production\n`;
  env += `NEXT_PUBLIC_POLAR_ORGANIZATION=${orgId}\n\n`;

  env += `# Checkout Links (from Polar Dashboard)\n`;
  for (const c of checkoutLinks) {
    if (c.success && c.checkoutUrl) {
      env += `NEXT_PUBLIC_POLAR_CHECKOUT_${c.key}=${c.checkoutUrl}\n`;
    }
  }

  env += `\n# Price IDs (for SDK checkout)\n`;
  for (const p of products) {
    if (p.priceId) {
      env += `NEXT_PUBLIC_POLAR_PRICE_${p.key}=${p.priceId}\n`;
    }
  }

  return env;
}

async function updateEnvFile(filePath: string, newContent: string, sectionMarker: string): Promise<void> {
  try {
    let existingContent = '';
    try {
      existingContent = await readFile(filePath, 'utf-8');
    } catch {
      // File doesn't exist, will create new
      existingContent = '';
    }

    // Find and remove existing Polar section
    const markerStart = sectionMarker;
    const markerEnd = '# ===';

    let newFileContent = existingContent;

    // Remove old Polar section if exists
    const polarStart = existingContent.indexOf(markerStart);
    if (polarStart !== -1) {
      // Find the next section or end of file
      let polarEnd = existingContent.indexOf('\n# ', polarStart + 1);
      if (polarEnd === -1) polarEnd = existingContent.length;

      newFileContent = existingContent.slice(0, polarStart) + existingContent.slice(polarEnd);
    }

    // Append new section
    newFileContent = newFileContent.trim() + '\n\n' + newContent + '\n';

    await writeFile(filePath, newFileContent, 'utf-8');
    console.log(`   ✅ Updated: ${filePath}`);
  } catch (error: any) {
    console.error(`   ❌ Failed to update ${filePath}: ${error.message}`);
    throw error;
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log('='.repeat(80));
  console.log('🚀 Polar Production Setup - Trndinn');
  console.log('='.repeat(80));
  console.log();
  console.log('⚠️  WARNING: This will create products in POLAR PRODUCTION!');
  console.log('   Ensure you are using production credentials.');
  console.log();

  // Validate environment
  const { valid, warnings } = validateEnv();
  if (!valid) {
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log('⚠️  Warnings:');
    for (const w of warnings) {
      console.log(`   - ${w}`);
    }
    console.log();
  }

  const accessToken = getAccessToken();
  const webhookSecret = getWebhookSecret();
  const orgId = getOrgId();

  console.log('Configuration:');
  console.log(`   Organization: ${orgId}`);
  console.log(`   API URL: ${PRODUCTION_BASE_URL}`);
  console.log(`   Webhook Secret: ${webhookSecret ? '✅ Set' : '❌ Not set'}`);
  console.log();

  // Check for existing products and checkout links
  console.log('🔍 Checking for existing products...');
  const existingProducts = await listExistingProducts();
  console.log(`   Found ${existingProducts.length} existing products`);

  console.log('\n🔍 Checking for existing checkout links...');
  const existingLinks = await listExistingCheckoutLinks();
  console.log(`   Found ${existingLinks.length} existing checkout links`);

  // Check if running in skip mode (update only missing)
  const skipExisting = process.argv.includes('--skip-existing');
  if (skipExisting) {
    console.log('\n⏭️  Running in --skip-existing mode (will not recreate existing items)');
  }

  // Ask for confirmation if not --force
  const forceMode = process.argv.includes('--force');
  if (!forceMode) {
    console.log('\n⚠️  This will:');
    console.log('   1. Create/up to 6 products in Polar PRODUCTION');
    console.log('   2. Create/up to 6 checkout links');
    console.log('   3. Update backend/.env with production values');
    console.log('   4. Update frontend/.env with production values');
    console.log();
    console.log('   Use --force to skip this confirmation');
    console.log('   Use --skip-existing to skip items that already exist');
    console.log();
    console.log('   Press Ctrl+C to cancel, or wait 5 seconds to continue...');

    // Countdown
    for (let i = 5; i > 0; i--) {
      process.stdout.write(`   ${i}... `);
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('\n');
  }

  // Create products
  console.log('='.repeat(80));
  console.log('📦 STEP 1: Creating Products');
  console.log('='.repeat(80));

  const productResults: ProductResult[] = [];
  for (const product of PRODUCTS) {
    const result = await createOrGetProduct(product, existingProducts, skipExisting);
    productResults.push(result);
  }

  const successfulProducts = productResults.filter(p => p.productId && !p.error);
  console.log(`\n✅ Products created/verified: ${successfulProducts.length}/${PRODUCTS.length}`);

  if (successfulProducts.length === 0) {
    console.error('\n❌ No products were successfully created. Aborting.');
    process.exit(1);
  }

  // Create checkout links
  console.log('\n' + '='.repeat(80));
  console.log('🔗 STEP 2: Creating Checkout Links');
  console.log('='.repeat(80));

  const checkoutResults: CheckoutLinkResult[] = [];
  for (const productResult of successfulProducts) {
    const product = PRODUCTS.find(p => p.key === productResult.key)!;
    const result = await createOrGetCheckoutLink(
      product,
      productResult.productId,
      existingLinks,
      skipExisting
    );
    checkoutResults.push(result);
  }

  const successfulCheckouts = checkoutResults.filter(c => c.success);
  console.log(`\n✅ Checkout links created/verified: ${successfulCheckouts.length}/${successfulProducts.length}`);

  // Generate environment file content
  console.log('\n' + '='.repeat(80));
  console.log('📝 STEP 3: Generating Environment Configuration');
  console.log('='.repeat(80));

  const backendEnv = generateBackendEnv(productResults, accessToken, webhookSecret, orgId);
  const frontendEnv = generateFrontendEnv(productResults, checkoutResults, orgId);

  // Update files
  console.log('\nUpdating environment files...');

  const backendEnvPath = resolve(__dirname, '../.env');
  const frontendEnvPath = resolve(__dirname, '../../frontend/.env.local');

  try {
    await updateEnvFile(backendEnvPath, backendEnv, '# ===');
  } catch {
    console.log('\n⚠️  Could not auto-update backend/.env. Please copy manually:');
    console.log('\n--- Backend .env ---');
    console.log(backendEnv);
    console.log('--- End ---\n');
  }

  try {
    await updateEnvFile(frontendEnvPath, frontendEnv, '# ===');
  } catch {
    console.log('\n⚠️  Could not auto-update frontend/.env.local. Please copy manually:');
    console.log('\n--- Frontend .env.local ---');
    console.log(frontendEnv);
    console.log('--- End ---\n');
  }

  // Save results to JSON
  console.log('\n' + '='.repeat(80));
  console.log('💾 STEP 4: Saving Results');
  console.log('='.repeat(80));

  const results: SetupResults = {
    timestamp: new Date().toISOString(),
    mode: 'production',
    organization: orgId,
    products: productResults,
    checkoutLinks: checkoutResults,
    envBackend: backendEnv,
    envFrontend: frontendEnv,
  };

  const resultsPath = join(process.cwd(), RESULTS_FILENAME);
  await writeFile(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\n✅ Results saved to: ${resultsPath}`);

  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('📋 SUMMARY');
  console.log('='.repeat(80));
  console.log(`\nProducts: ${successfulProducts.length}/${PRODUCTS.length} successful`);
  for (const p of productResults) {
    const status = p.error ? '❌' : '✅';
    console.log(`   ${status} ${p.key}: ${p.displayPrice}/${p.interval} (${p.productId || 'FAILED'})`);
  }

  console.log(`\nCheckout Links: ${successfulCheckouts.length}/${productResults.length} successful`);
  for (const c of checkoutResults) {
    const status = c.success ? '✅' : '❌';
    console.log(`   ${status} ${c.key}: ${c.checkoutUrl || c.error || 'FAILED'}`);
  }

  // Print next steps
  console.log('\n' + '='.repeat(80));
  console.log('🎯 NEXT STEPS');
  console.log('='.repeat(80));
  console.log();
  console.log('1. ✅ Products created in Polar Production');
  console.log('   View at: https://polar.sh/dashboard/trndinn/products');
  console.log();
  console.log('2. ✅ Checkout links created');
  console.log('   View at: https://polar.sh/dashboard/trndinn/checkout-links');
  console.log();
  console.log('3. ✅ Environment files updated');
  console.log(`   - Backend: ${backendEnvPath}`);
  console.log(`   - Frontend: ${frontendEnvPath}`);
  console.log();
  console.log('4. 🔧 Configure Webhook (if not done):');
  console.log('   - Go to: https://polar.sh/dashboard/trndinn/settings/webhooks');
  console.log('   - Add URL: https://api.trndinn.com/api/polar/webhook');
  console.log('   - Enable events:');
  console.log('     • checkout.created');
  console.log('     • checkout.completed');
  console.log('     • subscription.created');
  console.log('     • subscription.active');
  console.log('     • subscription.updated');
  console.log('     • subscription.canceled');
  console.log('     • order.paid');
  console.log('   - Copy webhook secret to backend/.env as POLAR_WEBHOOK_SECRET');
  console.log();
  console.log('5. 🧪 Test the checkout flow:');
  console.log('   - Use a checkout URL from the results above');
  console.log('   - Test card: 4242 4242 4242 4242');
  console.log();
  console.log('6. 🚀 Deploy with updated environment variables');
  console.log();
  console.log('='.repeat(80));

  // Print environment variables for reference
  console.log('\n📄 BACKEND ENVIRONMENT VARIABLES (reference):');
  console.log('-'.repeat(80));
  console.log(backendEnv);
  console.log('-'.repeat(80));

  console.log('\n📄 FRONTEND ENVIRONMENT VARIABLES (reference):');
  console.log('-'.repeat(80));
  console.log(frontendEnv);
  console.log('-'.repeat(80));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
