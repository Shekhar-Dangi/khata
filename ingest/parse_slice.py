"""Slice savings-statement PDF parser.

Slice statements are born-digital but have NO ruling lines — the table is purely
whitespace/position-aligned. So we reconstruct it geometrically from word positions:
group words into rows by `top`, anchor transaction rows on a day-number in the date
column followed by a month, and assign every other word to a column by its `x0`.

Column x-bands below are read off the header row (DATE 32 | DETAILS 92 | REF 284 |
AMOUNT ~442 | BALANCE ~535); revisit them if Slice changes its template.

Usage: python parse_slice.py <pdf-path>
Local-only.
"""

import re
import sys
from decimal import Decimal

import pdfplumber

MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}

# Column boundaries by x0 (see module docstring).
DATE_MAX_X0 = 80
REF_MIN_X0 = 280
AMOUNT_MIN_X0 = 420
BALANCE_MIN_X0 = 500

DAY_RE = re.compile(r"^\d{1,2}$")
YEAR_RE = re.compile(r"^'?(\d{2})$")


def cluster_rows(words, tol=3.0):
    """Group words into visual rows by `top` (within `tol`), top-to-bottom,
    each row's words sorted left-to-right by x0."""
    rows = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if rows and abs(w["top"] - rows[-1][0]) <= tol:
            rows[-1][1].append(w)
        else:
            rows.append((w["top"], [w]))
    return [sorted(ws, key=lambda w: w["x0"]) for _, ws in rows]


def column(word):
    x0 = word["x0"]
    if x0 < DATE_MAX_X0:
        return "date"
    if x0 < REF_MIN_X0:
        return "details"
    if x0 < AMOUNT_MIN_X0:
        return "ref"
    if x0 < BALANCE_MIN_X0:
        return "amount"
    return "balance"


def is_txn_start(row):
    """A transaction begins with a day-number in the date column, then a month."""
    if len(row) < 3:
        return False
    w0, w1 = row[0], row[1]
    return w0["x0"] < DATE_MAX_X0 and bool(DAY_RE.match(w0["text"])) and w1["text"] in MONTHS


def parse_date(row):
    day = int(row[0]["text"])
    month = MONTHS[row[1]["text"]]
    year = 2000 + int(YEAR_RE.match(row[2]["text"]).group(1))  # '26 -> 2026
    return f"{year:04d}-{month:02d}-{day:02d}"


def parse_money(token):
    """'-₹1,099' -> -109900 paise ; '₹11,721.37' -> 1172137 paise."""
    sign = -1 if token.strip().startswith("-") else 1
    digits = token.replace("-", "").replace("₹", "").replace(",", "").strip()
    return sign * int(Decimal(digits) * 100)


def parse_transactions(pdf):
    txns = []
    current = None
    for page in pdf.pages:
        for row in cluster_rows(page.extract_words()):
            if is_txn_start(row):
                current = {
                    "txn_date": parse_date(row),
                    "type": "regular",
                    "ref": None,
                    "amount_paise": None,
                    "bank_balance_paise": None,
                    "_details": [],
                }
                txns.append(current)
                for w in row[3:]:  # skip day/month/year
                    c = column(w)
                    if c == "details":
                        current["_details"].append(w["text"])
                    elif c == "ref":
                        current["ref"] = w["text"]
                    elif c == "amount":
                        current["amount_paise"] = parse_money(w["text"])
                    elif c == "balance":
                        current["bank_balance_paise"] = parse_money(w["text"])
            elif current is not None and row and column(row[0]) == "details":
                # continuation line: its words are wrapped DETAILS
                current["_details"].extend(w["text"] for w in row if column(w) == "details")
    for t in txns:
        t["narration"] = " ".join(t.pop("_details"))
    return txns


def check_running_balance(txns):
    """Statement self-consistency: prev_balance + amount == this_balance.
    Validates signs, amounts, and balances end-to-end using the bank's own math."""
    problems = []
    for prev, curr in zip(txns, txns[1:]):
        if prev["bank_balance_paise"] is None or curr["bank_balance_paise"] is None:
            continue
        expected = prev["bank_balance_paise"] + curr["amount_paise"]
        if expected != curr["bank_balance_paise"]:
            problems.append((curr, expected))
    return problems


def main():
    path = sys.argv[1]
    with pdfplumber.open(path) as pdf:
        txns = parse_transactions(pdf)

    print(f"parsed {len(txns)} transactions\n")
    for t in txns:
        amt = t["amount_paise"] / 100 if t["amount_paise"] is not None else None
        bal = t["bank_balance_paise"] / 100 if t["bank_balance_paise"] is not None else None
        print(f"{t['txn_date']}  amt={amt:>12}  bal={bal:>12}  ref={t['ref']}")
        print(f"            {t['narration']}")

    problems = check_running_balance(txns)
    print("\n--- running-balance self-check ---")
    if not problems:
        print("OK: every prev_balance + amount == this_balance")
    else:
        print(f"{len(problems)} mismatch(es):")
        for curr, expected in problems:
            print(f"  {curr['txn_date']} {curr['narration'][:40]}: "
                  f"expected {expected} got {curr['bank_balance_paise']}")


if __name__ == "__main__":
    main()
