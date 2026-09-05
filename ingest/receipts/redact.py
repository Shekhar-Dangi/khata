"""Turn a real invoice into a fixture that is safe to commit.

WHY THIS EXISTS. The khata repo is PUBLIC-BOUND -- the project notes is explicit that no personal data
may ever reach it, and it records that names of private individuals once got in through worked
examples, which is exactly how it happens. Real invoices are full of it: the buyer's name,
their street address, their pin code, their order and payment references.

But parser tests must run on REAL STRUCTURE, because every trap the design found is
structural -- a UPC split across four lines, two invoices in one file, an Annexure spilling
onto its own page. A hand-written fake would test a fiction and pass while the parser fails on
the real thing.

So: keep the structure exactly, replace the identity. The existing `src/fixtures/
splitwise-sample.csv` already sets this convention with "Test User One"; this is the same idea
for PDFs.

WHAT IS KEPT, AND WHY IT IS NOT PERSONAL DATA:
  - seller name, seller GSTIN, FSSAI, CIN, PAN -- a COMPANY's public tax registrations, not
    the buyer's. Blink Commerce's GSTIN is on every invoice it has ever issued.
  - HSN codes, UPCs, ASINs -- product identifiers. They describe a Coke bottle, not a person.
  - line amounts, quantities, totals, tax rates -- structurally essential, because the whole
    point of the design's gate is that the arithmetic must reconcile to the paise.
    Fake amounts would make the one test that matters meaningless. An individual "Rs 40 for a
    Coke Zero" is not a ledger total and reveals nothing.
  - dates -- needed for the date-window logic, and an order date on its own identifies nobody.

WHAT IS REPLACED:
  - the buyer's name, address and pin code
  - order ids, invoice numbers, payment transaction ids  (the project notes: "not real transaction
    references")
Replacements are OBVIOUSLY SYNTHETIC, per the same convention -- a redaction that looks real is
worse than none, because the next reader cannot tell it was redacted.
"""

from __future__ import annotations

import re
from dataclasses import replace

from .extract import Document, Page

# Fixed, obviously-fake stand-ins. Stable across runs so a regenerated fixture produces no diff
# noise, and so a test can assert on them.
FAKE_NAME = "Test Customer"
FAKE_ADDRESS = "1 Example Road, Example Locality, Example City"
FAKE_PIN = "000000"
FAKE_STATE = "Example State"


class _Counter:
    """Stable synthetic ids: the SAME real value maps to the same fake one within a document.

    That property is load-bearing. A Blinkit order appears on both of its invoices, and a
    parser's whole job in the design is to notice they are one order. Randomising
    per occurrence would destroy the exact relationship the fixture needs to exercise.
    """

    def __init__(self, template: str, start: int) -> None:
        self._template, self._next, self._seen = template, start, {}

    def __call__(self, real: str) -> str:
        if real not in self._seen:
            self._seen[real] = self._template.format(self._next)
            self._next += 1
        return self._seen[real]


def _redact_text(text: str, orders: _Counter, invoices: _Counter, payments: _Counter) -> str:
    # --- identity: name, address, pin, buyer state -------------------------------------
    # Blinkit: "Name : <buyer>", "Address : ...", "Pin code : <pin>"
    text = re.sub(r"(Name\s*:\s*)([^\n]+)", lambda m: m.group(1) + FAKE_NAME, text)
    text = re.sub(r"(Address\s*:\s*)([^\n]+)", lambda m: m.group(1) + FAKE_ADDRESS, text)
    text = re.sub(r"(Pin\s*code\s*:\s*)(\d+)", lambda m: m.group(1) + FAKE_PIN, text)

    # Amazon: free-standing "Billing Address :" / "Shipping Address :" blocks whose following
    # lines are the address. Handled by blanking the LINES rather than a labelled field,
    # because the template wraps them across the page with no label per line.
    text = _redact_amazon_address_block(text)

    # --- references --------------------------------------------------------------------
    text = re.sub(r"(Order\s*Id\s*:\s*)(\d+)", lambda m: m.group(1) + orders(m.group(2)), text)
    text = re.sub(
        r"(Order\s*Number\s*:\s*)(\d{3}-\d{7}-\d{7})",
        lambda m: m.group(1) + orders(m.group(2)),
        text,
    )
    text = re.sub(
        r"(Invoice\s*Number\s*:?\s*)([A-Z0-9][A-Z0-9-]{4,})",
        lambda m: m.group(1) + invoices(m.group(2)),
        text,
    )
    text = re.sub(
        r"(Invoice\s*Details\s*:\s*)([A-Z0-9][A-Z0-9-]{4,})",
        lambda m: m.group(1) + invoices(m.group(2)),
        text,
    )
    text = re.sub(
        r"(Payment\s*Transaction\s*ID\s*:\s*)(\S+)",
        lambda m: m.group(1) + payments(m.group(2)),
        text,
    )
    # Blinkit's own payment reference, when present.
    text = re.sub(r"\b\d{12}\b", "000000000000", text)
    return text


def _redact_amazon_address_block(text: str) -> str:
    """Blank the address lines that follow an Amazon address label.

    Amazon does not label each line, so there is no field to rewrite -- only a run of lines
    after "Billing Address :" / "Shipping Address :" until a line that is clearly structural
    (a label with a colon, or a known section start). Erring toward blanking MORE is right
    here: an over-redacted fixture is merely less useful, an under-redacted one is a leak.
    """
    out: list[str] = []
    blanking = False
    for line in text.split("\n"):
        if re.search(r"(Billing|Shipping|Sold\s*By)\s*Address\s*:", line):
            out.append(re.sub(r"(Address\s*:).*", r"\1 " + FAKE_ADDRESS, line))
            blanking = True
            continue
        if blanking:
            # Stop at the next structural landmark rather than after a fixed line count --
            # addresses vary in length and a fixed count would clip a real field or leak one.
            if re.search(
                r"(Order\s*(Number|Date)|Invoice|PAN\s*No|GST\s*Registration|FSSAI|"
                r"State/UT|Place\s*of|Sl\.|Description|Tax\s*Invoice)",
                line,
            ):
                blanking = False
                out.append(line)
                continue
            if line.strip() == "":
                out.append(line)
                continue
            out.append("[redacted]")
            continue
        out.append(line)
    return "\n".join(out)


def scrub_literals(text: str, forbidden: list[str]) -> str:
    """Replace every known-private string, wherever it appears.

    THE STRUCTURAL RULES ABOVE ARE NOT ENOUGH ON THEIR OWN, and the reason is the same fact
    that makes PDFs hard in the first place: `extract_text()` LINEARISES a two-column layout,
    so a seller's field and a buyer's field land on ONE line --

        PAN No: AAPCA6346P Flat 12, <buyer's street>

    A line-based rule sees the `PAN No` landmark, concludes the address block ended, and
    leaves the buyer's address sitting on that line. Layout inference cannot be trusted for
    something whose failure mode is a privacy leak.

    So the caller's `--forbid` list DRIVES redaction as well as verifying it. Substring
    replacement has no layout assumptions to get wrong: if a value is in the list it does not
    survive, wherever the template happened to put it. The structural rules stay because they
    generalise to values a caller did not think to list; this catches the ones they did.
    """
    for needle in sorted(forbidden, key=len, reverse=True):  # longest first: "Flat 12" before "12"
        if not needle:
            continue
        text = re.sub(re.escape(needle), "[redacted]", text, flags=re.IGNORECASE)
    return text


def redact_document(doc: Document, forbidden: list[str] | None = None) -> Document:
    """A copy of `doc` with identity and references replaced, structure untouched."""
    orders = _Counter("ORDER{:04d}", 1)
    invoices = _Counter("INV{:04d}", 1)
    payments = _Counter("PAYREF{:04d}", 1)
    forbidden = forbidden or []

    def clean(s: str) -> str:
        return scrub_literals(_redact_text(s, orders, invoices, payments), forbidden)

    pages = [
        replace(
            page,
            text=clean(page.text),
            tables=[[[clean(c) for c in row] for row in table] for table in page.tables],
        )
        for page in doc.pages
    ]
    redacted = replace(doc, pages=pages)
    # char_count is a property of the ORIGINAL document and is asserted on by the scan check;
    # recompute so the fixture is internally consistent.
    return replace(redacted, char_count=sum(len(p.text) for p in pages))


# Values that must never survive into a fixture. Checked by `verify_clean` rather than trusted,
# because a redaction rule that silently stops matching is invisible -- the fixture still looks
# redacted, and the leak is in the part nobody re-reads.
def verify_clean(doc: Document, forbidden: list[str]) -> list[str]:
    """Return every forbidden string still present. Empty means the fixture is safe."""
    blob = "\n".join(
        p.text + "\n" + "\n".join("\t".join(r) for t in p.tables for r in t) for p in doc.pages
    ).lower()
    return sorted({needle for needle in forbidden if needle and needle.lower() in blob})
