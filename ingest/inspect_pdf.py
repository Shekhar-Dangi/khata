"""Quick structural inspection of a PDF, to decide extraction tactics.
Usage: python inspect_pdf.py <path-to-pdf>
Local-only; prints structure + a small text preview.
"""

import sys
from collections import Counter

import pdfplumber

path = sys.argv[1]
with pdfplumber.open(path) as pdf:
    print(f"pages: {len(pdf.pages)}")
    print(f"metadata: {pdf.metadata}")
    for i, page in enumerate(pdf.pages):
        print(f"\n===== PAGE {i} =====")
        print(f"size (pt): {page.width:.0f} x {page.height:.0f}")
        text = page.extract_text() or ""
        print(f"born-digital? chars of text extracted: {len(text)}")
        print(
            f"ruling lines: {len(page.lines)} | rects: {len(page.rects)} | edges: {len(page.edges)}"
        )
        fonts = Counter(c["fontname"] for c in page.chars)
        print(f"fonts: {dict(fonts)}")
        tables = page.extract_tables()
        print(f"extract_tables() found: {len(tables)} table(s)")
        for t_idx, t in enumerate(tables):
            print(f"  table {t_idx}: {len(t)} rows x {len(t[0]) if t else 0} cols")
        print("----- text preview (first 900 chars) -----")
        print(text[:900])
