"""The normalized record every parser emits, and the arithmetic gate it must pass.

A parser's whole job is to emit the normalized record shape. Everything
downstream -- dedupe, matching, allocation -- is already source-agnostic, so a new merchant is
a module that produces THIS and nothing else.

Money is INTEGER PAISE everywhere, parsed through Decimal and never through float. A float
cannot hold 0.1, so a few hundred line items summing in float drift off the stated total by a
paise or two -- and the reconcile gate below would then reject correct invoices while the real
bug sat in the arithmetic. This mirrors the TypeScript side, where every amount is a BIGINT of
paise for the same reason.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation


class ParseError(Exception):
    """This document cannot be turned into a record. Never a partial one."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


#: Everything that is not a digit, a dot or a minus. Covers the rupee sign, thousands commas,
#: and the stray whitespace pdfplumber leaves inside a cell.
_MONEY_JUNK = re.compile(r"[^\d.\-]")


def to_paise(text: str | None) -> int | None:
    """'₹1,422.43' -> 142243. None when the cell holds no number at all.

    Returns None rather than 0 for an empty cell, because those mean different things: a fee
    row legitimately has no MRP, and a zero would silently enter the arithmetic as a real
    amount.
    """
    if text is None:
        return None
    cleaned = _MONEY_JUNK.sub("", text.replace("\n", " "))
    if cleaned in ("", "-", ".", "-."):
        return None
    try:
        # quantize to 2dp before scaling: some templates print 3 decimals in a tax column.
        return int((Decimal(cleaned) * 100).quantize(Decimal("1")))
    except (InvalidOperation, ValueError):
        return None


@dataclass
class LineItem:
    #: 'goods' or 'fee'. Fees are NOT smeared across products -- Amazon
    #: prints "Cash/Pay on Delivery fee" and "Marketplace Fees" as numbered rows exactly like
    #: products, and treating them as products would invent things you never bought.
    kind: str
    invoice_number: str
    #: Verbatim. When a template changes, this is the only thing that lets a re-parse recover.
    description: str
    #: The merchant's own id: an ASIN for most things, an ISBN for books, whatever the
    #: template prints in the trailing "| X ( Y )". None for fee rows.
    sku: str | None
    hsn: str | None
    qty: int
    #: TAX-INCLUSIVE line total. This is the number that gets allocated -- allocating the net
    #: would leave GST as a permanent phantom remainder.
    amount_paise: int
    unit_paise: int | None = None
    net_paise: int | None = None
    tax_paise: int | None = None
    discount_paise: int | None = None


@dataclass
class Invoice:
    invoice_number: str
    seller_name: str | None
    invoice_date: str | None
    total_paise: int
    lines: list[LineItem] = field(default_factory=list)


@dataclass
class OrderRecord:
    source_type: str
    #: The ORDER id, not an invoice number. One order is N invoices, and
    #: keying evidence per invoice would make the second overwrite the first.
    external_ref: str
    order_date: str | None
    total_paise: int
    invoices: list[Invoice] = field(default_factory=list)
    payment: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def lines(self) -> list[LineItem]:
        return [ln for inv in self.invoices for ln in inv.lines]


def reconcile(record: OrderRecord) -> list[str]:
    """The reconcile gate. Returns the discrepancies; empty means it adds up.

    Two checks, because there are two places arithmetic can go wrong:

      per invoice   the lines must sum to the total the invoice states
      per order     the invoice totals must sum to the order total

    EXACT, to the paise. No tolerance, and that is deliberate: all four original samples
    reconciled exactly, so any drift means a mis-read row -- and a mis-read row is money in
    the wrong category, which is the failure this whole design exists to prevent. A tolerance
    would convert a loud bug into a quiet one.
    """
    problems: list[str] = []
    for inv in record.invoices:
        line_sum = sum(ln.amount_paise for ln in inv.lines)
        if line_sum != inv.total_paise:
            problems.append(
                f"invoice {inv.invoice_number}: lines sum to {line_sum} "
                f"but the invoice states {inv.total_paise}"
            )
    invoice_sum = sum(inv.total_paise for inv in record.invoices)
    if invoice_sum != record.total_paise:
        problems.append(
            f"order {record.external_ref}: invoices sum to {invoice_sum} "
            f"but the order total is {record.total_paise}"
        )
    return problems
