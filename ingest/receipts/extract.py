"""EXTRACTION: bytes -> a structural view of the document. No merchant knowledge at all.

This module sits on one side of a deliberate line: extraction turns bytes into a
rectangular-ish structure and depends ONLY on the file type; interpretation turns that
structure into records and is what varies per merchant. Keeping them apart is what lets a new
merchant be one small module instead of a new PDF pipeline.

So nothing here knows what Blinkit or Amazon is. It answers one question -- "what is on these
pages" -- and hands the answer to a parser.
"""

from __future__ import annotations

import io
import json
from dataclasses import asdict, dataclass, field
from typing import Any

import pdfplumber

# A PDF that declares thousands of pages is a cheap way to make a parser run forever -- the
# same shape as a zip bomb. An invoice is single digits of pages; a bank statement is tens.
# 200 is far above anything legitimate here and far below anything that hurts.
MAX_PAGES = 200


class ExtractionError(Exception):
    """The document cannot be read at all. Never a partial or guessed result.

    `kind` is a CLOSED vocabulary so the caller can act on the reason rather than parse the
    message. The four are genuinely different situations:

      not_pdf     these bytes are not a PDF          -> the sniffer disagreed; a bug or a lie
      encrypted   password-protected                 -> a person must supply it; retrying never helps
      malformed   truncated or corrupt structure     -> re-download and try again
      too_large   more pages than we will process    -> a resource guard, not a data problem
      no_text     no text layer at all               -> a SCAN; needs OCR, a different pipeline

    Collapsing these into one "could not parse" is what makes a support question unanswerable.
    """

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


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


#: A PDF is REQUIRED to begin with this. Checked here as well as in the TypeScript sniffer,
#: because this module is also a CLI anyone can pipe anything into, and a component that only
#: works when its caller behaves is not a boundary.
PDF_MAGIC = b"%PDF-"


def _classify_open_error(exc: Exception) -> ExtractionError:
    """Turn whatever pdfminer threw into one of our closed reasons.

    pdfminer signals encryption through several unrelated exception types depending on the
    flavour, and its own class names are the most reliable signal available -- there is no
    common base class to catch. Matching on the name is ugly and honest; matching on the
    message text would be worse.
    """
    name = type(exc).__name__
    if "Password" in name or "Encrypt" in name or "password" in str(exc).lower():
        return ExtractionError(
            "encrypted",
            "this PDF is password-protected -- extraction cannot proceed without it",
        )
    return ExtractionError("malformed", f"cannot read this PDF: {type(exc).__name__}: {exc}")


def extract_document(source: str | bytes) -> Document:
    """Read a PDF into a Document, or raise ExtractionError.

    Accepts a path OR the bytes themselves, because the CLI receives the document on stdin —
    the API already holds it in memory as an artifact, and a temp file would be one more thing
    to clean up on a path where the process may be killed by a timeout.

    Deliberately strict. Every failure here is a QUARANTINE, never a partial record: a document
    we half-read is a basket with items missing, and the reconcile gate exists precisely
    because a plausible-looking wrong answer is the expensive kind.
    """
    if isinstance(source, bytes):
        if not source.startswith(PDF_MAGIC):
            raise ExtractionError("not_pdf", "these bytes do not begin with %PDF-")
        handle: Any = io.BytesIO(source)
    else:
        handle = source

    try:
        pdf = pdfplumber.open(handle)
    except Exception as exc:  # pdfminer has no common base class for these
        raise _classify_open_error(exc) from exc

    with pdf:
        if len(pdf.pages) > MAX_PAGES:
            # Checked BEFORE iterating. A small file can declare an enormous page count -- the
            # PDF equivalent of a zip bomb -- and discovering that mid-loop means we already
            # paid for it.
            raise ExtractionError(
                "too_large", f"{len(pdf.pages)} pages exceeds the {MAX_PAGES}-page limit"
            )

        pages: list[Page] = []
        try:
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
        except Exception as exc:
            # A file that opens and then fails halfway is corrupt, and the pages we did get are
            # worth nothing: an invoice missing its second seller is not a smaller invoice, it
            # is a WRONG one, because one order is split across several invoices.
            raise ExtractionError(
                "malformed", f"failed on page {len(pages)}: {type(exc).__name__}: {exc}"
            ) from exc

    char_count = sum(len(p.text) for p in pages)
    if char_count == 0:
        # An image-only PDF. Saying so is the whole value: the alternative is an "empty
        # invoice" that reconciles to zero and looks like a real order for nothing.
        raise ExtractionError(
            "no_text",
            "no text layer -- this looks like a scan, which needs OCR rather than extraction",
        )

    return Document(page_count=len(pages), char_count=char_count, pages=pages)
