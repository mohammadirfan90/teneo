#!/usr/bin/env bash
# scripts/smoke-p11.sh — Phase 11 acceptance run.
set -u
BASE="${BASE:-http://localhost:3000}"
BODY_FILE="${BODY_FILE:-C:/Users/MOHAMM~2/AppData/Local/Temp/p11-body.json}"
mkdir -p "$(dirname "$BODY_FILE")"
OWNER1=$(cat scripts/smoke-p10-owner1.json)
OWNER2=$(cat scripts/smoke-p10-owner2.json)
TENANT1=$(cat scripts/smoke-p10-tenant.json)

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
echo "=== Phase 11 acceptance ==="

# ── seed: 2 properties, 3 rooms, all PUBLISHED ─────────────────────
echo "seeding test fixtures…"
PBODY='{"title":"Brooklyn Loft","addressLine1":"100 Atlantic Ave","city":"Brooklyn","countryCode":"US","propertyType":"BUILDING","latitude":40.69,"longitude":-73.99}'
status -X POST "$BASE/api/v1/properties" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "$PBODY" >/dev/null
P1=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/properties/$P1/buildings" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"name":"B1"}' >/dev/null
B1=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/buildings/$B1/flats" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"floor":1,"doorNumber":"1A"}' >/dev/null
F1=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/buildings/$B1/flats" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"floor":2,"doorNumber":"2A"}' >/dev/null
F2=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

R1='{"label":"Sunny loft","roomType":"PRIVATE","maxOccupants":1,"baseRentMinor":180000,"depositMinor":360000,"currency":"USD","amenities":["wifi","heating"],"availableFrom":"2026-10-01","minLeaseMonths":3,"maxLeaseMonths":12}'
status -X POST "$BASE/api/v1/rooms/flats/$F1/rooms" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "$R1" >/dev/null
RID1=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
R2='{"label":"Quiet room","roomType":"PRIVATE","maxOccupants":2,"baseRentMinor":250000,"depositMinor":500000,"currency":"USD","amenities":["wifi","heating","ac"],"availableFrom":"2026-11-01","minLeaseMonths":6,"maxLeaseMonths":12}'
status -X POST "$BASE/api/v1/rooms/flats/$F2/rooms" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "$R2" >/dev/null
RID2=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

# Second property (Manhattan) for geo-distinct data
PBODY2='{"title":"Midtown Studio","addressLine1":"350 5th Ave","city":"Manhattan","countryCode":"US","propertyType":"STANDALONE_FLAT","latitude":40.74,"longitude":-73.99}'
status -X POST "$BASE/api/v1/properties" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "$PBODY2" >/dev/null
P2=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/properties/$P2/buildings" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"name":"Tower"}' >/dev/null
B2=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/buildings/$B2/flats" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"floor":5,"doorNumber":"5A"}' >/dev/null
F3=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
R3='{"label":"Compact studio","roomType":"STUDIO","maxOccupants":1,"baseRentMinor":320000,"depositMinor":640000,"currency":"USD","amenities":["wifi","ac"],"availableFrom":"2026-10-15","minLeaseMonths":6,"maxLeaseMonths":24}'
status -X POST "$BASE/api/v1/rooms/flats/$F3/rooms" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "$R3" >/dev/null
RID3=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

# Publish all three rooms
for r in $RID1 $RID2 $RID3; do
  status -X POST "$BASE/api/v1/rooms/$r/publish" -H "Authorization: Bearer $O1" >/dev/null
done
# Publish properties (cascade)
status -X POST "$BASE/api/v1/properties/$P1/publish" -H "Authorization: Bearer $O1" >/dev/null
status -X POST "$BASE/api/v1/properties/$P2/publish" -H "Authorization: Bearer $O1" >/dev/null
echo "fixtures seeded (P1=$P1, P2=$P2; rooms $RID1, $RID2, $RID3)"

# ── search tests ─────────────────────────────────────────────────
# 1. Anonymous GET /search/rooms?city=Brooklyn → 200 with ≥2 rooms
code=$(status "$BASE/api/v1/search/rooms?city=Brooklyn&limit=10")
expect "GET /search/rooms?city=Brooklyn (anon) → 200" 200 "$code"
COUNT=$(python -c "import json;print(len(json.load(open('$BODY_FILE'))['data']['items']))")
[[ "$COUNT" -ge 2 ]] && { echo "  ✓ returned ≥2 Brooklyn rooms ($COUNT)"; pass=$((pass+1)); } \
                      || { echo "  ✗ expected ≥2, got $COUNT"; fail=$((fail+1)); }

# 2. amenities=ac filter → only RID2 + RID3 (RID1 lacks ac)
code=$(status "$BASE/api/v1/search/rooms?amenities=ac&limit=10")
expect "GET /search/rooms?amenities=ac → 200" 200 "$code"
AC_IDS=$(python -c "import json;d=json.load(open('$BODY_FILE'))['data'];print(','.join(sorted([i['id'] for i in d['items']])))")
[[ "$AC_IDS" == *"$RID2"* && "$AC_IDS" == *"$RID3"* && "$AC_IDS" != *"$RID1"* ]] \
  && { echo "  ✓ amenities=ac includes RID2+RID3, excludes RID1"; pass=$((pass+1)); } \
  || { echo "  ✗ amenities filter wrong: ids=$AC_IDS"; fail=$((fail+1)); }

# 3. rent_min=300000 → only RID3
code=$(status "$BASE/api/v1/search/rooms?rent_min=300000&limit=10")
expect "GET /search/rooms?rent_min=300000 → 200" 200 "$code"
HIGH_IDS=$(python -c "import json;d=json.load(open('$BODY_FILE'))['data'];print(','.join(sorted([i['id'] for i in d['items']])))")
[[ "$HIGH_IDS" == *"$RID3"* && "$HIGH_IDS" != *"$RID1"* && "$HIGH_IDS" != *"$RID2"* ]] \
  && { echo "  ✓ rent_min=300000 returns only RID3"; pass=$((pass+1)); } \
  || { echo "  ✗ rent_min filter wrong: ids=$HIGH_IDS"; fail=$((fail+1)); }

# 4. sort=price_asc → first item has the LOWEST base_rent_minor
code=$(status "$BASE/api/v1/search/rooms?sort=price_asc&limit=10")
expect "GET /search/rooms?sort=price_asc → 200" 200 "$code"
FIRST_RENT=$(python -c "import json;d=json.load(open('$BODY_FILE'))['data'];print(int(d['items'][0]['baseRentMinor']))")
MIN_RENT=$(python -c "import json;d=json.load(open('$BODY_FILE'))['data'];print(min(int(i['baseRentMinor']) for i in d['items']))")
[[ "$FIRST_RENT" == "$MIN_RENT" && "$FIRST_RENT" -le 180000 ]] \
  && { echo "  ✓ price_asc first item has the lowest rent ($FIRST_RENT)"; pass=$((pass+1)); } \
  || { echo "  ✗ price_asc first item rent=$FIRST_RENT, min=$MIN_RENT"; fail=$((fail+1)); }

# 5. sort=price_desc → first item has the HIGHEST base_rent_minor
code=$(status "$BASE/api/v1/search/rooms?sort=price_desc&limit=10")
expect "GET /search/rooms?sort=price_desc → 200" 200 "$code"
FIRST_RENT=$(python -c "import json;d=json.load(open('$BODY_FILE'))['data'];print(int(d['items'][0]['baseRentMinor']))")
MAX_RENT=$(python -c "import json;d=json.load(open('$BODY_FILE'))['data'];print(max(int(i['baseRentMinor']) for i in d['items']))")
[[ "$FIRST_RENT" == "$MAX_RENT" ]] \
  && { echo "  ✓ price_desc first item has the highest rent ($FIRST_RENT)"; pass=$((pass+1)); } \
  || { echo "  ✗ price_desc first item rent=$FIRST_RENT, max=$MAX_RENT"; fail=$((fail+1)); }

# 6. cursor pagination: limit=1, then follow cursor
code=$(status "$BASE/api/v1/search/rooms?limit=1")
expect "GET /search/rooms?limit=1 page 1 → 200" 200 "$code"
C1=$(python -c "import json;d=json.load(open('$BODY_FILE'))['data'];print(d['nextCursor'])")
[[ -n "$C1" && "$C1" != "None" ]] \
  && { echo "  ✓ first page has nextCursor=$C1"; pass=$((pass+1)); } \
  || { echo "  ✗ first page missing cursor"; fail=$((fail+1)); }

code=$(status "$BASE/api/v1/search/rooms?limit=1&cursor=$C1")
expect "GET /search/rooms?limit=1&cursor=… → 200" 200 "$code"
SECOND_ID=$(python -c "import json;d=json.load(open('$BODY_FILE'))['data'];print(d['items'][0]['id'])")
[[ -n "$SECOND_ID" ]] \
  && { echo "  ✓ second page returned id=$SECOND_ID"; pass=$((pass+1)); } \
  || { echo "  ✗ second page empty"; fail=$((fail+1)); }

# 7. suggest ILIKE 'Brook'
code=$(status "$BASE/api/v1/search/rooms/suggest?q=Brook&limit=5")
expect "GET /search/rooms/suggest?q=Brook → 200" 200 "$code"
SUGG=$(python -c "import json;print(len(json.load(open('$BODY_FILE'))['data']))")
[[ "$SUGG" -ge 1 ]] \
  && { echo "  ✓ suggest returned $SUGG matches"; pass=$((pass+1)); } \
  || { echo "  ✗ suggest empty"; fail=$((fail+1)); }

# 8. DRAFT rooms hidden: create a fresh room, do NOT publish
PBODY3='{"title":"Hidden DRAFT","addressLine1":"9","city":"Queens","countryCode":"US","propertyType":"BUILDING","latitude":40.7,"longitude":-73.9}'
status -X POST "$BASE/api/v1/properties" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d "$PBODY3" >/dev/null
P3=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/properties/$P3/buildings" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"name":"X"}' >/dev/null
B3=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/buildings/$B3/flats" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{}' >/dev/null
F4=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")
status -X POST "$BASE/api/v1/rooms/flats/$F4/rooms" -H "Content-Type: application/json" -H "Authorization: Bearer $O1" -d '{"label":"DRAFT only","roomType":"PRIVATE","baseRentMinor":100000,"depositMinor":200000,"currency":"USD"}' >/dev/null
HIDDEN_ID=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

code=$(status "$BASE/api/v1/search/rooms?limit=50")
expect "GET /search/rooms (limit 50) → 200" 200 "$code"
ALL_IDS=$(python -c "import json;d=json.load(open('$BODY_FILE'))['data'];print(','.join([i['id'] for i in d['items']]))")
[[ "$ALL_IDS" != *"$HIDDEN_ID"* ]] \
  && { echo "  ✓ DRAFT room ($HIDDEN_ID) hidden from search"; pass=$((pass+1)); } \
  || { echo "  ✗ DRAFT room appeared in search"; fail=$((fail+1)); }

# ── saved-search tests ───────────────────────────────────────────
# 9. POST /search/saved as TENANT → 201
RUN_ID="$(date +%s)-$$"
SQBODY="{\"name\":\"Brooklyn under 300k $RUN_ID\",\"query\":{\"city\":\"Brooklyn\",\"rent_max\":300000}}"
code=$(status -X POST "$BASE/api/v1/search/saved" -H "Content-Type: application/json" -H "Authorization: Bearer $T1" -d "$SQBODY")
expect "POST /search/saved (TENANT) → 201" 201 "$code"
SSID=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

# 10. POST with missing name → 400
code=$(status -X POST "$BASE/api/v1/search/saved" -H "Content-Type: application/json" -H "Authorization: Bearer $T1" -d '{"query":{"city":"X"}}')
expect "POST /search/saved missing name → 400" 400 "$code"

# 11. POST duplicate name → 409 CONFLICT
code=$(status -X POST "$BASE/api/v1/search/saved" -H "Content-Type: application/json" -H "Authorization: Bearer $T1" -d "$SQBODY")
expect "POST /search/saved duplicate name → 409" 409 "$code"

# 12. GET /search/saved as TENANT → includes our saved
code=$(status "$BASE/api/v1/search/saved" -H "Authorization: Bearer $T1")
expect "GET /search/saved (TENANT) → 200" 200 "$code"
TENANT_SS=$(python -c "import json;d=json.load(open('$BODY_FILE'))['data'];print(','.join(sorted([i['id'] for i in d['items']])))")
[[ "$TENANT_SS" == *"$SSID"* ]] \
  && { echo "  ✓ TENANT sees their own saved search"; pass=$((pass+1)); } \
  || { echo "  ✗ TENANT missing their saved search ($TENANT_SS)"; fail=$((fail+1)); }

# 13. Save one as OWNER2; TENANT list should NOT include OWNER2's
O2_SQBODY="{\"name\":\"Manhattan owner2 $RUN_ID\",\"query\":{\"city\":\"Manhattan\"}}"
status -X POST "$BASE/api/v1/search/saved" -H "Content-Type: application/json" -H "Authorization: Bearer $O2" -d "$O2_SQBODY" >/dev/null
O2_SSID=$(python -c "import json;print(json.load(open('$BODY_FILE'))['data']['id'])")

status "$BASE/api/v1/search/saved" -H "Authorization: Bearer $T1" >/dev/null
TENANT_SS=$(python -c "import json;d=json.load(open('$BODY_FILE'))['data'];print(','.join(sorted([i['id'] for i in d['items']])))")
[[ "$TENANT_SS" != *"$O2_SSID"* ]] \
  && { echo "  ✓ TENANT does NOT see OWNER2's saved search"; pass=$((pass+1)); } \
  || { echo "  ✗ TENANT leaked OWNER2's saved search"; fail=$((fail+1)); }

# 14. DELETE /search/saved/:id as owner → 200
code=$(status -X DELETE "$BASE/api/v1/search/saved/$SSID" -H "Authorization: Bearer $T1")
expect "DELETE /search/saved (own) → 200" 200 "$code"

# 15. DELETE again → 404 (already soft-deleted)
code=$(status -X DELETE "$BASE/api/v1/search/saved/$SSID" -H "Authorization: Bearer $T1")
expect "DELETE /search/saved again → 404" 404 "$code"

# 16. DELETE as OTHER user → 404 (existence leak guard)
code=$(status -X DELETE "$BASE/api/v1/search/saved/$O2_SSID" -H "Authorization: Bearer $T1")
expect "DELETE /search/saved (other user) → 404" 404 "$code"

# ── summary ──────────────────────────────────────────────────────
echo "=== $pass passed, $fail failed ==="
exit $fail
