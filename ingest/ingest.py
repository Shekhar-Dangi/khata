"""Ingest one or more bank statements into the finance app, then run the usual pipeline.

Usage: python ingest.py <file...>
  .pdf  -> Slice parser
  .xlsx -> HDFC / Indian Bank parser (auto-detected by header)

Per file: parse -> POST to the import API for the matching account (by bank).
Then, once per touched account: reconcile + detect-transfers.
Local-only; talks to the dev server on :3000.
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import parse_slice
import parse_xlsx

API = "http://localhost:3000"


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} -> {e.code}: {e.read().decode()[:300]}") from None


def parse_file(path):
    ext = Path(path).suffix.lower()
    if ext == ".pdf":
        return parse_slice.parse(path)
    if ext == ".xlsx":
        return parse_xlsx.parse(path)
    raise ValueError(f"unsupported file type: {ext}")


def main():
    files = sys.argv[1:]
    if not files:
        print("usage: python ingest.py <file...>")
        return

    bank_to_id = {a["bank"]: a["id"] for a in api("GET", "/accounts")["accounts"]}

    touched = set()
    for path in files:
        try:
            bank, txns = parse_file(path)
            account_id = bank_to_id.get(bank)
            if account_id is None:
                print(f"! {Path(path).name}: no account for bank '{bank}' — skipping")
                continue
            res = api("POST", f"/accounts/{account_id}/transactions",
                      {"transactions": txns, "statement": {"source": Path(path).name}})
            touched.add(account_id)
            print(f"{Path(path).name} -> {bank} (account {account_id}): "
                  f"parsed {len(txns)}, inserted {res['inserted']}, skipped {res['skipped']}")
        except Exception as e:
            print(f"! {Path(path).name}: {e}")

    print("\n--- pipeline (reconcile + detect-transfers) ---")
    for account_id in sorted(touched):
        rec = api("GET", f"/accounts/{account_id}/reconcile")
        det = api("POST", f"/accounts/{account_id}/detect-transfers")
        status = "reconciled" if rec["reconciled"] else f"{len(rec['discrepancies'])} discrepancy(ies)"
        print(f"account {account_id}: {status}; "
              f"transfers resolved={det['resolved']} pending={det['pending']} suspected={det['suspected']}")


if __name__ == "__main__":
    main()
