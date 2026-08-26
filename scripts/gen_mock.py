#!/usr/bin/env python3
"""Generate db/mock.sql — realistic fake data for building and demoing the UI.

Deterministic (fixed seed), so regenerating produces byte-identical SQL and the
committed file only changes when this generator does.

Why a generator rather than a hand-written .sql: the running `bank_balance_paise`
must be internally consistent for reconciliation to pass, and maintaining that by
hand across a few hundred rows is a losing game. Change VOLUME or the date range
here and the balances stay correct for free.

Run:  python scripts/gen_mock.py    (writes db/mock.sql)
"""

import random
from datetime import date, timedelta

SEED = 20260826
START = date(2026, 3, 1)
END = date(2026, 8, 26)

random.seed(SEED)


def ref(n=12):
    return "".join(random.choice("0123456789") for _ in range(n))


# (narration template, min paise, max paise, weight). Narration shapes copy the real
# Indian UPI/POS/NEFT forms the parsers emit, including the per-transaction reference
# number that makes every raw narration unique — that is exactly what normalise() strips.
SPEND = [
    (lambda: f"UPI-Debit-{ref()}-BLINKIT-HDFC-blinkit", 18000, 140000, 14),
    (lambda: f"UPI-Debit-{ref()}-SWIGGY-YESB-swiggy", 22000, 90000, 12),
    (lambda: f"UPI-Debit-{ref()}-ZOMATO-HDFC-zomato", 20000, 85000, 8),
    (lambda: f"UPI-Debit-{ref()}-ZEPTO-ICIC-zepto", 15000, 70000, 7),
    (lambda: f"POS/AMAZON PAY INDIA/BANGALORE/{ref(6)}", 45000, 480000, 9),
    (lambda: f"NEFT-CITIN{ref(9)}-AMAZON SELLER SERVICES", 90000, 620000, 4),
    (lambda: f"UPI-Debit-{ref()}-UBER INDIA-HDFC-uber", 12000, 62000, 9),
    (lambda: f"UPI-Debit-{ref()}-RAPIDO-AXIS-rapido", 6000, 28000, 5),
    (lambda: f"UPI-Debit-{ref()}-RELIANCE SMART-HDFC", 80000, 420000, 5),
    (lambda: f"UPI-Debit-{ref()}-APOLLO PHARMACY-SBIN", 15000, 190000, 4),
    (lambda: f"UPI-Debit-{ref()}-HP PETROL PUMP-HDFC", 100000, 320000, 5),
    (lambda: "UPI-Debit-airtel.pay", 39900, 109900, 4),
    (lambda: f"UPI-Debit-{ref()}-BESCOM-SBIN-bescom", 85000, 310000, 3),
    (lambda: "NETFLIX SUBSCRIPTION INDIA", 64900, 64900, 2),
    (lambda: "SPOTIFY INDIA PVT LTD", 11900, 11900, 2),
    (lambda: f"UPI-Debit-{ref()}-CULT FIT-HDFC-cultfit", 150000, 150000, 2),
    (lambda: f"ATM-CASH-WDL-{ref(8)}-BANGALORE", 200000, 1000000, 3),
    (lambda: f"UPI-Debit-{ref()}-DECATHLON-HDFC", 120000, 700000, 2),
    (lambda: f"UPI-Debit-{ref()}-CROMA-ICIC-croma", 250000, 1800000, 1),
]

WEIGHTED = [m for m in SPEND for _ in range(m[3])]


def pick_spend():
    narr, lo, hi, _ = random.choice(WEIGHTED)
    amount = -(random.randrange(lo, hi + 1) // 100 * 100)  # round to the rupee
    return narr(), amount


rows = []  # (account_id, date, amount_paise, type, narration, has_balance)


def add(acct, d, amount, kind, narration, has_balance=True):
    rows.append([acct, d, amount, kind, narration, has_balance])


# ── opening balances ────────────────────────────────────────────────────────
add(1, START, 14250000, "opening_balance", "Opening balance")
add(2, START, 14800000, "opening_balance", "Opening balance")
add(3, START, 920000, "opening_balance", "Opening balance")

# ── the monthly rhythm ──────────────────────────────────────────────────────
month_starts = []
d = START
while d <= END:
    month_starts.append(d)
    d = (d.replace(day=28) + timedelta(days=4)).replace(day=1)

for m in month_starts:
    # Salary lands on the 1st, into HDFC.
    add(1, m, 18500000, "regular", "SALARY CREDIT - ACME TECH PVT LTD")
    # Rent leaves on the 3rd.
    rent_day = min(m.day + 2, 28)
    add(1, m.replace(day=rent_day), -3200000, "regular",
        f"UPI-Debit-{ref()}-RAJESH KUMAR-HDFC-landlord")
    # Card bill / top-up to Slice mid-month: a real internal transfer, both legs.
    tday = m.replace(day=min(15, 28))
    if tday <= END:
        add(1, tday, -2500000, "transfer", "UPI to self - Slice")
        add(3, tday, 2500000, "transfer", "UPI from self - HDFC")

# ── everyday spending ───────────────────────────────────────────────────────
day = START
while day <= END:
    for _ in range(random.choices([0, 1, 2, 3], weights=[18, 40, 30, 12])[0]):
        acct = random.choices([1, 2, 3], weights=[52, 18, 30])[0]
        narration, amount = pick_spend()
        # A few rows genuinely arrive without a stated balance — the parsers see this,
        # and reconciliation has to cope (they still affect the running sum).
        add(acct, day, amount, "regular", narration, has_balance=random.random() > 0.06)
    day += timedelta(days=1)

# A couple of refunds — CREDITS at a merchant that is otherwise a debit. These are what
# a "money out only" condition on a spend rule exists to exclude.
add(1, date(2026, 5, 12), 148000, "regular", "Refund - AMAZON PAY INDIA")
add(1, date(2026, 7, 3), 62000, "regular", "Refund - SWIGGY ORDER CANCELLED")
add(2, date(2026, 6, 19), 25000, "regular", "Refund - ZEPTO ORDER")

# Interest credits on the savings account.
for m in month_starts[::3]:
    add(2, m.replace(day=min(28, 28)), 41200, "regular", "INTEREST CREDIT - QUARTERLY")

rows.sort(key=lambda r: (r[1], r[0]))

# ── running balances, per account ───────────────────────────────────────────
# Computed here so every checkpoint is internally consistent and /reconcile passes.
balance = {1: 0, 2: 0, 3: 0}
out = []
for acct, d, amount, kind, narration, has_balance in rows:
    balance[acct] += amount
    out.append((acct, d, amount, kind, narration,
                balance[acct] if has_balance else None))

# ── one deliberate fault, so /anomalies has something real to show ──────────
# Drop a mid-series Indian Bank row from the LEDGER but leave every stated balance as
# it was. The bank's balances then imply money we have no transaction for — exactly the
# shape of a missing row in a real import.
ib = [i for i, r in enumerate(out) if r[0] == 2 and r[3] == "regular" and r[5] is not None]
dropped = out.pop(ib[len(ib) // 2])

sql = ["""-- Mock transactions for building/navigating the UI (NOT real data).
-- GENERATED by scripts/gen_mock.py — edit that, not this file.
-- Re-runnable: clears transactions + statements first, keeps the 3 accounts.
-- Wipe before importing real statements:  psql -d finance -f db/seed.sql
TRUNCATE transactions, statements RESTART IDENTITY CASCADE;

-- Signed paise (+in / -out). bank_balance_paise = the bank's stated running balance,
-- so /reconcile has checkpoints. A few rows carry NULL (the bank did not print one).
-- Indian Bank has ONE deliberately missing transaction -> a real anomaly to look at.
INSERT INTO transactions
  (account_id, txn_date, amount_paise, type, narration, bank_balance_paise) VALUES"""]

vals = []
for acct, d, amount, kind, narration, bal in out:
    n = narration.replace("'", "''")
    b = "NULL" if bal is None else str(bal)
    vals.append(f"  ({acct}, '{d.isoformat()}', {amount}, '{kind}', '{n}', {b})")
sql.append(",\n".join(vals) + ";")

sql.append(f"""
-- Dropped on purpose (the anomaly): account {dropped[0]}, {dropped[1].isoformat()},
-- {dropped[2]} paise, "{dropped[4][:40]}". Every stated balance still includes it, so
-- the reconciliation walk finds the gap and localises it to that segment.""")

with open("db/mock.sql", "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(sql) + "\n")

print(f"wrote db/mock.sql — {len(out)} transactions, {START} to {END}")
print(f"  dropped for the anomaly: acct {dropped[0]} {dropped[1]} {dropped[2]} paise")
