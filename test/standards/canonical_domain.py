#!/usr/bin/env python3
"""Guard the CityScroll canonical-domain contract and deliberate exceptions."""
from __future__ import annotations

from pathlib import Path
import re
import sys
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[2]
SITE_ROOT = ROOT / "site"
PAGES = [
    ("index.html", "https://cityscroll.org/"),
    ("about.html", "https://cityscroll.org/about.html"),
    ("api.html", "https://cityscroll.org/api.html"),
    ("changelog.html", "https://cityscroll.org/changelog.html"),
    ("data.html", "https://cityscroll.org/data.html"),
    ("standards.html", "https://cityscroll.org/standards.html"),
    ("stats.html", "https://cityscroll.org/stats.html"),
]
SITEMAP_PAGES = [page for page in PAGES if page[0] not in {"changelog.html", "data.html"}]
PROMOTED_DOCUMENTS = [
    "https://cityscroll.org/now/",
    "https://cityscroll.org/near-you/",
    "https://cityscroll.org/following/",
    "https://cityscroll.org/browse/",
    "https://cityscroll.org/browse/contracts/",
    "https://cityscroll.org/browse/staffing/",
    "https://cityscroll.org/browse/zoning/",
    "https://cityscroll.org/browse/property/",
    "https://cityscroll.org/browse/rules/",
    "https://cityscroll.org/browse/meetings/",
]
RETIRED_DESTINATIONS = {
    "changelog.html": "https://cityscroll.org/about.html",
    "data.html": "https://cityscroll.org/about.html#data",
}
CANONICAL_DYNAMIC_PATH_ROUTES = (
    "cityscroll.org/near-you*",
    "cityscroll.org/following*",
    "cityscroll.org/prefs*",
)
API_DOCUMENT_URL = re.compile(
    r"https://api\.cityscroll\.org/"
    r"(?:near-you(?=[?/\"'#]|$)|prefs(?=[?/\"'#]|$)|"
    r"following(?!/personal(?:[?/\"'#]|$))(?=[?/\"'#]|$))"
)


def attribute(source: str, tag_pattern: str, name: str) -> str | None:
    match = re.search(tag_pattern, source)
    return match.group(1) if match else None


def main() -> None:
    failures: list[str] = []

    for filename, expected in PAGES:
        source = (SITE_ROOT / filename).read_text()
        document_url = RETIRED_DESTINATIONS.get(filename, expected)
        canonical = attribute(source, r'<link rel="canonical" href="([^"]+)">', "canonical")
        og_url = attribute(source, r'<meta property="og:url" content="([^"]+)">', "og:url")
        og_image = attribute(source, r'<meta property="og:image" content="([^"]+)">', "og:image")
        if canonical != document_url:
            failures.append(f"{filename}: canonical is {canonical!r}, expected {document_url!r}")
        if og_url != document_url:
            failures.append(f"{filename}: og:url is {og_url!r}, expected {document_url!r}")
        if og_image != "https://cityscroll.org/assets/brand/cityscroll-social-card.png":
            failures.append(f"{filename}: og:image does not use cityscroll.org")
        robots = "noindex,follow" if filename in RETIRED_DESTINATIONS else "index,follow"
        if f'<meta name="robots" content="{robots}">' not in source:
            failures.append(f"{filename}: missing {robots} robots metadata")

    robots = (SITE_ROOT / "robots.txt").read_text()
    if "Sitemap: https://cityscroll.org/sitemap.xml" not in robots or "crol-list.org" in robots:
        failures.append("robots.txt: sitemap must use only cityscroll.org")

    sitemap_path = SITE_ROOT / "sitemap.xml"
    try:
        root = ElementTree.parse(sitemap_path).getroot()
        locations = [
            node.text for node in root.findall("{http://www.sitemaps.org/schemas/sitemap/0.9}url/"
                                               "{http://www.sitemaps.org/schemas/sitemap/0.9}loc")
        ]
    except ElementTree.ParseError as error:
        failures.append(f"sitemap.xml: invalid XML ({error})")
        locations = []
    expected_locations = [SITEMAP_PAGES[0][1], *PROMOTED_DOCUMENTS, *[expected for _, expected in SITEMAP_PAGES[1:]]]  # Source: canonical page contracts above.
    if locations != expected_locations:
        failures.append("sitemap.xml: page set or ordering differs from the canonical page contract")
    if any(not location.startswith("https://cityscroll.org") for location in locations):
        failures.append("sitemap.xml: every URL must use cityscroll.org")

    for path in sorted(SITE_ROOT.rglob("*.html")):
        source = path.read_text(encoding="utf-8")
        for href in re.findall(r'<a\b[^>]*\bhref="([^"]+)"', source, re.I):
            if API_DOCUMENT_URL.search(href):
                failures.append(
                    f"{path.relative_to(ROOT)}: reader document link exposes api.cityscroll.org ({href})"
                )

    # Runtime link builders can bypass committed HTML, so reject literal API-host
    # document destinations in the public site source too. The personal endpoint
    # remains a background data request, not a reader navigation destination.
    for path in sorted(SITE_ROOT.rglob("*")):
        if path.suffix not in {".html", ".js", ".mjs"}:
            continue
        source = path.read_text(encoding="utf-8")
        if API_DOCUMENT_URL.search(source):
            failures.append(
                f"{path.relative_to(ROOT)}: public source mints an API-host document URL"
            )

    if (SITE_ROOT / "CNAME").read_text().strip() != "crol-list.org":
        failures.append("CNAME: must remain the GitHub Pages origin used by the CityScroll mirror")

    cors = (ROOT / "worker/src/lib/cors.mjs").read_text()
    if '? (origin || "https://cityscroll.org")' not in cors:
        failures.append("worker CORS: default public origin must be cityscroll.org")
    for origin in ("https://cityscroll.org", "https://crol-list.org"):
        if origin not in cors:
            failures.append(f"worker CORS: missing {origin} origin contract")
    usage = (ROOT / "worker/src/usage.mjs").read_text()
    if 'ALLOW.has(origin) ? origin : "https://cityscroll.org"' not in usage:
        failures.append("worker CORS: usage fallback origin must be cityscroll.org")
    api_page = (SITE_ROOT / "api.html").read_text()
    if 'href="https://api.cityscroll.org/property-locations"' not in api_page:
        failures.append("API docs: Property location JSON link must use api.cityscroll.org")

    wrangler = (ROOT / "worker/wrangler.toml").read_text()
    for hostname in (
        "api.cityscroll.org", "api.crol-list.org",
        "api-beta.cityscroll.org", "api-beta.crol-list.org",
    ):
        if hostname not in wrangler:
            failures.append(f"worker routes: missing {hostname}")
    for route in CANONICAL_DYNAMIC_PATH_ROUTES:
        if route not in wrangler:
            failures.append(f"worker routes: missing bounded canonical route {route}")
    if 'CONFIRM_BASE = "https://api-beta.cityscroll.org"' not in wrangler:
        failures.append("worker routes: beta confirmation links must mint on cityscroll.org")
    if 'CONFIRM_BASE = "https://api.cityscroll.org"' not in wrangler:
        failures.append("worker routes: production confirmation links must mint on cityscroll.org")
    for sender in ("alerts@cityscroll.org", "feedback@cityscroll.org", "subscribe@crol-list.org"):
        if sender not in wrangler:
            failures.append(f"email scope: {sender} missing — alerts@ and feedback@ use cityscroll.org; subscribe@ remains on crol-list.org until inbound routing is migrated")
    if not re.search(r'ALERTS_FROM\s*=\s*"[^"]*alerts@cityscroll\.org', wrangler):
        failures.append("email scope: ALERTS_FROM must send from alerts@cityscroll.org")
    if re.search(r'ALERTS_FROM\s*=\s*"[^"]*alerts@crol-list\.org', wrangler):
        failures.append("email scope: alerts@crol-list.org must not be the live ALERTS_FROM value")
    # Reply-To stays on the still-routable old-domain address: cityscroll.org has no apex MX.
    if 'ALERTS_REPLY_TO = "alerts@crol-list.org"' not in wrangler:
        failures.append("email scope: ALERTS_REPLY_TO must keep human replies on alerts@crol-list.org (still-routable)")

    mirror = (ROOT / "worker/src/mirror.mjs").read_text()
    if 'const ORIGIN = "https://crol-list.org";' not in mirror:
        failures.append("mirror: primary GitHub Pages origin must remain crol-list.org")
    # Site failover must be the stamped deploy host, not raw GitHub source (source keeps
    # merge-stable __I18N_ASSET_VERSION__ tokens). Field case 2026-07-30.
    if 'const SITE_FALLBACK_ORIGIN = "https://cityscroll.pages.dev/";' not in mirror:
        failures.append("mirror: site failover must use the stamped cityscroll.pages.dev artifact")
    if 'const REPOSITORY_FALLBACK_ORIGIN = "https://raw.githubusercontent.com/cityscroll/crol-list/main/";' not in mirror:
        failures.append("mirror: public repository-document failover seam is missing")
    if 'redirect: "manual"' not in mirror:
        failures.append("mirror: origin fetches must not auto-follow redirects back to CityScroll")
    if "redirectedToMirror(originResponse)" not in mirror:
        failures.append("mirror: missing explicit redirect-loop failover")
    if "fetchFallback" not in mirror:
        failures.append("mirror: stamped site failover must follow same-origin pretty-URL redirects")

    feed = (ROOT / "worker/src/lib/feed.mjs").read_text()
    if "https://cityscroll.org/notices/" not in feed:
        failures.append("feeds: new item links must use cityscroll.org")
    if "UID:${escIcs(it.id)}@crol-list" not in feed:
        failures.append("calendar: persistent UID namespace changed")
    if "tag:crol-list.org,2026:" not in feed:
        failures.append("Atom: persistent entry namespace changed")

    beta = (ROOT / "tools/ensure_beta_pages.mjs").read_text()
    if 'const BETA_DOMAIN = "beta.cityscroll.org";' not in beta:
        failures.append("beta pointer: expected beta.cityscroll.org")
    if "crol-list-beta.pages.dev" not in (ROOT / "docs/beta-channel.md").read_text():
        failures.append("beta previews: stable Pages aliases must remain unchanged")

    architecture = (ROOT / "docs/architecture.md").read_text()
    for phrase in (
        "cityscroll.org",
        "alerts@cityscroll.org",
        "301",
        "crol-list.org",
    ):
        if phrase not in architecture:
            failures.append(f"architecture: missing public domain fact {phrase!r}")

    if failures:
        print("canonical-domain gate FAILED:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        raise SystemExit(1)
    print("canonical-domain gate OK — site, API, beta, redirects, and stable identifiers")


if __name__ == "__main__":
    main()
