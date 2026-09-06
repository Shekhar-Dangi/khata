"""Which parser handles this document, by CONTENT.

Detection is by content sniffing, never by filename: filenames are user-controlled and
meaningless, and a file renamed on the way out of a phone would silently pick the wrong
parser.

A LIST, deliberately not a plugin system. Adding Blinkit is one import and one entry; anything
more elaborate would be framework built for a second case that has not arrived.
"""

from __future__ import annotations

from . import amazon
from .extract import Document
from .shapes import OrderRecord

PARSERS = [amazon]


def find_parser(text: str):
    """The single parser that recognises this text, or None.

    TWO matches returns None rather than the first. Ambiguity means the markers are wrong or a
    document quotes another merchant, and quietly picking one sends a basket to a parser that
    will misread it.
    """
    hits = [p for p in PARSERS if p.detect(text)]
    return hits[0] if len(hits) == 1 else None


def parse_document(doc: Document) -> OrderRecord | None:
    parser = find_parser("\n".join(p.text for p in doc.pages))
    return None if parser is None else parser.parse(doc)
