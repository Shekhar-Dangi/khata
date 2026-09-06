"""Parser tests, run against the committed scrubbed fixtures.

    ingest/.venv/Scripts/python.exe -m unittest discover -s ingest/receipts -t .

unittest rather than pytest, because pytest is not a dependency of this project and a test
suite is not worth one. The fixtures are real invoice STRUCTURE with the identity replaced
(ingest/receipts/make_fixtures.py), so these exercise what the corpus actually prints without
this public-bound repo holding a name or an address.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from .amazon import detect, parse
from .extract import Document, Page
from .shapes import ParseError, reconcile, to_paise

FIXTURES = Path(__file__).resolve().parents[2] / "src" / "fixtures" / "receipts"


def load(name: str) -> Document:
    raw = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
    return Document(
        page_count=raw["page_count"],
        char_count=raw["char_count"],
        pages=[Page(**p) for p in raw["pages"]],
    )


class ToPaise(unittest.TestCase):
    def test_rupee_sign_and_thousands_comma(self):
        self.assertEqual(to_paise("₹1,422.43"), 142243)

    def test_plain(self):
        self.assertEqual(to_paise("38.10"), 3810)

    def test_empty_is_none_not_zero(self):
        # A fee row legitimately has no MRP. Returning 0 would put a real amount into the
        # arithmetic that the invoice never stated.
        self.assertIsNone(to_paise(""))
        self.assertIsNone(to_paise("-"))
        self.assertIsNone(to_paise(None))

    def test_no_float_drift(self):
        # 0.1 + 0.2 in float is not 0.3. Money goes through Decimal precisely so a few hundred
        # line items still sum to the stated total exactly, and the reconcile gate stays honest.
        self.assertEqual(to_paise("0.10") + to_paise("0.20"), to_paise("0.30"))


class Detect(unittest.TestCase):
    def test_recognises_the_fixtures(self):
        for name in ("amazon-01", "amazon-02", "amazon-03"):
            text = "\n".join(p.text for p in load(name).pages)
            self.assertTrue(detect(text), name)

    def test_does_not_claim_a_blinkit_invoice(self):
        text = "\n".join(p.text for p in load("blinkit-01").pages)
        self.assertFalse(detect(text))


class Parse(unittest.TestCase):
    def test_reconciles_every_fixture(self):
        # THE gate: lines must sum to the stated invoice total, and
        # invoice totals to the order total, exactly. No tolerance.
        for name in ("amazon-01", "amazon-02", "amazon-03"):
            record = parse(load(name))
            self.assertEqual(reconcile(record), [], f"{name} did not reconcile")

    def test_reads_the_order_key_not_an_invoice_number(self):
        # One order is N invoices, so external_ref must be the ORDER.
        record = parse(load("amazon-01"))
        self.assertRegex(record.external_ref, r"^\d{3}-\d{7}-\d{7}$")

    def test_line_amounts_are_tax_inclusive(self):
        # Allocating the NET would leave GST as a permanent phantom remainder.
        record = parse(load("amazon-01"))
        for line in record.lines:
            if line.net_paise is not None and line.tax_paise:
                self.assertGreaterEqual(line.amount_paise, line.net_paise)

    def test_captures_a_sku_for_every_goods_line(self):
        record = parse(load("amazon-02"))
        goods = [ln for ln in record.lines if ln.kind == "goods"]
        self.assertTrue(goods)
        for line in goods:
            self.assertIsNotNone(line.sku, line.description[:60])

    def test_splits_a_table_row_that_holds_two_amounts(self):
        # pdfplumber merges visually adjacent rows, so one row's Total cell can read
        # "1,412.43\n10.00" while the invoice totals 1,422.43. amazon-03 is a real instance;
        # reading such a cell as ONE number is what quarantined dozens of files.
        record = parse(load("amazon-03"))
        self.assertEqual(reconcile(record), [])
        self.assertGreater(len(record.lines), 1)

    def test_fees_are_not_products(self):
        # Amazon numbers "Cash/Pay on Delivery fee" exactly like merchandise. Treating it as a
        # product would put something you never bought into the catalogue.
        record = parse(load("amazon-03"))
        for line in record.lines:
            if line.kind == "fee":
                self.assertIsNone(line.sku)


class Refuses(unittest.TestCase):
    def _doc(self, text: str) -> Document:
        return Document(page_count=1, char_count=len(text),
                        pages=[Page(index=0, width=595, height=842, text=text, tables=[])])

    def test_credit_note(self):
        # A real order history holds a fair number of these. A refund landed as an invoice would
        # record a second PURCHASE of something that was sent back.
        text = ("Tax Invoice\nOrder No: 404-0000009-0000001 Credit Note No: TTD1-C-000\n"
                "Original Invoice Number: TTD1-0000\n")
        with self.assertRaises(ParseError) as caught:
            parse(self._doc(text))
        self.assertEqual(caught.exception.kind, "credit_note")

    def test_delivery_challan(self):
        text = "Tax Invoice/Bill of Supply\nDelivery Challan Details : XX-0000-0000\nOrder Date: 07.08.2026\n"
        with self.assertRaises(ParseError) as caught:
            parse(self._doc(text))
        self.assertEqual(caught.exception.kind, "not_an_invoice")

    def test_blank_order_number_is_quarantined_not_invented(self):
        # A real corpus file prints "Order Number:" with no value. Quarantine beats a
        # composite fallback key: a wrong key duplicates money silently.
        text = "Tax Invoice\nOrder Number:\nInvoice Number :POD-00-000000000\nOrder Date:05.11.2025\n"
        with self.assertRaises(ParseError) as caught:
            parse(self._doc(text))
        self.assertEqual(caught.exception.kind, "no_order_number")


if __name__ == "__main__":
    unittest.main()
