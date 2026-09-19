"""PDF bytes on stdin, MARKDOWN in a JSON envelope on stdout — the model path's extractor.

    ingest/.venv/Scripts/python.exe -m ingest.receipts.to_markdown < invoice.pdf

Same seam and the same contract as `cli.py`, deliberately: stdout is always exactly one JSON
object, exit 0 means we answered, exit 1 means we did not. A caller that already knows how to
talk to one of these knows how to talk to both.

WHY A SECOND EXTRACTOR AT ALL, when `extract.py` exists.

They answer different questions. `extract.py` gives pdfplumber's page text and table cells,
which is what a deterministic parser needs — it addresses cells by position and reads a column
it already knows the shape of. A MODEL needs the opposite: prose it can read in one pass, with
the table structure preserved as text rather than as coordinates. Markdown is that, and docling
produces it from layout analysis rather than from geometry guesses.

Docling also reads a SCAN. `extract.py` refuses a document with no text layer, correctly, since
pdfplumber would return empty strings and a parser would confidently produce nothing. Docling
runs OCR, so the model path reaches documents the deterministic path never could.

THE COST, stated plainly because it will surprise somebody: docling downloads layout and OCR
models on first use — hundreds of megabytes. That is why `models_missing` is a first-class
answer here rather than an exception: one missing install must not look like a broken document,
and it must not be retried three times per file across a hundred files.
"""

from __future__ import annotations

import json
import sys
import traceback

#: Hard ceiling on pages, checked BEFORE conversion so a declared-huge document costs nothing.
#: An invoice is one to three pages; twenty means this is a different kind of document and the
#: model would be asked to read a statement as a receipt. Lower than extract.py's 200 on
#: purpose — that limit protects the process, this one protects the ANSWER.
MAX_PAGES = 20

#: Refuse markdown larger than this. the design: the budget is 24,000
#: characters, and returning more only to have TypeScript reject it wastes the conversion.
#: Checked here so the caller never has to hold a document it cannot use.
MAX_MARKDOWN_CHARS = 24_000


def _answer(payload: dict) -> int:
    """One JSON object on stdout, and nothing else. Never a log line, never a warning."""
    json.dump(payload, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    return 0


def _page_count(data: bytes) -> int | None:
    """Pages, without decoding the document. None when it cannot be determined cheaply.

    Uses pdfplumber, which is already a dependency and already opens the file lazily — so the
    page-count guard costs nothing even when docling would take thirty seconds. Checking the
    limit BEFORE the expensive step is the same discipline extract.py already follows.
    """
    try:
        import io

        import pdfplumber

        with pdfplumber.open(io.BytesIO(data)) as pdf:
            return len(pdf.pages)
    except Exception:  # noqa: BLE001 — a count we could not take is not a failure to report
        return None


def main() -> int:
    # cp1252 cannot encode a rupee sign, and this runs in a subprocess with no console, so
    # printing one would kill the process with no JSON at all. Fixed here rather than asked of
    # the caller — see the same note in cli.py.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    data = sys.stdin.buffer.read()
    if not data:
        return _answer({"ok": False, "kind": "empty", "error": "no bytes on stdin"})

    pages = _page_count(data)
    if pages is not None and pages > MAX_PAGES:
        return _answer({
            "ok": False,
            "kind": "too_many_pages",
            "error": f"{pages} pages exceeds the {MAX_PAGES}-page limit for the model path",
        })

    # IMPORTED LATE, AND THE FAILURE IS NAMED. A module-level import would make this script
    # unrunnable without a gigabyte of models installed — including for the page-limit check
    # above, which needs none of it. ImportError here is a SETUP problem with a setup fix, and
    # saying so is what stops it being retried once per document.
    try:
        from docling.document_converter import DocumentConverter
    except ImportError as exc:
        return _answer({
            "ok": False,
            "kind": "models_missing",
            "error": f"docling is not installed in this environment ({exc})",
        })

    try:
        import io

        converter = DocumentConverter()
        # `from_stream`-style input: the bytes never touch the filesystem. A temp file would
        # survive a rolled-back dry run, which is the same argument that put artifact bytes in
        # a BYTEA column rather than on disk.
        from docling.datamodel.base_models import DocumentStream

        result = converter.convert(
            DocumentStream(name="invoice.pdf", stream=io.BytesIO(data))
        )
        markdown = result.document.export_to_markdown()
    except Exception as exc:  # noqa: BLE001
        # A model download failing mid-way lands here and reads as a conversion error. Named
        # separately from `models_missing` because the fixes differ: one is "install it", the
        # other is "this document broke the converter".
        traceback.print_exc(file=sys.stderr)
        name = type(exc).__name__
        return _answer({
            "ok": False,
            "kind": "extract_crashed",
            "error": f"docling could not convert this document ({name}: {exc})"[:500],
        })

    text = (markdown or "").strip()
    if not text:
        # Converted successfully and said nothing. A blank scan, or a document that is pure
        # imagery. Distinct from a crash: the converter worked and the DOCUMENT is empty.
        return _answer({
            "ok": False,
            "kind": "corrupt",
            "error": "the document converted to no text at all",
        })

    if len(text) > MAX_MARKDOWN_CHARS:
        # NEVER TRUNCATE. the design: a truncated invoice silently loses
        # line items, and a lost line item is money in the wrong category. Refusing keeps the
        # failure loud, and the bytes survive in the artifact store for a later splitter.
        return _answer({
            "ok": False,
            "kind": "too_large",
            "error": (
                f"{len(text)} characters of markdown exceeds the {MAX_MARKDOWN_CHARS} budget; "
                "splitting on invoice boundaries is not built yet"
            ),
        })

    return _answer({"ok": True, "markdown": text, "chars": len(text), "pages": pages})


if __name__ == "__main__":
    raise SystemExit(main())
