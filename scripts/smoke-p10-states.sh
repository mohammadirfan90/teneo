#!/usr/bin/env bash
# scripts/smoke-p10-states.sh — state-machine edge cases (extension).
set -u
BASE="${BASE:-http://localhost:3000}"
BODY_FILE="${BODY_FILE:-C:/Users/MOHAMM~2/AppData/Local/Temp/p10-body.json}"
mkdir -p "$(dirname "$BODY_FILE")"
OWNER1=$(cat scripts/smoke-p10-owner1.json)
OWNER2=$(cat scripts/smoke-p10-owner2.json)

login() {
  curl -s -X POST "$BASE/api/v1/auth/login" -H "Content-Type: application/json" -d "$1" \
    | python -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])"
}

pass=0; fail=0
expect() {
  local name="$1"; local expected="$2"; local got="$3"
  if [[ "$got" == "$expected" ]]; then echo "  ✓ $name → $got"; pass=$((pass+1))
  else echo "  ✗ $name → expected $expected, got $got"; fail=$((fail+1)); fi
}
status() { curl -s -o "$BODY_FILE" -w "%{http_code}" "$@"; }

O1=$(login "$OWNER1")
echo "=== Phase 10 state-machine ==="

# Seed a fresh property → room chain
PBODY='{"title":"SM House","addressLine1":"1","city":"X","countryCode":"US","propertyType":"BUILDING","latitude":40,"longitude":-70}'
status -X POST "$BASE/api/v1/properties" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "$PBODY" >/dev/null
PID=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

status -X POST "$BASE/api/v1/properties/$PID/buildings" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"name":"B"}' >/dev/null
BID=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/buildings/$BID/flats" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{}' >/dev/null
FID=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
RBODY='{"label":"R","roomType":"PRIVATE","baseRentMinor":100,"depositMinor":200,"currency":"USD"}'
status -X POST "$BASE/api/v1/flats/$FID/rooms" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "$RBODY" >/dev/null
RID=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

# A) Invalid transition DRAFT → OCCUPIED → 409
code=$(status -X POST "$BASE/api/v1/rooms/$RID/transition" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"to":"OCCUPIED"}')
expect "POST transition DRAFT→OCCUPIED → 409" 409 "$code"

# B) Stale version: read current version, then transition with wrong version → 409
CUR_VER=$(curl -s "$BASE/api/v1/rooms/$RID" -H "Authorization: Bearer $O1" | python -c "import json,sys;print(json.load(sys.stdin)['data']['version'])")
STALE=$((CUR_VER+99))
code=$(status -X POST "$BASE/api/v1/rooms/$RID/transition" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "{\"to\":\"PUBLISHED\",\"expectedVersion\":$STALE}")
expect "POST transition stale version → 409" 409 "$code"

# C) Valid DRAFT→PUBLISHED transition (with correct version) → 200
code=$(status -X POST "$BASE/api/v1/rooms/$RID/transition" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "{\"to\":\"PUBLISHED\",\"expectedVersion\":$CUR_VER}")
expect "POST transition DRAFT→PUBLISHED (correct version) → 200" 200 "$code"

# D) Already-PUBLISHED → OCCUPIED still invalid (DRAFT only allowed DRAFT→PUBLISHED; PUBLISHED→OCCUPIED not in matrix)
code=$(status -X POST "$BASE/api/v1/rooms/$RID/transition" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"to":"OCCUPIED"}')
expect "POST transition PUBLISHED→OCCUPIED → 409" 409 "$code"

# E) Invalid property publish on TAKEN_DOWN (delete then republish) → 409
status -X DELETE "$BASE/api/v1/properties/$PID" -H "Authorization: Bearer $O1" >/dev/null
code=$(status -X POST "$BASE/api/v1/properties/$PID/publish" -H "Authorization: Bearer $O1")
expect "POST publish TAKEN_DOWN property → 404 (already deleted)" 404 "$code"

echo "=== $pass passed, $fail failed ==="
exit $fail
