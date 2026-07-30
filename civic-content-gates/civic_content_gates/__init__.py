"""Civic content gates — reusable NYC Web Content Style Guide CI suite.

Import individual gates, or run the whole suite:

    python -m civic_content_gates --root path/to/site
    civic-content-gates --root path/to/site  # after pip install -e .

Default suite members match the style-guide gates this repository already runs
in CI. Extraction keeps each gate's verdict logic unchanged.
"""

__version__ = "0.1.0"

SUITE_MEMBERS = (
    "link_text",
    "i18n_keys",
    "nyc_copy_lint",
    "heading_punctuation",
    "page_metadata",
    "genai_disclosure",
    "reading_level",
)
