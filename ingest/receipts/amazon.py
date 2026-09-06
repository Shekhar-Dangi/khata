"""Amazon invoice -> OrderRecord. Knows about Amazon and nothing about PDFs or the ledger.

Everything here was derived from a real corpus of a few hundred invoices, and the awkward
parts are awkward because the corpus is:

  * FOUR header layouts.  "Qty" or "Quantity", "Discount" present or absent, so column
    POSITIONS shift between invoices. The column map is built from the header row every time;
    indexing by position is the bug that made an early survey report 17% mismatches.
  * A large share of files hold MORE THAN ONE invoice, and some hold three. Segmentation is
    by the "Invoice Number" marker, never by page.
  * Fee rows are numbered exactly like products -- "Cash/Pay on Delivery fee",
    "Marketplace Fees". They are real money and belong in the total, but they are not
    things you bought.
  * Books carry an ISBN where everything else carries an ASIN, so the id is taken from the
    template's "| X ( Y )" shape rather than by matching the ASIN pattern.
  * A file can be a DELIVERY CHALLAN, not an invoice. It is refused rather than landed.
"""

from __future__ import annotations

import re

from .extract import Document
from .shapes import Invoice, LineItem, OrderRecord, ParseError, to_paise

SOURCE = "amazon"

_MARKERS = ("amazon retail india private limited", "amazon seller services", "amazon.in")

_ORDER_NUMBER = re.compile(r"Order\s*Number\s*:\s*([0-9]{3}-[0-9]{7}-[0-9]{7})")
#: A CREDIT NOTE is a refund, not a purchase, and it says so in its own vocabulary: "Order No"
#: rather than "Order Number", "Credit Note No" rather than "Invoice Number". A real order
#: history holds a fair number of these. Landing one as an invoice would record a second PURCHASE
#: of something you actually sent back -- the money would move the wrong way twice. They are
#: refused here until a refund model is built, which is what they belong to: a refund is its own
#: event, not a reversal of the purchase.
_CREDIT_NOTE = re.compile(r"Credit\s*Note\s*(?:No|Number|Date)\s*:", re.IGNORECASE)
_ORDER_DATE = re.compile(r"Order\s*Date\s*:\s*([0-9]{2}[./-][0-9]{2}[./-][0-9]{4})")
_INVOICE_NUMBER = re.compile(r"Invoice\s*Number\s*:\s*(\S+)")
_INVOICE_DATE = re.compile(r"Invoice\s*Date\s*:\s*([0-9]{2}[./-][0-9]{2}[./-][0-9]{4})")
_SELLER = re.compile(r"For\s+(.+?)\s*:\s*Authorized\s+Signatory", re.IGNORECASE | re.DOTALL)
_HSN = re.compile(r"HSN\s*[:\-]\s*(\d{4,8})")
_PAYMENT_MODE = re.compile(r"Mode\s*of\s*Payment\s*:\s*\n?\s*([A-Za-z ]+)")
#: The template's identifier shape: "... | B0XXXXXXXX ( SELLER-SKU )". The id is the last
#: pipe-separated segment before the bracket, which is an ASIN for most things and an ISBN for
#: books -- matching the ASIN pattern alone would silently drop every book.
_SKU_TAIL = re.compile(r"\|\s*([A-Za-z0-9][A-Za-z0-9._-]{4,20})\s*\(")

#: Rows that are money but not merchandise.
_FEE_WORDS = ("delivery fee", "marketplace fee", "shipping charge", "handling", "cod fee")


def detect(text: str) -> bool:
    lowered = text.lower()
    return any(m in lowered for m in _MARKERS)


def _norm(cell: str | None) -> str:
    return (cell or "").replace("\n", " ").strip()


def _column_map(header: list[str]) -> dict[str, int]:
    """Header cells -> column indices, by NAME.

    The whole reason this function exists: "Qty" and "Quantity" are the same column under two
    names, and "Discount" appears in only 71 of 366 tables. Anything that assumed a fixed
    position would read the discount column as the quantity on a fifth of the corpus.
    """
    aliases = {
        "sl. no": "sl", "sl.no": "sl", "sl no": "sl",
        "description": "description",
        "unit price": "unit_price",
        "qty": "qty", "quantity": "qty",
        "discount": "discount",
        "net amount": "net",
        "tax rate": "tax_rate",
        "tax type": "tax_type",
        "tax amount": "tax_amount",
        "total amount": "total",
    }
    found: dict[str, int] = {}
    for i, cell in enumerate(header):
        key = aliases.get(_norm(cell).lower())
        if key and key not in found:
            found[key] = i
    return found


def _line_item_tables(doc: Document):
    """Yield (page_index, header_row_index, table) for every table that has a line-item header."""
    for page in doc.pages:
        for table in page.tables:
            for i, row in enumerate(table):
                if _norm(row[0]).lower().startswith("sl."):
                    yield page.index, i, table
                    break


def _invoice_numbers_by_page(doc: Document) -> dict[int, str]:
    """Which invoice each page belongs to.

    A page WITHOUT an invoice number belongs to the invoice before it — a long invoice spills
    its terms and its payment table onto later pages. Assuming one invoice per page produces
    phantom invoices with no lines, which then fail the reconcile gate on a perfectly good file.
    """
    mapping: dict[int, str] = {}
    current: str | None = None
    for page in doc.pages:
        found = _INVOICE_NUMBER.search(page.text)
        if found:
            current = found.group(1)
        if current is not None:
            mapping[page.index] = current
    return mapping


def _parse_description(raw: str) -> tuple[str, str | None, str | None]:
    """-> (verbatim description, sku, hsn)."""
    description = raw.strip()
    hsn = _HSN.search(description)
    sku = _SKU_TAIL.search(description)
    return description, (sku.group(1) if sku else None), (hsn.group(1) if hsn else None)


def _is_fee_label(line: str) -> bool:
    """Is this line a charge on its own, rather than a product that mentions one?

    Length is the discriminator, and it has to be: a real product description runs to a
    hundred characters of marketing copy and carries an identifier, while a charge is three
    words and carries nothing. Testing the WHOLE description for a fee word instead is what
    misfiled "Vitamin Supplement 120 Tablets ... | B0XXXXXXXX | HSN:21069099 | Shipping Charges"
    as a fee -- a real product that merely had a charge glued onto it by the extractor.
    """
    stripped = line.strip()
    if len(stripped) > 60 or _SKU_TAIL.search(stripped):
        return False
    return any(w in stripped.lower() for w in _FEE_WORDS)


def _split_description(raw: str) -> tuple[str, list[str]]:
    """Separate the product from the charges the extractor merged onto its row.

    pdfplumber joins visually adjacent rows, so a cell can read

        Vitamin Supplement 120 Tablets ... | B0XXXXXXXX | HSN:21069099
        Shipping Charges

    with TWO amounts in the total column. The trailing charge lines are their own logical
    rows, and peeling them off the end gives each extra amount a real label instead of a
    manufactured one.
    """
    lines = [ln for ln in (l.strip() for l in raw.split("\n")) if ln]
    fees: list[str] = []
    while lines and _is_fee_label(lines[-1]):
        fees.insert(0, lines.pop())
    return ("\n".join(lines) if lines else raw.strip()), fees


def _is_fee(description: str) -> bool:
    """A whole line-item row that is a charge rather than merchandise.

    Amazon numbers "Cash/Pay on Delivery fee" and "Marketplace Fees" exactly like products,
    so they arrive as ordinary rows. They are real money and belong in the invoice total, but
    they are not things you bought and must never reach the product catalogue.
    """
    first = description.split("\n")[0]
    return _is_fee_label(first) or (
        _SKU_TAIL.search(description) is None
        and any(w in description.lower() for w in _FEE_WORDS)
    )


def parse(doc: Document) -> OrderRecord:
    """Turn an extracted Amazon document into one OrderRecord, or raise ParseError."""
    full_text = "\n".join(p.text for p in doc.pages)

    if _CREDIT_NOTE.search(full_text):
        raise ParseError(
            "credit_note",
            "this is a Credit Note (a refund), not a purchase invoice — refunds are unsupported",
        )

    if not _INVOICE_NUMBER.search(full_text):
        # A real order history can contain one of these. A Delivery Challan moves goods without
        # charging for them; landing it as an invoice would invent an order.
        if "delivery challan" in full_text.lower():
            raise ParseError("not_an_invoice", "this is a Delivery Challan, not a tax invoice")
        raise ParseError("no_invoice_number", "no Invoice Number anywhere in the document")

    order = _ORDER_NUMBER.search(full_text)
    if not order:
        # Quarantine, not a composite fallback key: a fallback that is
        # wrong duplicates money silently, and a quarantined artifact costs one manual action.
        raise ParseError("no_order_number", "no Order Number — refusing to invent a key")

    order_date = _ORDER_DATE.search(full_text)
    page_invoice = _invoice_numbers_by_page(doc)

    invoices: dict[str, Invoice] = {}
    warnings: list[str] = []

    for page_index, header_index, table in _line_item_tables(doc):
        invoice_number = page_invoice.get(page_index)
        if invoice_number is None:
            warnings.append(f"page {page_index} has line items but no invoice number")
            continue

        columns = _column_map(table[header_index])
        missing = {"description", "total"} - set(columns)
        if missing:
            raise ParseError(
                "unknown_columns",
                f"line-item table on page {page_index} lacks {sorted(missing)}",
            )

        def cell(row: list[str], key: str) -> str | None:
            index = columns.get(key)
            return row[index] if index is not None and index < len(row) else None

        invoice = invoices.setdefault(
            invoice_number,
            Invoice(invoice_number=invoice_number, seller_name=None, invoice_date=None, total_paise=0),
        )

        for row in table[header_index + 1:]:
            first = _norm(row[0])
            if first.upper().startswith("TOTAL"):
                # Last non-empty value: on a merged row the grand total sits at the bottom.
                values = [to_paise(v) for v in (cell(row, "total") or "").split("\n")]
                stated = next((v for v in reversed(values) if v is not None), None)
                if stated is not None:
                    invoice.total_paise += stated
                continue
            if not first.isdigit():
                continue  # "Amount in Words", the signatory block, anything after the total

            description, trailing_fees = _split_description(cell(row, "description") or "")
            description, sku, hsn = _parse_description(description)
            if description == "":
                continue

            # ONE TABLE ROW CAN BE SEVERAL LOGICAL LINES. pdfplumber merges visually adjacent
            # rows, so the Total column arrives as "\u20b91,412.43\n\u20b910.00" -- a book and a
            # \u20b910 charge, which the invoice totals as \u20b91,422.43. Reading such a cell as one
            # number yields nothing at all, which is what quarantined dozens of files.
            #
            # The Total column is the reliable splitter. The tax columns are NOT: they carry
            # one entry per tax component (CGST, SGST, IGST, None), so a two-item row can show
            # four or six of them, and zipping by position would scramble the money.
            amounts = [a for a in (to_paise(v) for v in (cell(row, "total") or "").split("\n")) if a is not None]
            if not amounts:
                raise ParseError(
                    "unreadable_amount",
                    f"line {first} of invoice {invoice_number} has no total amount",
                )

            qty_text = _norm((cell(row, "qty") or "1").split("\n")[0])
            for index, amount in enumerate(amounts):
                if index == 0:
                    line_desc, line_kind, line_sku = description, ("fee" if _is_fee(description) else "goods"), sku
                else:
                    # An extra amount on the same visual row. Where the extractor also gave us
                    # the charge's own label ("Shipping Charges") use it; otherwise say plainly
                    # that it is an unlabelled charge. Either way it is a fee and never a
                    # product -- inventing a product name would put a thing you never bought
                    # into the catalogue.
                    label = trailing_fees[index - 1] if index - 1 < len(trailing_fees) else None
                    line_desc = label or f"charge on: {description.splitlines()[0][:80]}"
                    line_kind, line_sku = "fee", None
                invoice.lines.append(
                    LineItem(
                        kind=line_kind,
                        invoice_number=invoice_number,
                        description=line_desc,
                        sku=None if line_kind == "fee" else line_sku,
                        hsn=hsn if index == 0 else None,
                        qty=int(qty_text) if (qty_text.isdigit() and index == 0) else 1,
                        amount_paise=amount,
                        unit_paise=to_paise((cell(row, "unit_price") or "").split("\n")[index])
                        if index < len((cell(row, "unit_price") or "").split("\n")) else None,
                        net_paise=to_paise((cell(row, "net") or "").split("\n")[index])
                        if index < len((cell(row, "net") or "").split("\n")) else None,
                        tax_paise=None,
                        discount_paise=to_paise((cell(row, "discount") or "").split("\n")[index])
                        if index < len((cell(row, "discount") or "").split("\n")) else None,
                    )
                )
            if len(amounts) > 1:
                warnings.append(
                    f"invoice {invoice_number} line {first}: one table row held "
                    f"{len(amounts)} amounts"
                )

    if not invoices:
        raise ParseError("no_line_items", "no line-item table found in the document")

    # Seller and invoice date, per invoice, from the page each one occupies.
    for page in doc.pages:
        number = page_invoice.get(page.index)
        if number is None or number not in invoices:
            continue
        invoice = invoices[number]
        if invoice.seller_name is None:
            seller = _SELLER.search(page.text)
            if seller:
                invoice.seller_name = " ".join(seller.group(1).split())[:200]
        if invoice.invoice_date is None:
            date = _INVOICE_DATE.search(page.text)
            if date:
                invoice.invoice_date = date.group(1)

    ordered = [invoices[k] for k in sorted(invoices)]
    record = OrderRecord(
        source_type=SOURCE,
        external_ref=order.group(1),
        order_date=order_date.group(1) if order_date else None,
        total_paise=sum(inv.total_paise for inv in ordered),
        invoices=ordered,
        payment=[{"mode": m.strip()} for m in _PAYMENT_MODE.findall(full_text)],
        warnings=warnings,
    )
    return record
