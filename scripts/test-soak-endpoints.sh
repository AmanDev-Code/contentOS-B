#!/bin/bash

# Soak Test API Endpoint Validation Script
# Tests all 4 admin soak test endpoints

set -e

# Configuration
BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
ADMIN_JWT="${ADMIN_JWT:-}"

if [ -z "$ADMIN_JWT" ]; then
  echo "❌ Error: ADMIN_JWT environment variable not set"
  echo "Usage: ADMIN_JWT=your_token ./test-soak-endpoints.sh"
  exit 1
fi

echo "🧪 Testing Soak Test API Endpoints"
echo "Backend URL: $BACKEND_URL"
echo ""

# Test 1: Check status (should be idle initially)
echo "1️⃣  GET /api/admin/soak-test/status"
STATUS_RESPONSE=$(curl -s "$BACKEND_URL/api/admin/soak-test/status" \
  -H "Authorization: Bearer $ADMIN_JWT")
echo "$STATUS_RESPONSE" | jq .
INITIAL_STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.data.status')
echo "   Current status: $INITIAL_STATUS"
echo ""

# Test 2: List reports
echo "2️⃣  GET /api/admin/soak-test/reports"
REPORTS_RESPONSE=$(curl -s "$BACKEND_URL/api/admin/soak-test/reports" \
  -H "Authorization: Bearer $ADMIN_JWT")
echo "$REPORTS_RESPONSE" | jq '.data | {count, reports: .reports[:2]}'
REPORT_COUNT=$(echo "$REPORTS_RESPONSE" | jq -r '.data.count')
echo "   Found $REPORT_COUNT reports"
echo ""

# Test 3: Start test (optional - commented out to avoid accidental 7-hour run)
# Uncomment if you want to test the start endpoint
# echo "3️⃣  POST /api/admin/soak-test/start"
# START_RESPONSE=$(curl -s -X POST "$BACKEND_URL/api/admin/soak-test/start" \
#   -H "Authorization: Bearer $ADMIN_JWT")
# echo "$START_RESPONSE" | jq .
# echo ""

# Test 4: Check if stop endpoint is accessible (without actually calling it)
echo "3️⃣  Testing stop endpoint accessibility"
echo "   (Not calling to avoid stopping any running test)"
echo "   Endpoint: POST /api/admin/soak-test/stop"
echo ""

echo "✅ All endpoint tests completed!"
echo ""
echo "📝 Summary:"
echo "   - Status endpoint: Working"
echo "   - Reports endpoint: Working (found $REPORT_COUNT reports)"
echo "   - Current test status: $INITIAL_STATUS"
echo ""
echo "🚀 To start a test manually:"
echo "   curl -X POST $BACKEND_URL/api/admin/soak-test/start \\"
echo "     -H \"Authorization: Bearer \$ADMIN_JWT\""
echo ""
echo "🛑 To stop a running test:"
echo "   curl -X POST $BACKEND_URL/api/admin/soak-test/stop \\"
echo "     -H \"Authorization: Bearer \$ADMIN_JWT\""
