#!/usr/bin/env python3
"""External-link presentation gate (w10-03, revised, then superseded).

Original house decision (w10-03): every external link opens same-tab, per the NYC Web Content
Style Guide (B18 "same tab/window").

Revision (2026-07): a user report ("View in City Record" and "Bid on
PASSPort" navigate away from the app, losing in-progress bid-response state) surfaced that
strict same-tab conformance has a real cost. A first fix carved out three government
bid/payment systems. A second report (the Staffing tab's salary-band
attribution linking to NYC Open Data) extended the same carve-out to a fourth host.

Revision (2026-07): the product owner broadened the ruling from a named
allowlist to a blanket rule — the lost-search-state cost applies to EVERY external site, not
just government data/bid/payment systems, so the carve-out became the default. This
DELIBERATELY SUPERSEDES the w10-03/B18 same-tab default for external destinations: every
absolute link to a host CROL-List doesn't own now opens in a new tab, with the accessible
`<span class="sr-only">` marking (below) serving as the WCAG-consistent mitigation for the
tab-change B18 was written to prevent. Only CROL-List's own resources — crol-list.org,
api.crol-list.org, in-app hash routes (`#notice/...`, relative page links), and the project's
own GitHub repo — stay same-tab; the B19 "no external-link icons" rule is untouched by this
revision and still applies.

A link must, to pass this gate:
  1. resolve to an OWN destination (`classify()` below) — in which case it must NOT carry
     target="_blank" (own navigation always replaces the current tab); or
  2. resolve to an EXTERNAL destination — in which case it MUST carry target="_blank",
     rel="noopener noreferrer" (tab-nabbing/referrer hygiene), and an accessible new-tab
     marking (a `<span class="sr-only">` child, or index.html's `${extSR()}` shorthand) so a
     screen-reader user is told before activating it that the link leaves the app.
A JS-templated href (`${someExpr}`) whose resolved destination isn't already recorded in
OWN_HREF_EXPRS/EXTERNAL_HREF_EXPRS fails the gate with an "unclassified" message — silently
guessing "own" would let a genuinely external destination slip through untreated, and
silently guessing "external" would break in-app navigation, so an unrecognized pattern is a
hard stop asking a maintainer to classify it once, here.

index.html builds these anchors with two shared JS constants (`EXT_ATTRS` for target+rel,
`extSR()` for the marking span) rather than repeating the literal attributes at each of the
~20 call sites — so `${EXT_ATTRS}`/`${extSR()}` in JS-templated markup are treated as
equivalent to the literal attributes/span they expand to at runtime.

Pure-text lint over the six pages' raw source (covers both static markup and the
JS-templated anchors index.html builds at runtime), PLUS i18n.js and every i18n/lang/<lang>.js
dictionary (crol-extlinks2-y7) — several `*_html` strings bake literal anchor markup that
never appears in any page's own raw source, only in the dictionary value a page injects via
innerHTML at runtime — the six-page-only scan structurally can't see these. No browser needed
for any of it.
"""
import glob
import pathlib
import re
import sys
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).parents[2]
PAGES = ["index.html", "about.html", "data.html", "stats.html", "api.html", "changelog.html"]
I18N_SOURCES = ["i18n.js"] + sorted(
    str(pathlib.Path(p).relative_to(ROOT)) for p in glob.glob(str(ROOT / "i18n/lang/*.js"))
)

# Resolved anchor text allowed to keep an arrow — internal navigation, not an external link.
# B19 ("no external-link icons") is untouched by crol-extlinks2-y8 — it governs link TEXT,
# not new-tab behavior, so it still applies to every external link regardless of target.
ALLOWED_ICON_TEXT = {"View on CROL-List", "Ver en CROL-List"}

# Hosts CROL-List itself serves from — these, and only these, stay same-tab.
OWN_HOSTS = {"crol-list.org", "api.crol-list.org", "www.crol-list.org"}
# The project's own GitHub repo counts as "own" too (crol-extlinks2-y8 product ruling) — a
# governance-file link isn't the kind of mid-task research round-trip this rule targets.
OWN_HREF_PREFIXES = ("https://github.com/jimdc/crol-list",)

# JS-templated (`${...}`) hrefs known to resolve to CROL-List's own domain / an in-app hash
# route / a non-navigating scheme (tel:, mailto:) — audited against every call site as of
# crol-extlinks2-y8. Keep in sync with index.html/api.html when a new one is added.
OWN_HREF_EXPRS = (
    "${href}",             # pivotA(href, text) — always called with an in-app hash route
    "${agencyHref(",       # in-app hash route (#agency/...)
    "${url}",              # investigation share link — location.origin + ... (same origin)
    "${u.atom}", "${u.json}", "${u.ics}",  # feed links — always api.crol-list.org
    "${API.replace(",       # per-agency/vendor RSS feed links — always api.crol-list.org
    "${esc(v.entity)}",    # api.html entity link — always crol-list.org (worker/src/batch.mjs)
    "${tel}",               # tel: scheme, not a page navigation
    "${mailtoFor(",         # mailto: scheme, not a page navigation
)
# JS-templated hrefs known to resolve to an external host — must carry ${EXT_ATTRS}/${extSR()}.
EXTERNAL_HREF_EXPRS = (
    "${REQ_URL(",   # City Record
    "${PASSPORT}",  # PASSPort
)

A_TAG_RE = re.compile(r"<a\b([^>]*)>(.*?)</a>", re.DOTALL)
HREF_RE = re.compile(r'href\s*=\s*"([^"]*)"')
WANTS_NEW_TAB_RE = re.compile(r'target\s*=\s*"_blank"|\$\{EXT_ATTRS\}')
REL_OK_RE = re.compile(r'rel\s*=\s*"noopener noreferrer"|\$\{EXT_ATTRS\}')
SR_MARK_RE = re.compile(r'<span class="sr-only">|\$\{extSR\(\)\}')
TAG_RE = re.compile(r"<[^<>]*>")


def classify(href):
    """Return "own", "external", or None (an unrecognized JS-templated href)."""
    if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
        return "own"  # not a real cross-origin page navigation
    if href.startswith("${"):
        if any(href.startswith(p) for p in EXTERNAL_HREF_EXPRS):
            return "external"
        if any(href.startswith(p) for p in OWN_HREF_EXPRS):
            return "own"
        return None
    if not href.startswith("http"):
        return "own"  # a relative page link (index.html, about.html#data, ...)
    if href.startswith(OWN_HREF_PREFIXES):
        return "own"
    return "own" if urlparse(href).netloc in OWN_HOSTS else "external"


def scan(src, label, failures, check_icons):
    for m in A_TAG_RE.finditer(src):
        attrs, inner = m.group(1), m.group(2)
        full_tag = m.group(0)
        text = re.sub(r"\s+", " ", TAG_RE.sub(" ", inner)).strip()

        if check_icons and "↗" in text and text not in ALLOWED_ICON_TEXT:
            failures.append(f"{label}: external-link icon (↗) in link text {text!r} — "
                             "we do not use external link icons (B19); the link text "
                             "should describe the destination instead")

        href_m = HREF_RE.search(attrs)
        href = href_m.group(1) if href_m else ""
        has_new_tab = bool(WANTS_NEW_TAB_RE.search(attrs))
        kind = classify(href)

        if kind is None:
            failures.append(f"{label}: unclassified JS-templated href {href!r} — add it to "
                             "OWN_HREF_EXPRS or EXTERNAL_HREF_EXPRS in link_targets.py so "
                             "this gate can verify its new-tab treatment")
            continue

        if kind == "own":
            if has_new_tab:
                failures.append(f"{label}: own/in-app href {href!r} carries target=\"_blank\" "
                                 "— own navigation must keep replacing the current tab "
                                 "(crol-extlinks2-y8)")
            continue

        # kind == "external": must open in a new tab with rel + accessible marking.
        if not has_new_tab:
            failures.append(f"{label}: external href {href!r} is missing target=\"_blank\" "
                             "— every external destination now opens in a new tab "
                             "(crol-extlinks2-y8 supersedes the w10-03 same-tab default)")
            continue

        if not REL_OK_RE.search(attrs):
            failures.append(f"{label}: new-tab link to {href!r} is missing "
                             'rel="noopener noreferrer"')

        if not SR_MARK_RE.search(full_tag):
            failures.append(f"{label}: new-tab link to {href!r} has no accessible "
                             "new-tab marking (a <span class=\"sr-only\"> child, or "
                             "extSR() in index.html's JS-templated markup)")


def main():
    failures = []
    for page in PAGES:
        src = (ROOT / page).read_text(encoding="utf-8")
        scan(src, page, failures, check_icons=True)

    for i18n_src in I18N_SOURCES:
        # JS string literals escape embedded double quotes (`\"`) — unescape before running
        # the same anchor-tag regexes used on raw HTML source. Icon check is skipped here:
        # ALLOWED_ICON_TEXT is only curated for en/es, and every shipping language's own
        # translation of view_on_crol legitimately keeps the ↗ (see the comment on
        # ALLOWED_ICON_TEXT above) — that's a translation-completeness concern for the i18n
        # guards, not this gate.
        src = (ROOT / i18n_src).read_text(encoding="utf-8").replace('\\"', '"')
        scan(src, i18n_src, failures, check_icons=False)

    if failures:
        print("link-targets gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print(f"link-targets gate OK — every external href opens in a new tab (rel="
          f"noopener-noreferrer + accessible marking), every own/in-app href stays same-tab, "
          f"0 unallowlisted external-link icons across {len(PAGES)} page(s) + "
          f"{len(I18N_SOURCES)} i18n source(s)")


if __name__ == "__main__":
    main()
