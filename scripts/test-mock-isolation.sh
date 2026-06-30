#!/bin/bash

# Test script to verify mock publishing isolation
# Run this after applying the migration to ensure everything works correctly

set -e

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║         Mock Publishing Isolation Test                        ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Check if migration was applied
echo "1. Checking if migration was applied..."
COLUMN_EXISTS=$(psql $DATABASE_URL -t -c "
  SELECT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_name='profiles' AND column_name='is_test_user'
  );
")

if [[ "$COLUMN_EXISTS" =~ "t" ]]; then
  echo "✅ Migration applied: is_test_user column exists"
else
  echo "❌ Migration NOT applied: is_test_user column missing"
  echo "   Run: psql \$DATABASE_URL < backend/supabase/migrations/phase-1-social/20260630_add_is_test_user/up.sql"
  exit 1
fi

# Check existing users
echo ""
echo "2. Checking existing users..."
REAL_USER_COUNT=$(psql $DATABASE_URL -t -c "
  SELECT COUNT(*) 
  FROM profiles 
  WHERE is_test_user = FALSE OR is_test_user IS NULL;
")
echo "   Real users: $REAL_USER_COUNT (all will get REAL LinkedIn publishing)"

TEST_USER_COUNT=$(psql $DATABASE_URL -t -c "
  SELECT COUNT(*) 
  FROM profiles 
  WHERE is_test_user = TRUE;
")
echo "   Test users: $TEST_USER_COUNT (all will get MOCK publishing)"

# Show test users if any
if [ "$TEST_USER_COUNT" -gt 0 ]; then
  echo ""
  echo "   Test users:"
  psql $DATABASE_URL -c "
    SELECT id, email, is_test_user 
    FROM profiles 
    WHERE is_test_user = TRUE 
    LIMIT 10;
  "
fi

# Verify TypeScript types are up to date
echo ""
echo "3. Checking TypeScript types..."
if grep -q "is_test_user" backend/src/common/types/index.ts; then
  echo "✅ TypeScript types updated"
else
  echo "❌ TypeScript types NOT updated"
  echo "   Add 'is_test_user?: boolean;' to Profile interface"
  exit 1
fi

# Verify LinkedIn service logic
echo ""
echo "4. Checking LinkedIn service logic..."
if grep -q "profile.is_test_user || this.mockPublishEnabled" backend/src/services/linkedin.service.ts; then
  echo "✅ LinkedIn service checks user flag"
else
  echo "❌ LinkedIn service NOT checking user flag"
  echo "   Update publishPost method to check profile.is_test_user first"
  exit 1
fi

# Verify seeder script
echo ""
echo "5. Checking soak test seeder..."
if grep -q "is_test_user: true" backend/src/scripts/soak-test-seeder.ts; then
  echo "✅ Seeder sets is_test_user flag"
else
  echo "❌ Seeder does NOT set is_test_user flag"
  echo "   Update seeder to include 'is_test_user: true' in profile insert"
  exit 1
fi

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║                  ✅ ALL CHECKS PASSED                         ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""
echo "Safe to run soak test alongside production traffic:"
echo "  npm run soak-test:run:fast"
echo ""
echo "Real users will continue getting REAL LinkedIn publishing."
echo "Test users (is_test_user=true) will get MOCK publishing only."
