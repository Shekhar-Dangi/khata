#!/usr/bin/env bash
# Smoke test for the finance API. Start the server first (npm run dev), then:
#   bash scripts/smoke.sh
# Prints each endpoint's body + [HTTP status]. Tests happy paths AND edge cases.

BASE=http://localhost:3000

# helper: req METHOD PATH [JSON_BODY]
req() {
  local method=$1 path=$2 json=${3:-}
  if [ -n "$json" ]; then
    curl -s -w '  [%{http_code}]\n' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$json"
  else
    curl -s -w '  [%{http_code}]\n' -X "$method" "$BASE$path"
  fi
}

echo "health:                 ";  req GET  /health
echo "balance acct 1:         ";  req GET  /accounts/1/balance
echo "balance 999 (expect 404):"; req GET  /accounts/999/balance
echo "reconcile acct 1:       ";  req GET  /accounts/1/reconcile
echo "reconcile 999 (404):    ";  req GET  /accounts/999/reconcile
echo "detect-transfers acct1: ";  req POST /accounts/1/detect-transfers
echo "import good (201):      ";  req POST /accounts/1/transactions '{"transactions":[{"txn_date":"2026-07-01","amount_paise":-12300,"type":"regular","narration":"Smoke"}]}'
echo "import re-run (skip):   ";  req POST /accounts/1/transactions '{"transactions":[{"txn_date":"2026-07-01","amount_paise":-12300,"type":"regular","narration":"Smoke"}]}'
echo "import to 999 (404):    ";  req POST /accounts/999/transactions '{"transactions":[{"txn_date":"2026-07-01","amount_paise":100,"type":"regular"}]}'
echo "import bad row (400):   ";  req POST /accounts/1/transactions '{"transactions":[{"amount_paise":0,"txn_date":"x","type":"z"}]}'
echo "import bad JSON (400):  ";  req POST /accounts/1/transactions 'not json'
echo "unknown route (404):    ";  req GET  /nope

echo
echo "(reset DB to clean state with: psql -d finance -f db/seed.sql)"
