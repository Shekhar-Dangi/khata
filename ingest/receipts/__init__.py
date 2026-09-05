"""Receipt ingestion: extraction (format-specific) and parsers (merchant-specific).

The line this package draws: extraction depends only on the FILE TYPE, interpretation
only on the MERCHANT. Keeping them apart is what makes a new merchant one small module.
"""
