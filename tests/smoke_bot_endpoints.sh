#!/bin/bash
# Smoke tests for RaceControl bot API endpoints
# Usage: bash tests/smoke_bot_endpoints.sh
# Requires: RC_API_URL and RC_TERMINAL_SECRET env vars (or defaults)

set -euo pipefail

API="${RC_API_URL:-https://app.racingpoint.cloud/api/v1}"
SECRET="${RC_TERMINAL_SECRET:-rp-terminal-2026}"
HEADER="x-terminal-secret: $SECRET"
PASS=0
FAIL=0

check() {
  local name="$1"
  local url="$2"
  local method="${3:-GET}"
  local body="${4:-}"
  local expect="${5:-200}"

  if [ "$method" = "POST" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
      -H "Content-Type: application/json" -H "$HEADER" \
      -d "$body" "$url" 2>/dev/null)
  else
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "$HEADER" "$url" 2>/dev/null)
  fi

  if [ "$HTTP_CODE" = "$expect" ]; then
    echo "PASS: $name (HTTP $HTTP_CODE)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (expected $expect, got $HTTP_CODE)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Bot API Endpoint Smoke Tests ==="
echo "API: $API"
echo ""

# Existing endpoints
check "GET /bot/pricing" "$API/bot/pricing"
check "GET /bot/lookup (missing phone)" "$API/bot/lookup?phone=0000000000"

# New endpoints
check "GET /bot/pods-status" "$API/bot/pods-status"
check "GET /bot/events" "$API/bot/events"
check "GET /bot/leaderboard" "$API/bot/leaderboard"
check "GET /bot/leaderboard (with track)" "$API/bot/leaderboard?track=spa"
check "GET /bot/customer-stats" "$API/bot/customer-stats?phone=0000000000"
check "POST /bot/register-lead" "$API/bot/register-lead" "POST" \
  '{"phone":"9999999999","name":"Test Lead","source":"whatsapp","intent":"pricing_inquiry"}'

# Auth check (response without secret should contain "Unauthorized" error)
NOAUTH_BODY=$(curl -s "$API/bot/pods-status" 2>/dev/null)
if echo "$NOAUTH_BODY" | grep -q '"error"'; then
  echo "PASS: Auth check (no secret returns error: $NOAUTH_BODY)"
  PASS=$((PASS + 1))
else
  echo "FAIL: Auth check (no secret should return error, got: $NOAUTH_BODY)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $FAIL
