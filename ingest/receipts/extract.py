"""EXTRACTION: bytes -> a structural view of the document. No merchant knowledge at all.

the design draws the line this module sits on: extraction turns bytes into a
rectangular-ish structure and depends ONLY on the file type; interpretation turns that
structure into records and is what varies per merchant. Keeping them apart is what lets a new
merchant be one small module instead of a new PDF pipeline.

So nothing here knows what Blinkit or Amazon is. It answers one question -- "what is on these
pages" -- and hands the answer to a parser.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any

import pdfplumber

# A PDF that declares thousands of pages is a cheap way to make a parser run forever -- the
# same shape as a zip bomb. An invoice is single digits of pages; a bank statement is tens.
# 200 is far above anything legitimate here and far below anything that hurts.
MAX_PAGES = 200


class ExtractionError(Exception):
    """The document cannot be read at all. Never a partial or guessed result."""


@dataclass
class Page:
    index: int
    width: float
    height: float
    #: Linearised text. Good for DETECTING which template this is; bad for reading data out of
    #: it, because columns interleave. See tables for that.
    text: str
    #: Each table as a list of rows, each row a list of cell strings (None -> "").
    #: Cells are multi-line and their lines do NOT correspond row-to-row across cells.
    tables: list[list[list[str]]] = field(default_factory=list)


@dataclass
class Document:
    page_count: int
    #: Characters of text across all pages. ZERO means there is no text layer -- a scan, which
    #: needs OCR and is a different reliability class entirely. Callers must check this rather
    #: than discovering it as an empty parse.
    char_count: int
    pages: list[Page]

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)


def _cells(table: list[list[Any]]) -> list[list[str]]:
    """Normalise a pdfplumber table to plain strings, preserving newlines inside a cell.

    The newlines matter: a Blinkit UPC arrives as "8901\\n7641\\n1227\\n0" and its description
    as three separate lines in the SAME row. Stripping them would destroy the only signal that
    tells a parser which fragments belong together.
    """
    return [[("" if cell is None else str(cell)) for cell in row] for row in table]


def extract_document(path: str) -> Document:
    """Read a PDF into a Document, or raise ExtractionError.

    Deliberately strict. Every failure here is a QUARANTINE, never a partial record: a document
    we half-read is a basket with items missing, and the design exists precisely
    because a plausible-looking wrong answer is the expensive kind.
    """
    try:
        pdf = pdfplumber.open(path)
    except Exception as exc:  # pdfplumber raises several unrelated types, incl. for encryption
        raise ExtractionError(f"cannot open as PDF: {exc}") from exc

    with pdf:
        if len(pdf.pages) > MAX_PAGES:
            raise ExtractionError(f"{len(pdf.pages)} pages exceeds the {MAX_PAGES}-page limit")

        pages: list[Page] = []
        for i, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            pages.append(
                Page(
                    index=i,
                    width=round(float(page.width), 2),
                    height=round(float(page.height), 2),
                    text=text,
                    tables=[_cells(t) for t in page.extract_tables()],
                )
            )

    char_count = sum(len(p.text) for p in pages)
    if char_count == 0:
        # An image-only PDF. Saying so is the whole value: the alternative is an "empty
        # invoice" that reconciles to zero and looks like a real order for nothing.
        raise ExtractionError(
            "no text layer -- this looks like a scan, which needs OCR rather than extraction"
        )

    return Document(page_count=len(pages), char_count=char_count, pages=pages)
