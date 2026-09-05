"""Generate committed, scrubbed parser fixtures from real invoices.

    ingest/.venv/Scripts/python.exe -m ingest.receipts.make_fixtures \
        --out src/fixtures/receipts \
        --forbid "<your name>,<your street>,<your pin>" \
        data/private/*.pdf

Run from the repo root. Real PDFs live in gitignored `data/`; the JSON this writes is what
gets committed and what parser tests read, so a test never touches private data and the suite
stays pure.

It REFUSES to write a fixture that still contains a forbidden string. A redaction rule that
quietly stops matching is invisible -- the file still looks redacted, and the leak sits in the
part nobody re-reads. So the check runs every time, and a failure is an error rather than a
warning.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

from .extract import ExtractionError, extract_document
from .redact import redact_document, verify_clean


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pdfs", nargs="+")
    ap.add_argument("--out", required=True, help="directory for the JSON fixtures")
    ap.add_argument(
        "--name",
        required=True,
        help="fixture basename, e.g. 'blinkit' -> blinkit-01.json. Given by a HUMAN because "
             "extraction deliberately knows nothing about merchants, and "
             "because the ORIGINAL filename carries a real order number.",
    )
    ap.add_argument(
        "--forbid",
        default="",
        help="comma-separated strings that must NOT survive redaction (your name, street, pin)",
    )
    args = ap.parse_args(argv)

    forbidden = [s.strip() for s in args.forbid.split(",") if s.strip()]
    if not forbidden:
        print("refusing to run with no --forbid list: the check is the point", file=sys.stderr)
        return 2

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    failures = 0
    written = 0
    for raw in args.pdfs:
        path = Path(raw)
        try:
            doc = extract_document(str(path))
        except ExtractionError as exc:
            print(f"  SKIP  {path.name}: {exc}", file=sys.stderr)
            failures += 1
            continue

        clean = redact_document(doc, forbidden)
        leaks = verify_clean(clean, forbidden)
        if leaks:
            # Deliberately does NOT print the leaked value -- this output can end up in a log.
            print(
                f"  LEAK  {path.name}: {len(leaks)} forbidden string(s) survived redaction; "
                "fixture NOT written",
                file=sys.stderr,
            )
            failures += 1
            continue

        # Named by the merchant and a sequence, NEVER by the original filename -- which
        # carries a real order number and would put it in a committed path.
        written += 1
        target = out_dir / f"{args.name}-{written:02d}.json"
        target.write_text(
            json.dumps(asdict(clean), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        tables = sum(len(p.tables) for p in clean.pages)
        print(f"  ok    {target.name}  pages={clean.page_count} tables={tables}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
