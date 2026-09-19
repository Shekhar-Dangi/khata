"""Download docling's models ONCE, slowly and stubbornly, so conversion never needs the network.

    ingest/.venv/Scripts/python.exe -m ingest.receipts.fetch_models

WHY THIS EXISTS INSTEAD OF `python -m docling.cli.models download`.

That command fails on this machine, on two different networks, and the log says exactly how.
The TLS handshake to huggingface.co works — the first API call answers 200 — but some requests
are then reset mid-flight (WinError 10054). huggingface_hub downloads a model's files on EIGHT
threads sharing one connection pool, so a reset connection gets handed to another thread, which
reads from a socket that no longer exists (WinError 10038) — and the whole download aborts
instead of retrying the one file. An intermittent network hiccup becomes a hard failure purely
because of the concurrency.

So this does the same download with the two things that make it survive:

  ONE worker    no shared pool for a dead socket to be passed around in
  RETRIES       snapshot_download skips files already on disk, so every attempt RESUMES
                rather than starting over — a flaky connection only has to succeed once per file

It calls docling's own `download_models`, so the files land exactly where docling looks for
them (~/.cache/docling/models) with docling's own repo ids and pinned revisions. Nothing here
decides WHICH models or WHERE; it only changes HOW STUBBORNLY they are fetched.

ONLY WHAT AN INVOICE NEEDS: the layout model, the table-structure model, and RapidOCR for scans.
The code/formula and picture-classifier models are skipped — they are off in the conversion
pipeline anyway, and every extra model is another download that can fail.
"""

from __future__ import annotations

import sys
import time

ATTEMPTS = 10
BACKOFF_SECONDS = 3


def _single_worker() -> None:
    """Force huggingface_hub to fetch one file at a time.

    Patched on the MODULE, not imported by name: docling does `from huggingface_hub import
    snapshot_download` inside the function body at call time, so it reads this attribute then.
    """
    import huggingface_hub

    original = huggingface_hub.snapshot_download

    def one_at_a_time(*args, **kwargs):
        kwargs["max_workers"] = 1
        return original(*args, **kwargs)

    huggingface_hub.snapshot_download = one_at_a_time


def main() -> int:
    _single_worker()
    from docling.utils.model_downloader import download_models

    for attempt in range(1, ATTEMPTS + 1):
        try:
            path = download_models(
                with_layout=True,
                with_tableformer=True,
                with_rapidocr=True,
                with_code_formula=False,
                with_picture_classifier=False,
                progress=True,
            )
        except Exception as exc:  # noqa: BLE001 — every failure here is "try again"
            print(f"\nattempt {attempt}/{ATTEMPTS} failed: {type(exc).__name__}: {exc}"[:300],
                  file=sys.stderr)
            if attempt == ATTEMPTS:
                print("\ngave up. Files fetched so far are kept; re-running resumes.", file=sys.stderr)
                return 1
            time.sleep(BACKOFF_SECONDS * attempt)
            continue
        print(f"\nall models present in {path}")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
