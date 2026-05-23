#!/usr/bin/env node
/**
 * Verify Polar products exist and match .env configuration
 *
 * Required Environment Variables:
 * - POLAR_ACCESS_TOKEN - Your Polar API access token
 * - POLAR_MODE - 'sandbox' or 'production'
 */

import { Polar } from '@polar-sh/sdk';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from backend/.env
config({ path: resolve(__dirname, '../.env') });

// Get configuration from environment variables
const ACCESS_TOKEN = process.env.POLAR_ACCESS_TOKEN || '';
const MODE = (process.env.POLAR_MODE || 'sandbox').toLowerCase();
const ORGANIZATION = process.env.POLAR_ORGANIZATION || '';

// Validate required environment variables
function validateEnv(): boolean {
  if (!ACCESS_TOKEN) {
    console.error('❌ ERROR: POLAR_ACCESS_TOKEN is not set');
    console.error('');
    console.error('To fix this, run:');
    console.error('  echo "POLAR_ACCESS_TOKEN=your_polar_access_token" >> backend/.env');
    console.error('');
    console.error('Then re-run this script.');
    return false;
  }
  return true;
}

// Expected product IDs from environment variables (not hardcoded)
const getExpectedProducts = (): Record<string, string> => ({
  'standard_monthly': process.env.POLAR_PRODUCT_STANDARD_MONTHLY || '',
  'standard_yearly': process.env.POLAR_PRODUCT_STANDARD_YEARLY || '',
  'pro_monthly': process.env.POLAR_PRODUCT_PRO_MONTHLY || '',
  'pro_yearly': process.env.POLAR_PRODUCT_PRO_YEARLY || '',
  'ultimate_monthly': process.env.POLAR_PRODUCT_ULTIMATE_MONTHLY || '',
  'ultimate_yearly': process.env.POLAR_PRODUCT_ULTIMATE_YEARLY || '',
});

async function verifyPolarProducts() {
  // Validate environment variables
  if (!validateEnv()) {
    process.exit(1);
  }

  const polar = new Polar({
    accessToken: ACCESS_TOKEN,
    server: MODE === 'production' ? 'production' : 'sandbox',
  });

  const baseApiUrl = MODE === 'production' ? 'https://api.polar.sh' : 'https://sandbox-api.polar.sh';

  console.log('='.repeat(80));
  console.log('POLAR VERIFICATION REPORT');
  console.log('Organization:', ORGANIZATION || 'Not set');
  console.log('Environment:', MODE);
  console.log('='.repeat(80));
  console.log();

  // 1. List all products
  console.log('📦 PRODUCTS IN POLAR:');
  console.log('-'.repeat(80));
  let products: any[] = [];
  try {
    const productsResult = await polar.products.list({});
    products = (productsResult as any).items || [];
    console.log(`Found ${products.length} products:\n`);

    for (const product of products) {
      console.log(`  ID: ${product.id}`);
      console.log(`  Name: ${product.name}`);
      console.log(`  Status: ${product.status || 'unknown'}`);
      const prices = product.prices || [];
      console.log(`  Prices: ${prices.length > 0 ? prices.map((p: any) => `${p.amount} ${p.currency || 'USD'}`).join(', ') : 'None'}`);
      console.log('');
    }
  } catch (e: any) {
    console.error('Error fetching products:', e.message);
  }

  // 2. List all checkout links with product details
  console.log();
  console.log('🔗 CHECKOUT LINKS IN POLAR (with product details):');
  console.log('-'.repeat(80));
  const checkoutLinks: any[] = [];
  try {
    const response = await fetch(`${baseApiUrl}/v1/checkout-links/`, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Accept': 'application/json',
      },
    });
    const result: any = await response.json();
    const items = result.items || [];
    console.log(`Found ${items.length} checkout links:\n`);

    for (const link of items) {
      const productsInfo = link.products || [];
      const productDetails = productsInfo.map((p: any) => {
        if (typeof p === 'string') return p;
        return p.id || p.product_id || JSON.stringify(p);
      }).join(', ');

      console.log(`  ID: ${link.id}`);
      console.log(`  Label: ${link.label || 'N/A'}`);
      console.log(`  URL: ${link.url}`);
      console.log(`  Products: ${productDetails || 'None'}`);

      // Store for later
      checkoutLinks.push({
        id: link.id,
        label: link.label,
        url: link.url,
        products: productsInfo,
      });
      console.log('');
    }
  } catch (e: any) {
    console.error('Error fetching checkout links:', e.message);
  }

  // 3. Try to get product details from checkout link products
  console.log();
  console.log('🔍 PRODUCT IDs FROM CHECKOUT LINKS:');
  console.log('-'.repeat(80));

  const productIdMap: Record<string, { label: string; productId: string }> = {};
  for (const link of checkoutLinks) {
    const productsInfo = link.products || [];
    for (const p of productsInfo) {
      const productId = typeof p === 'string' ? p : (p.id || p.product_id);
      if (productId) {
        productIdMap[link.label] = { label: link.label, productId };
        console.log(`  ${link.label}: ${productId}`);
      }
    }
  }

  // 4. Try to fetch product by ID from checkout
  console.log();
  console.log('🔍 FETCHING PRODUCT DETAILS FROM CHECKOUT LINK IDs:');
  console.log('-'.repeat(80));

  const actualProducts: any[] = [];
  for (const link of checkoutLinks) {
    const productsInfo = link.products || [];
    for (const p of productsInfo) {
      const productId = typeof p === 'string' ? p : (p.id || p.product_id);
      if (productId && typeof productId === 'string') {
        try {
          const product = await polar.products.get({ id: productId });
          console.log(`  ✅ ${link.label}:`);
          console.log(`     Product ID: ${(product as any).id}`);
          console.log(`     Name: ${(product as any).name}`);
          console.log(`     Status: ${(product as any).status || 'N/A'}`);
          actualProducts.push({
            label: link.label,
            ...product,
          });
        } catch (e: any) {
          console.log(`  ❌ ${link.label}: Product ${productId} - ${e.message}`);
        }
      }
    }
  }

  // 5. Compare with expected from environment
  console.log();
  console.log('📋 COMPARISON - EXPECTED vs ACTUAL PRODUCT IDs:');
  console.log('-'.repeat(80));

  const expectedMapping = getExpectedProducts();
  const missingProducts: string[] = [];

  for (const [label, expectedId] of Object.entries(expectedMapping)) {
    if (!expectedId) {
      console.log(`  ⚠️  ${label}: NOT CONFIGURED in .env`);
      missingProducts.push(label);
      continue;
    }

    const link = checkoutLinks.find((l: any) => l.label === label);
    let actualId = 'NOT FOUND';
    if (link && link.products && link.products[0]) {
      actualId = typeof link.products[0] === 'string'
        ? link.products[0]
        : (link.products[0].id || link.products[0].product_id || 'UNKNOWN');
    }
    const match = actualId === expectedId;
    console.log(`  ${match ? '✅' : '❌'} ${label}:`);
    console.log(`     Expected: ${expectedId}`);
    console.log(`     Actual:   ${actualId}`);
    console.log('');

    if (!match) {
      missingProducts.push(label);
    }
  }

  // 6. Generate new .env values
  console.log();
  console.log('📝 NEW .ENV VALUES (based on actual Polar product IDs):');
  console.log('-'.repeat(80));

  if (checkoutLinks.length === 0) {
    console.log('  No checkout links found. Run setup-polar-products.ts first.');
  } else {
    for (const link of checkoutLinks) {
      const productsInfo = link.products || [];
      for (const p of productsInfo) {
        const productId = typeof p === 'string' ? p : (p.id || p.product_id);
        if (productId) {
          const upperLabel = link.label.toUpperCase();
          console.log(`POLAR_PRODUCT_${upperLabel}=${productId}`);
        }
      }
    }
  }

  // 7. List all discounts
  console.log();
  console.log('🏷️  DISCOUNTS IN POLAR:');
  console.log('-'.repeat(80));
  try {
    const discountsResult = await polar.discounts.list({});
    const discounts = (discountsResult as any).items || [];
    console.log(`Found ${discounts.length} discounts:\n`);

    for (const discount of discounts) {
      console.log(`  ID: ${discount.id}`);
      console.log(`  Code: ${discount.code}`);
      console.log(`  Name: ${discount.name}`);
      console.log(`  Type: ${discount.type}`);
      console.log(`  Products: ${(discount.products || []).length > 0 ? discount.products.join(', ') : 'All products'}`);
      console.log('');
    }
  } catch (e: any) {
    console.error('Error fetching discounts:', e.message);
  }

  // Summary
  console.log();
  console.log('='.repeat(80));
  console.log('VERIFICATION SUMMARY');
  console.log('='.repeat(80));

  if (missingProducts.length > 0) {
    console.log(`❌ Missing or mismatched products: ${missingProducts.length}`);
    for (const p of missingProducts) {
      console.log(`   - ${p}`);
    }
    console.log('');
    console.log('To fix, run:');
    console.log('  npx ts-node scripts/setup-polar-products.ts');
  } else {
    console.log('✅ All products verified successfully!');
  }

  console.log('='.repeat(80));
}

verifyPolarProducts().catch(console.error);
