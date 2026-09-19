#!/usr/bin/env bash
# scripts/smoke-p12.sh — Phase 12 acceptance run.
#
# Pre-requisites:
#   - Phase 11 fixtures seeded (smoke-p11.sh ran at least once), so
#     the demo tenants (T1, T2) have KYC_APPROVED.
#   - Dev server running on http://localhost:3000.
#
# Coverage:
#   A. Duplicate-application prevention (partial UNIQUE → 409)
#   B. Tenant withdraw (own) + cross-tenant withdraw (403) + illegal
#      transition on withdrawn app (409)
#   C. APPROVED hot path: T1 → SUBMITTED → SCREENING → SHORTLISTED
#      → APPROVED; sibling T2 bulk-rejected; room → RESERVED
#   D. Viewing flow: owner proposes; tenant confirms one; cancel one
#   E. KYC gate: 3rd tenant (T3) with kycStatus=PENDING → 403
#
# The smoke run is idempotent across runs because every test uses
# fresh tenants (T3) or fresh rooms (published in the seed step at
# the top of this script). Cross-run bleed on O1's rooms is handled
# by creating a brand-new property per run.

set -u
BASE="${BASE:-http://localhost:3000}"
BODY_FILE="${BODY_FILE:-C:/Users/MOHAMM~2/AppData/Local/Temp/p12-body.json}"
mkdir -p "$(dirname "$BODY_FILE")"
OWNER1=$(cat scripts/smoke-p10-owner1.json)
OWNER2=$(cat scripts/smoke-p10-owner2.json)
TENANT1=$(cat scripts/smoke-p10-tenant.json)
TENANT2='{"email":"tenant2@demo.local","password":"Demo123!@#"}'

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
O2=$(login "$OWNER2")
T1=$(login "$TENANT1")
T2=$(login "$TENANT2")
ADMIN=$(login '{"email":"demo@admin.local","password":"Demo123!@#"}')
echo "=== Phase 12 acceptance ==="

# ── seed: a fresh published property per run ────────────────────────────
echo "seeding fresh property for this run…"
PBODY='{"title":"Phase 12 Test Loft","addressLine1":"1 Test St","city":"Test City","countryCode":"US","propertyType":"BUILDING","latitude":40.7,"longitude":-73.9}'
status -X POST "$BASE/api/v1/properties" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "$PBODY" >/dev/null
P=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/properties/$P/buildings" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"name":"B1"}' >/dev/null
B=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/buildings/$B/flats" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"floor":1,"doorNumber":"1A"}' >/dev/null
F=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
R='{"label":"Phase 12 room","roomType":"PRIVATE","maxOccupants":1,"baseRentMinor":150000,"depositMinor":300000,"currency":"USD","amenities":["wifi"],"availableFrom":"2026-10-01","minLeaseMonths":3,"maxLeaseMonths":12}'
status -X POST "$BASE/api/v1/rooms/flats/$F/rooms" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "$R" >/dev/null
RID=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/rooms/$RID/publish" -H "Authorization: Bearer $O1" >/dev/null
status -X POST "$BASE/api/v1/properties/$P/publish" -H "Authorization: Bearer $O1" >/dev/null
echo "seeded room RID=$RID on property P=$P"

# Second property owned by O2 for the cross-owner note test
PBODY2='{"title":"O2 Probe","addressLine1":"2 Test St","city":"Test City","countryCode":"US","propertyType":"STANDALONE_FLAT","latitude":40.7,"longitude":-73.9}'
status -X POST "$BASE/api/v1/properties" -H "Content-Type: application/json" -H "Authorization: Bearer $O2" -d "$PBODY2" >/dev/null
P2=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
echo "seeded O2's property P2=$P2"

# ── Case A — duplicate prevention ─────────────────────────────────────
echo "── Case A: duplicate prevention ──"
code=$(status -X POST "$BASE/api/v1/applications" -H "Content-Type: application/json" -H "Authorization: Bearer $T1" -d "{\"roomId\":\"$RID\",\"message\":\"I am interested in this room please\"}")
expect "POST /applications (T1) → 201" 201 "$code"
APP1=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

code=$(status -X POST "$BASE/api/v1/applications" -H "Content-Type: application/json" -H "Authorization: Bearer $T1" -d "{\"roomId\":\"$RID\",\"message\":\"Trying to apply again while active\"}")
expect "POST /applications (T1 same room) → 409" 409 "$code"

# ── Case B — withdraw ownership + illegal transition ──────────────────
echo "── Case B: withdraw flow ──"
code=$(status -X POST "$BASE/api/v1/applications/$APP1/withdraw" -H "Content-Type: application/json" -H "Authorization: Bearer $T1" -d '{}')
expect "POST /withdraw (T1 own) → 200" 200 "$code"

# Second tenant tries to withdraw — service rejects with NOT_OWNER.
code=$(status -X POST "$BASE/api/v1/applications/$APP1/withdraw" -H "Content-Type: application/json" -H "Authorization: Bearer $T2" -d '{}')
expect "POST /withdraw (T2 on T1's app) → 403" 403 "$code"

# Owner tries to transition a withdrawn application — illegal move.
code=$(status -X POST "$BASE/api/v1/applications/$APP1/transition" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"to":"SCREENING"}')
expect "POST /transition (withdrawn app) → 409" 409 "$code"

# ── Case C — APPROVED hot path ───────────────────────────────────────
echo "── Case C: APPROVED hot path ──"

# T1 re-applies now that their previous app is WITHDRAWN (out of active set).
code=$(status -X POST "$BASE/api/v1/applications" -H "Content-Type: application/json" -H "Authorization: Bearer $T1" -d "{\"roomId\":\"$RID\",\"message\":\"Re-applying after withdraw to test hot path\"}")
expect "POST /applications (T1 re-apply) → 201" 201 "$code"
APP1=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

# T2 applies too — separate row, partial UNIQUE allows it.
code=$(status -X POST "$BASE/api/v1/applications" -H "Content-Type: application/json" -H "Authorization: Bearer $T2" -d "{\"roomId\":\"$RID\",\"message\":\"Tenant 2 also wants this room please\"}")
expect "POST /applications (T2 same room) → 201" 201 "$code"
APP2=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

# T1: SUBMITTED → SCREENING → SHORTLISTED
code=$(status -X POST "$BASE/api/v1/applications/$APP1/transition" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"to":"SCREENING"}')
expect "POST /transition T1 SCREENING → 200" 200 "$code"
code=$(status -X POST "$BASE/api/v1/applications/$APP1/transition" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"to":"SHORTLISTED"}')
expect "POST /transition T1 SHORTLISTED → 200" 200 "$code"

# T2: SUBMITTED → SCREENING → SHORTLISTED
code=$(status -X POST "$BASE/api/v1/applications/$APP2/transition" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"to":"SCREENING"}')
expect "POST /transition T2 SCREENING → 200" 200 "$code"
code=$(status -X POST "$BASE/api/v1/applications/$APP2/transition" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"to":"SHORTLISTED"}')
expect "POST /transition T2 SHORTLISTED → 200" 200 "$code"

# Approve T1 — this is the FOR UPDATE hot path.
code=$(status -X POST "$BASE/api/v1/applications/$APP1/transition" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"to":"APPROVED"}')
expect "POST /transition T1 APPROVED → 200" 200 "$code"
APPROVED_STATUS=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['status'])")
[[ "$APPROVED_STATUS" == "APPROVED" ]] && { echo "  ✓ T1 status = APPROVED"; pass=$((pass+1)); } \
                                         || { echo "  ✗ T1 status = $APPROVED_STATUS"; fail=$((fail+1)); }

# Now try to approve T2 (same room). The room is RESERVED → 409 STATE_MACHINE.
code=$(status -X POST "$BASE/api/v1/applications/$APP2/transition" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"to":"APPROVED"}')
expect "POST /transition T2 APPROVED (room RESERVED) → 409" 409 "$code"

# T2's app should now be REJECTED via bulk-reject.
code=$(status "$BASE/api/v1/applications/$APP2" -H "Authorization: Bearer $O1")
expect "GET /applications/:id (T2 after bulk-reject) → 200" 200 "$code"
T2_STATUS=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['status'])")
[[ "$T2_STATUS" == "REJECTED" ]] && { echo "  ✓ T2 status = REJECTED (bulk-rejected)"; pass=$((pass+1)); } \
                                  || { echo "  ✗ T2 status = $T2_STATUS (want REJECTED)"; fail=$((fail+1)); }

# ── Case D — viewing flow ────────────────────────────────────────────
echo "── Case D: viewing flow ──"
# Create a 2nd application on a fresh room for T1, then exercise viewing.
PBODY3='{"title":"Viewing Test","addressLine1":"3 Test St","city":"Test City","countryCode":"US","propertyType":"STANDALONE_FLAT","latitude":40.7,"longitude":-73.9}'
status -X POST "$BASE/api/v1/properties" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "$PBODY3" >/dev/null
P3=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/properties/$P3/buildings" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"name":"V"}' >/dev/null
B3=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/buildings/$B3/flats" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"floor":1}' >/dev/null
F3=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/rooms/flats/$F3/rooms" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"label":"V room","roomType":"PRIVATE","baseRentMinor":100000,"depositMinor":200000,"currency":"USD"}' >/dev/null
RID3=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/rooms/$RID3/publish" -H "Authorization: Bearer $O1" >/dev/null
status -X POST "$BASE/api/v1/properties/$P3/publish" -H "Authorization: Bearer $O1" >/dev/null

# T1 applies, then OWNER proposes viewing.
status -X POST "$BASE/api/v1/applications" -H "Content-Type: application/json" -H "Authorization: Bearer $T1" -d "{\"roomId\":\"$RID3\",\"message\":\"For viewing flow test please\"}" >/dev/null
APP3=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

code=$(status -X POST "$BASE/api/v1/applications/$APP3/viewing" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"proposedSlots":["2026-12-01T10:00:00Z","2026-12-01T14:00:00Z"]}')
expect "POST /viewing (owner proposes slots) → 201" 201 "$code"
VID=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

# Owner confirms a slot
code=$(status -X POST "$BASE/api/v1/viewings/$VID/confirm" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"confirmedSlot":"2026-12-01T10:00:00Z"}')
expect "POST /viewings/:id/confirm (owner) → 200" 200 "$code"
CONFIRMED_SLOT=$(python -c "import json;d=json.load(open('$BODY_FILE'))['data'];print(d['status'],d['confirmedSlot'])")
[[ "$CONFIRMED_SLOT" == "CONFIRMED 2026-12-01T10:00:00.000Z" ]] \
  && { echo "  ✓ viewing.status = CONFIRMED with slot populated"; pass=$((pass+1)); } \
  || { echo "  ✗ viewing state: $CONFIRMED_SLOT"; fail=$((fail+1)); }

# Tenant cancels the confirmed viewing
code=$(status -X POST "$BASE/api/v1/viewings/$VID/cancel" -H "Content-Type: application/json" -H "Authorization: Bearer $T1" -d '{"reason":"plans changed"}')
expect "POST /viewings/:id/cancel (tenant party) → 200" 200 "$code"
CANCEL_STATUS=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['status'])")
[[ "$CANCEL_STATUS" == "CANCELLED" ]] && { echo "  ✓ viewing cancelled by tenant"; pass=$((pass+1)); } \
                                       || { echo "  ✗ viewing state: $CANCEL_STATUS"; fail=$((fail+1)); }

# Owner creates another viewing, then owner cancels
status -X POST "$BASE/api/v1/applications/$APP3/viewing" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"proposedSlots":["2026-12-08T10:00:00Z"]}' >/dev/null
VID2=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
code=$(status -X POST "$BASE/api/v1/viewings/$VID2/cancel" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"reason":"owner-side cancel"}')
expect "POST /viewings/:id/cancel (owner) → 200" 200 "$code"

# ── Case E — KYC gate ────────────────────────────────────────────────
echo "── Case E: KYC gate ──"
# Sign up a 3rd tenant, set their kyc to PENDING, try to apply.
T3_EMAIL="tenant3-p12-$$@demo.local"
# password must be ≥12 chars per auth.schemas.ts signupSchema.
SIGNUP_BODY="{\"email\":\"$T3_EMAIL\",\"password\":\"Demo123!@#extra\"}"
status -X POST "$BASE/api/v1/auth/signup" -H "Content-Type: application/json" -d "$SIGNUP_BODY" >/dev/null
T3_ID=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['user']['id'])")
echo "  seeded T3 user id=$T3_ID"

# T3 must hold the TENANT role for requireRole('TENANT') to pass before the
# KYC gate inside the service can fire.
psql_q() { PGPASSWORD=housing_dev_pw_2026 "/f/Program Files/PostgreSQL/18/bin/psql.exe" -h localhost -p 55432 -U housing -d housing -t -A -c "$1"; }
psql_q "INSERT INTO user_roles (id, user_id, role) VALUES (gen_random_uuid(), '$T3_ID', 'TENANT') ON CONFLICT DO NOTHING;" >/dev/null
psql_q "INSERT INTO tenant_profiles (id, user_id, display_name, kyc_status, updated_at) VALUES (gen_random_uuid(), '$T3_ID', 'Tara Tenant 3', 'PENDING', now()) ON CONFLICT (user_id) DO UPDATE SET kyc_status='PENDING', updated_at=now();" >/dev/null

# Login as T3 — should succeed because signup itself doesn't gate on KYC.
T3=$(login "{\"email\":\"$T3_EMAIL\",\"password\":\"Demo123!@#extra\"}")
code=$(status -X POST "$BASE/api/v1/applications" -H "Content-Type: application/json" -H "Authorization: Bearer $T3" -d "{\"roomId\":\"$RID3\",\"message\":\"T3 trying to apply without KYC approval please\"}")
expect "POST /applications (T3 KYC=PENDING) → 403" 403 "$code"
KYCCODE=$(python -c "import json;print(json.load(open('$BODY_FILE'))['errors'][0]['code'])")
[[ "$KYCCODE" == "KYC_REQUIRED" ]] && { echo "  ✓ error code = KYC_REQUIRED"; pass=$((pass+1)); } \
                                     || { echo "  ✗ error code: $KYCCODE"; fail=$((fail+1)); }

# ── summary ──────────────────────────────────────────────────────────
echo "=== $pass passed, $fail failed ==="
exit $fail
