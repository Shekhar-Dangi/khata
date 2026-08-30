#!/usr/bin/env bash
# Capture every read-only endpoint's exact response, so a refactor can be PROVED not to
# have changed behaviour.
#
#   bash scripts/snapshot.sh before      # with the server running
#   ...refactor...
#   bash scripts/snapshot.sh after
#   diff -r .snapshots/before .snapshots/after     # must be empty
#
# Why this exists: every test in src/*.test.ts is PURE. They would all pass if you deleted
# the entire routes layer. Moving 2,600 lines of endpoints with only a typechecker for
# company is how a route silently stops being registered — `tsc` is perfectly happy with
# code nobody calls.
#
# SAFE TO RUN AGAINST REAL DATA. Every request below is either a GET or a deliberate
# validation failure (400/404), and a request rejected at validation never reaches a
# write. Nothing here mutates the ledger — unlike scripts/smoke.sh, which imports a row
# and whose documented cleanup is a full re-seed.
set -u

BASE=${BASE:-http://localhost:3000}
LABEL=${1:?usage: snapshot.sh <before|after>}
OUT=".snapshots/$LABEL"

rm -rf "$OUT"
mkdir -p "$OUT"

n=0
# cap METHOD PATH [JSON] — one file per request: the status line, then the body.
cap() {
  local method=$1 path=$2 json=${3:-}
  n=$((n + 1))
  # A filename from the request, so a diff names the endpoint that changed rather than
  # "file 17". Slashes and query separators become dashes.
  local name
  name=$(printf '%03d_%s_%s' "$n" "$method" "$path" | tr '/?&=' '----' | cut -c1-110)
  {
    if [ -n "$json" ]; then
      curl -s -m 15 -w '\nHTTP %{http_code}\n' -X "$method" "$BASE$path" \
        -H 'Content-Type: application/json' -d "$json"
    else
      curl -s -m 15 -w '\nHTTP %{http_code}\n' -X "$method" "$BASE$path"
    fi
  } > "$OUT/$name"
  printf '.'
}

echo "capturing -> $OUT"

# ── reads ────────────────────────────────────────────────────────────────────
cap GET /health
cap GET /accounts
cap GET /categories
cap GET /keywords
cap GET /summary
cap GET /anomalies
cap GET /rules
cap GET /rules/vocabulary
cap GET /reports/by-rule
cap GET /reports/by-category

for id in 1 2 3; do
  cap GET "/accounts/$id/balance"
  cap GET "/accounts/$id/transactions"
  cap GET "/accounts/$id/reconcile"
  cap GET "/accounts/$id/keywords"
done

# The consolidated ledger, across the whole filter vocabulary — this is the endpoint with
# the most ways to be subtly wrong.
cap GET "/transactions?limit=5"
cap GET "/transactions?limit=5&offset=5"
cap GET "/transactions?limit=500"
cap GET "/transactions?limit=5&account_id=1"
cap GET "/transactions?limit=5&from=2026-08-01&to=2026-08-31"
cap GET "/transactions?limit=5&from=2026-08-14&to=2026-08-14"
cap GET "/transactions?limit=5&from=2026-08-20"
cap GET "/transactions?limit=5&to=2026-06-01"
cap GET "/transactions?limit=5&q=upi"
cap GET "/transactions?limit=5&q=50%25"
cap GET "/transactions?limit=5&source=user"
cap GET "/transactions?limit=5&source=rule"
cap GET "/transactions?limit=5&source=unexplained"
cap GET "/transactions?limit=5&spend_only=true"
cap GET "/transactions?limit=5&category_id=1"
cap GET "/transactions?limit=5&rule_id=30"

cap GET "/reports/by-category?from=2026-07-01&to=2026-07-31"
cap GET "/reports/by-category?account_id=1"
cap GET "/reports/by-rule?from=2026-08-01&to=2026-08-31"
cap GET "/reports/by-rule?spend_only=true"

# Transfers: paged by group, per-status, plus the counts block.
cap GET /transfers
for s in suspected resolved pending rejected; do
  cap GET "/transfers?status=$s&limit=3"
done
cap GET "/transfers?limit=2&offset=2"

# ── validation failures ──────────────────────────────────────────────────────
# Every one of these must be rejected BEFORE any write. If a refactor turns one of them
# into a 200 or a 500, that is exactly the regression this file exists to catch.
cap GET "/transactions?from=notadate"
cap GET "/transactions?from=2026-06-31"          # impossible day — must be 400, not 500
cap GET "/transactions?from=2026-08-31&to=2026-08-01"
cap GET "/transactions?limit=0"
cap GET "/transactions?limit=501"
cap GET "/transactions?offset=-1"
cap GET "/transactions?source=nonsense"
cap GET "/transactions?account_id=abc"
cap GET "/transfers?status=nonsense"
cap GET /accounts/999/balance
cap GET /accounts/999/reconcile
cap GET /accounts/999/keywords
cap GET /accounts/abc/balance
cap GET /nope

cap POST /rules '{"name":""}'
cap POST /rules '{"name":"x","conditions":[]}'
cap POST /rules '{"name":"x","conditions":[{"field":"nope","op":"contains","value":"a"}]}'
cap POST /rules '{"name":"x","conditions":[{"field":"narration","op":"regex","value":"a"}]}'
cap POST /rules '{"name":"x","conditions":[{"field":"amount_paise","op":"lt","value":"1"}]}'
cap POST /rules '{"name":"x","conditions":[{"field":"txn_date","op":"lt","value":"March 3"}]}'
cap POST /rules '{"name":"x","conditions":[{"field":"narration","op":"contains","value":"a"}],"category_id":999999}'
cap PATCH /rules/999999 '{"name":"x"}'
cap PATCH /rules/abc '{"name":"x"}'
cap DELETE /rules/999999
cap DELETE /rules/abc

cap POST /categories '{"name":""}'
cap POST /categories '{"name":"x","parent_id":999999}'
cap PATCH /categories/999999 '{"name":"x"}'
cap DELETE /categories/999999
cap DELETE "/categories/1?reassign_to=abc"

cap POST /accounts/999/keywords '{"keyword":"a","kind":"upi_handle"}'
cap POST /accounts/1/keywords '{"keyword":"","kind":"upi_handle"}'
cap POST /accounts/1/keywords '{"keyword":"a","kind":"nope"}'
cap DELETE /accounts/1/keywords/999999
cap POST /accounts/999/detect-transfers
cap POST /accounts/abc/detect-transfers

cap POST /transfers/999999/confirm
cap POST /transfers/999999/reject
cap POST /transfers/abc/confirm
cap POST /transactions/999999/unlink-transfer
cap POST /transactions/abc/unlink-transfer
cap POST /transactions/999999/allocations '{"allocations":[]}'
cap POST /transactions/abc/allocations '{"allocations":[]}'

cap POST /accounts/999/transactions '{"transactions":[{"txn_date":"2026-07-01","amount_paise":100,"type":"regular"}]}'
cap POST /accounts/1/transactions '{"transactions":[]}'
cap POST /accounts/1/transactions '{"transactions":[{"amount_paise":0,"txn_date":"x","type":"z"}]}'
cap POST "/rules/apply?account_id=abc"
cap POST "/rules/apply?account_id=999"

echo
echo "captured $n responses in $OUT"
