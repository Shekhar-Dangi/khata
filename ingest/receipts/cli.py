"""The Python half of the seam: PDF bytes on stdin, normalized JSON on stdout.

    ingest/.venv/Scripts/python.exe -m ingest.receipts.cli < invoice.pdf

the design fixes this boundary: **Python extracts, TypeScript owns dedupe, matching,
allocation and persistence.** All the money invariants stay on one side of the wire, in the
language with the tests and the database constraints. This process therefore knows nothing
about the ledger and writes nothing anywhere; it is a pure function with a pipe for a calling
convention.

CONTRACT WITH THE CALLER — deliberately narrow, because the caller kills this process on a
timer and must be able to tell a bad document from a broken extractor:

  stdout   ALWAYS one JSON object, and nothing else. Never a log line, never a warning.
  exit 0   we answered. `ok` says whether the document could be read.
  exit 1   we did not answer; something unexpected broke. `stderr` has the detail.

An unreadable PDF is exit 0 with `ok: false`, NOT a non-zero exit. The extractor did its job;
the document is the problem. Conflating the two means "your file is a scan" and "the Python
environment is broken" look identical to the thing that has to decide what to tell a person.
"""

from __future__ import annotations

import json
import sys
import traceback
from dataclasses import asdict

from .extract import ExtractionError, extract_document


def main() -> int:
    # Force UTF-8 on both streams rather than trusting PYTHONIOENCODING.
    #
    # The Amazon template contains a rupee sign, and Windows' default console encoding is
    # cp1252, which cannot encode it: printing raises UnicodeEncodeError and the process dies
    # with no JSON at all. Relying on the caller to set an environment variable makes this
    # module correct only when invoked correctly — and it is invoked from a subprocess with no
    # console, where that is easy to get wrong. Fixing it HERE makes the trap unreachable.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    # `.buffer` is the raw byte stream. Reading `sys.stdin` directly would decode the PDF as
    # text and destroy it — the same U+FFFD corruption express.text() caused on the other side
    # of the wire, for exactly the same reason.
    data = sys.stdin.buffer.read()

    if not data:
        json.dump({"ok": False, "kind": "empty", "error": "no bytes on stdin"}, sys.stdout)
        return 0

    try:
        doc = extract_document(data)
    except ExtractionError as exc:
        # A DOCUMENT problem, and a complete answer. `kind` is the closed vocabulary from
        # extract.py, so the caller branches on a value rather than on message text.
        json.dump({"ok": False, "kind": exc.kind, "error": str(exc)}, sys.stdout)
        return 0
    except Exception:  # noqa: BLE001 — an EXTRACTOR problem, and a different exit code
        traceback.print_exc(file=sys.stderr)
        json.dump({"ok": False, "kind": "internal", "error": "extractor failed"}, sys.stdout)
        return 1

    json.dump(
        {"ok": True, "document": asdict(doc)},
        sys.stdout,
        ensure_ascii=False,
        # No indent. This goes down a pipe to a program, not to a person, and pretty-printing
        # a large document is pure bytes on the wire.
        separators=(",", ":"),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
