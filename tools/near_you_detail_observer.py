"""Shared Near You capture observations for named rows and no-JavaScript links.

Detail capture packets previously hard-coded ``named_row_present`` and
``no_javascript_title_link``. Those constants could never fail, so a reader
could take them as checks. This module derives both fields from the served
document: named-row presence from list/detail DOM markup, and the no-JavaScript
link from a real title-link or Official source anchor in the no-script HTML.
"""

from __future__ import annotations

import re
import urllib.request

NEAR_RECORD_TITLE_LINK_CLASS = "near-record-title-link"
NEAR_RECORD_CLASS_RE = re.compile(r'class="[^"]*\bnear-record\b[^"]*"')
DATA_RECORD_ID_RE = re.compile(r'data-record-id="([^"]+)"')
TITLE_LINK_WITH_HREF_RE = re.compile(
    r"<a\b(?=[^>]*\bclass=\"[^\"]*\bnear-record-title-link\b)(?=[^>]*\bhref=\"[^\"]+\")[^>]*>",
    re.I,
)
TITLE_LINK_HREF_FIRST_RE = re.compile(
    r"<a\b(?=[^>]*\bhref=\"[^\"]+\")(?=[^>]*\bclass=\"[^\"]*\bnear-record-title-link\b)[^>]*>",
    re.I,
)
OFFICIAL_SOURCE_LINK_RE = re.compile(
    r"<a\b(?=[^>]*\bhref=\"https?://[^\"]+\")[^>]*>\s*Official source\s*</a>",
    re.I,
)


def observe_named_row_present(
    html: str,
    *,
    record_id_needle: str,
    title_needle: str,
) -> bool:
    """Return whether the rendered DOM includes a Near You named record row.

    Requires list-row markup (``near-record``, ``near-record-title-link``, or a
    matching ``data-record-id``) plus the record and title needles. A meeting
    detail page that only renders the hero therefore reports False as an honest
    named-row complement.
    """
    if not html or not record_id_needle or not title_needle:
        return False
    if record_id_needle not in html or title_needle not in html:
        return False
    record_ids = DATA_RECORD_ID_RE.findall(html)
    has_row = (
        NEAR_RECORD_TITLE_LINK_CLASS in html
        or bool(NEAR_RECORD_CLASS_RE.search(html))
        or any(record_id_needle in value for value in record_ids)
    )
    return bool(has_row)


def observe_no_javascript_title_link(html: str) -> bool:
    """Return whether the document exposes a real href title/source link.

    List surfaces use a ``near-record-title-link`` anchor with ``href``. Detail
    surfaces use an Official source ``<a href>`` in the static document. Either
    must be present in the HTML that a no-JavaScript client receives.
    """
    if not html:
        return False
    if TITLE_LINK_WITH_HREF_RE.search(html) or TITLE_LINK_HREF_FIRST_RE.search(html):
        return True
    if OFFICIAL_SOURCE_LINK_RE.search(html):
        return True
    return False


def fetch_document_html(
    url: str,
    *,
    user_agent: str = "cityscroll-detail-observer/1",
    timeout: float = 60.0,
) -> str:
    """Fetch the raw served HTML document (the no-script document body)."""
    req = urllib.request.Request(url, headers={"User-Agent": user_agent})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def observe_detail_packet_fields(
    html: str,
    *,
    record_id_needle: str,
    title_needle: str,
    no_js_html: str | None = None,
) -> dict[str, bool]:
    """Observe the two detail-packet fields that must not be constants."""
    document = html if no_js_html is None else no_js_html
    return {
        "named_row_present": observe_named_row_present(
            html,
            record_id_needle=record_id_needle,
            title_needle=title_needle,
        ),
        "no_javascript_title_link": observe_no_javascript_title_link(document),
    }
