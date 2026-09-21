#!/usr/bin/env bash
# scripts/smoke-p10-full.sh — Phase 10 acceptance run against running dev server.
set -u
BASE="${BASE:-http://localhost:3000}"
# Use Windows TEMP so curl/python can both write/read the same path on Win+GitBash.
BODY_FILE="${BODY_FILE:-C:/Users/MOHAMM~2/AppData/Local/Temp/p10-body.json}"
mkdir -p "$(dirname "$BODY_FILE")"
echo "    body file: $BODY_FILE"
OWNER1=$(cat scripts/smoke-p10-owner1.json)
OWNER2=$(cat scripts/smoke-p10-owner2.json)
TENANT=$(cat scripts/smoke-p10-tenant.json)
ADMIN=$(cat scripts/smoke-p10-admin.json)

login() {
  curl -s -X POST "$BASE/api/v1/auth/login" -H "Content-Type: application/json" -d "$1" \
    | python -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])"
}

pass=0; fail=0
expect() {
  local name="$1"; local expected="$2"; local got="$3"
  if [[ "$got" == "$expected" ]]; then
    echo "  ✓ $name → $got"
    pass=$((pass+1))
  else
    echo "  ✗ $name → expected $expected, got $got"
    fail=$((fail+1))
  fi
}
status() { curl -s -o "$BODY_FILE" -w "%{http_code}" "$@"; }

T1=$(login "$TENANT"); T2=$(login "$ADMIN"); O1=$(login "$OWNER1"); O2=$(login "$OWNER2")
echo "=== Phase 10 acceptance ==="

# 1. POST /properties as TENANT (no OWNER role) → 403
code=$(status -X POST "$BASE/api/v1/properties" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $T1" -d '{"title":"x","addressLine1":"x","city":"x","countryCode":"US","propertyType":"BUILDING"}')
expect "POST /properties as TENANT → 403" 403 "$code"

# 2. POST /properties as OWNER (KYC_APPROVED) → 201
BODY=$(cat <<EOF
{"title":"P10 Smoke House","addressLine1":"1 Smoke St","city":"Brooklyn","countryCode":"US","propertyType":"BUILDING","latitude":40.6782,"longitude":-73.9442}
EOF
)
code=$(status -X POST "$BASE/api/v1/properties" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $O1" -d "$BODY")
expect "POST /properties as OWNER → 201" 201 "$code"
PID=$(python -c "import json;print(json.load(open('${BODY_FILE}'))['data']['id'])")
echo "    propertyId=$PID"

# 3. POST building
code=$(status -X POST "$BASE/api/v1/properties/$PID/buildings" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $O1" -d '{"name":"Bldg A","floors":3}')
expect "POST building → 201" 201 "$code"
BID=$(python -c "import json;print(json.load(open('${BODY_FILE}'))['data']['id'])")

# 4. POST flat
code=$(status -X POST "$BASE/api/v1/buildings/$BID/flats" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $O1" -d '{"floor":2,"doorNumber":"2B"}')
expect "POST flat → 201" 201 "$code"
FID=$(python -c "import json;print(json.load(open('${BODY_FILE}'))['data']['id'])")

# 5. POST room
RBODY=$(cat <<EOF
{"label":"Cozy room","roomType":"PRIVATE","sizeSqft":120.50,"maxOccupants":2,"baseRentMinor":150000,"depositMinor":300000,"currency":"USD","billsIncluded":false,"amenities":["wifi","heating"],"availableFrom":"2026-10-01","minLeaseMonths":3,"maxLeaseMonths":12}
EOF
)
code=$(status -X POST "$BASE/api/v1/flats/$FID/rooms" -H "Content-Type: application/json" \
  -H "Authorization: Bearer $O1" -d "$RBODY")
expect "POST room → 201" 201 "$code"
RID=$(python -c "import json;print(json.load(open('${BODY_FILE}'))['data']['id'])")

# 6. GET /properties/me?limit=5 as OWNER → 200
code=$(status "$BASE/api/v1/properties/me?limit=5" -H "Authorization: Bearer $O1")
expect "GET /properties/me?limit=5 → 200" 200 "$code"
PCOUNT=$(python -c "import json;d=json.load(open('${BODY_FILE}'))['data'];print(len(d['items']))")
echo "    /me returned $PCOUNT properties"

# 7. POST /rooms/:id/publish as TENANT → 403
code=$(status -X POST "$BASE/api/v1/rooms/$RID/publish" -H "Authorization: Bearer $T1")
expect "POST room publish as TENANT → 403" 403 "$code"

# 8. POST /rooms/:id/publish as OTHER OWNER → 403
code=$(status -X POST "$BASE/api/v1/rooms/$RID/publish" -H "Authorization: Bearer $O2")
expect "POST room publish as OTHER OWNER → 403" 403 "$code"

# 9. POST /rooms/:id/publish as OWNER (own) → 200
code=$(status -X POST "$BASE/api/v1/rooms/$RID/publish" -H "Authorization: Bearer $O1")
expect "POST room publish as OWNER (own) → 200" 200 "$code"

# 10. GET /rooms/:id as TENANT → 200 (public-safe subset)
code=$(status "$BASE/api/v1/rooms/$RID" -H "Authorization: Bearer $T1")
expect "GET /rooms/:id as TENANT → 200" 200 "$code"

# 11. POST /properties/:id/publish — second DRAFT? skip, we already published the room. Re-publish property should be 409
code=$(status -X POST "$BASE/api/v1/properties/$PID/publish" -H "Authorization: Bearer $O1")
expect "POST /properties publish (cascade) → 200" 200 "$code"

# 12. POST /rooms/:id/photos — multipart upload to Cloudinary.
# A 1x1 PNG is generated inline so the smoke test needs no fixture file.
# 201 when CLOUDINARY_* is configured; 503 STORAGE_DISABLED when it is not,
# and both are a pass here — this script asserts routing and auth, not that
# the developer running it has storage credentials.
PNG_TMP="$(mktemp -t roomphoto.XXXXXX).png"
printf '\211PNG\r\n\032\n\0\0\0\015IHDR\0\0\0\001\0\0\0\001\010\006\0\0\0\037\025\304\211\0\0\0\012IDATx\234c\370\017\0\001\001\001\0\033\267\140\204\0\0\0\0IEND\256B`\202' > "$PNG_TMP"
code=$(status -X POST "$BASE/api/v1/rooms/$RID/photos" \
  -H "Authorization: Bearer $O1" -F "file=@$PNG_TMP;type=image/png" -F "alt=smoke test")
if [ "$code" != "201" ] && [ "$code" != "503" ]; then
  expect "POST /rooms/:id/photos → 201 or 503" 201 "$code"
else
  expect "POST /rooms/:id/photos → $code (201 or 503 ok)" "$code" "$code"
fi
rm -f "$PNG_TMP"

# 13. DELETE a photo id that does not exist → 404 (was 501 before real storage)
code=$(status -X DELETE "$BASE/api/v1/rooms/$RID/photos/00000000-0000-0000-0000-000000000000" -H "Authorization: Bearer $O1")
expect "DELETE /rooms/:id/photos/:pid (unknown) → 404" 404 "$code"

# 14. GET /properties/me as TENANT → 403
code=$(status "$BASE/api/v1/properties/me" -H "Authorization: Bearer $T1")
expect "GET /properties/me as TENANT → 403" 403 "$code"

# 15. DELETE /properties/:id (own) → 200; subsequent GET → 404
code=$(status -X DELETE "$BASE/api/v1/properties/$PID" -H "Authorization: Bearer $O1")
expect "DELETE /properties/:id (own) → 200" 200 "$code"
code=$(status "$BASE/api/v1/properties/$PID" -H "Authorization: Bearer $O1")
expect "GET /properties/:id after delete → 404" 404 "$code"

echo "=== $pass passed, $fail failed ==="
exit $fail
