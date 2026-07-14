#!/usr/bin/env python3
"""External-link presentation gate (w10-03, revised crol-extlinks-s9) — NYC Web Content Style
Guide: "Set links to open in the same tab or window" (B18) and "We do not use external link
icons... use text that describes where it goes" (B19).

House decision (w10-03): CONFORM strictly — every `target="_blank"` and every decorative
"external link" arrow icon (↗) was removed.

Revision (crol-extlinks-s9, 2026-07): a user report ("View in City Record" and "Bid on
PASSPort" navigate away from the app, losing in-progress bid-response state) surfaced that
strict same-tab conformance has a real cost for the three government BID/PAYMENT systems a
user round-trips to mid-task: City Record (the notice detail itself), PASSPort (where a
solicitation is actually bid on), and Checkbook NYC (where a contract's payment status is
looked up). Losing CROL-List's search/filter state on every round-trip to one of these was
worse than the B18 same-tab default, so this is a NAMED, NARROW exception — not a reopening
of the general question. Every other external destination (NYC Open Data, ZAP, ZoLa, ACRIS,
Google Maps, Who Owns What, GitHub-adjacent city sites) still opens same-tab per w10-03.

A carve-out link must, to pass this gate:
  1. have an href resolving to one of the three allowlisted systems (ALLOWED_NEW_TAB_HREFS);
  2. carry rel="noopener noreferrer" (tab-nabbing/referrer hygiene for the opened tab);
  3. carry an accessible new-tab marking — a `<span class="sr-only">` child (index.html's
     `extSR()` helper, or the equivalent baked into the about.html/api.html/i18n.js static
     strings) so screen-reader users are told the link leaves the app before they activate it.
Any OTHER target="_blank" (an href outside the allowlist, or missing rel/marking) fails the
gate — the exception is for these three systems specifically, not a general opt-in.

index.html builds these anchors with two shared JS constants (`EXT_ATTRS` for target+rel,
`extSR()` for the marking span) rather than repeating the literal attributes at each of the
~15 call sites — so `${EXT_ATTRS}`/`${extSR()}` in JS-templated markup are treated as
equivalent to the literal attributes/span they expand to at runtime.

Pure-text lint over the six pages' raw source (covers both static markup and the
JS-templated anchors index.html builds at runtime) — no browser needed.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parents[2]
PAGES = ["index.html", "about.html", "data.html", "stats.html", "api.html", "changelog.html"]

# Resolved anchor text allowed to keep an arrow — internal navigation, not an external link.
ALLOWED_ICON_TEXT = {"View on CROL-List", "Ver en CROL-List"}

# href prefixes (or index.html's JS shorthand for them) allowed to carry target="_blank".
# Keep in sync with index.html's REQ_URL/PASSPORT constants and the three literal domains.
ALLOWED_NEW_TAB_HREFS = (
    "https://a856-cityrecord.nyc.gov",   # City Record — REQ_URL(...) in index.html's JS
    "https://a0333-passportpublic.nyc.gov",  # PASSPort — the PASSPORT const in index.html's JS
    "https://www.checkbooknyc.com",      # Checkbook NYC
)
# index.html JS-expression hrefs that resolve to an allowed domain (can't regex the URL
# itself since it's built by a JS template literal, not written out in the page source).
ALLOWED_NEW_TAB_HREF_EXPRS = (
    "${REQ_URL(",
    "${PASSPORT}",
)

A_TAG_RE = re.compile(r"<a\b([^>]*)>(.*?)</a>", re.DOTALL)
HREF_RE = re.compile(r'href\s*=\s*"([^"]*)"')
WANTS_NEW_TAB_RE = re.compile(r'target\s*=\s*"_blank"|\$\{EXT_ATTRS\}')
REL_OK_RE = re.compile(r'rel\s*=\s*"noopener noreferrer"|\$\{EXT_ATTRS\}')
SR_MARK_RE = re.compile(r'<span class="sr-only">|\$\{extSR\(\)\}')
TAG_RE = re.compile(r"<[^<>]*>")


def href_allowed(href):
    if any(href.startswith(p) for p in ALLOWED_NEW_TAB_HREFS):
        return True
    if any(href.startswith(p) for p in ALLOWED_NEW_TAB_HREF_EXPRS):
        return True
    return False


def main():
    failures = []
    for page in PAGES:
        src = (ROOT / page).read_text(encoding="utf-8")

        for m in A_TAG_RE.finditer(src):
            attrs, inner = m.group(1), m.group(2)
            full_tag = m.group(0)
            text = re.sub(r"\s+", " ", TAG_RE.sub(" ", inner)).strip()

            if "↗" in text and text not in ALLOWED_ICON_TEXT:
                failures.append(f"{page}: external-link icon (↗) in link text {text!r} — "
                                 "we do not use external link icons; the link text should "
                                 "describe the destination instead")

            if not WANTS_NEW_TAB_RE.search(attrs):
                continue  # same-tab link — the w10-03 default, nothing more to check

            href_m = HREF_RE.search(attrs)
            href = href_m.group(1) if href_m else ""
            if not href_allowed(href):
                failures.append(f"{page}: target=\"_blank\" on a non-allowlisted href "
                                 f"{href!r} — only City Record/PASSPort/Checkbook NYC links "
                                 "may open in a new tab (crol-extlinks-s9); every other "
                                 "external destination stays same-tab per the w10-03 house "
                                 "decision")
                continue

            if not REL_OK_RE.search(attrs):
                failures.append(f"{page}: new-tab link to {href!r} is missing "
                                 'rel="noopener noreferrer"')

            if not SR_MARK_RE.search(full_tag):
                failures.append(f"{page}: new-tab link to {href!r} has no accessible "
                                 "new-tab marking (a <span class=\"sr-only\"> child, or "
                                 "extSR() in index.html's JS-templated markup)")

    if failures:
        print("link-targets gate FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        sys.exit(1)
    print(f"link-targets gate OK — target=\"_blank\" only on City Record/PASSPort/Checkbook "
          f"NYC links (with rel=noopener-noreferrer + accessible marking), 0 unallowlisted "
          f"external-link icons across {len(PAGES)} page(s)")


if __name__ == "__main__":
    main()
