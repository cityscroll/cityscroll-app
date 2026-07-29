#!/usr/bin/env python3
"""Guard the CityScroll canonical-domain contract and deliberate exceptions."""
from __future__ import annotations

from pathlib import Path
import re
import sys
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[2]
PAGES = [
    ("index.html", "https://cityscroll.org/"),
    ("about.html", "https://cityscroll.org/about.html"),
    ("api.html", "https://cityscroll.org/api.html"),
    ("changelog.html", "https://cityscroll.org/changelog.html"),
    ("data.html", "https://cityscroll.org/data.html"),
    ("standards.html", "https://cityscroll.org/standards.html"),
    ("stats.html", "https://cityscroll.org/stats.html"),
]


def attribute(source: str, tag_pattern: str, name: str) -> str | None:
    match = re.search(tag_pattern, source)
    return match.group(1) if match else None


def main() -> None:
    failures: list[str] = []

    for filename, expected in PAGES:
        source = (ROOT / filename).read_text()
        canonical = attribute(source, r'<link rel="canonical" href="([^"]+)">', "canonical")
        og_url = attribute(source, r'<meta property="og:url" content="([^"]+)">', "og:url")
        og_image = attribute(source, r'<meta property="og:image" content="([^"]+)">', "og:image")
        if canonical != expected:
            failures.append(f"{filename}: canonical is {canonical!r}, expected {expected!r}")
        if og_url != expected:
            failures.append(f"{filename}: og:url is {og_url!r}, expected {expected!r}")
        if og_image != "https://cityscroll.org/assets/brand/cityscroll-social-card.png":
            failures.append(f"{filename}: og:image does not use cityscroll.org")
        if '<meta name="robots" content="index,follow">' not in source:
            failures.append(f"{filename}: missing index,follow robots metadata")

    robots = (ROOT / "robots.txt").read_text()
    if "Sitemap: https://cityscroll.org/sitemap.xml" not in robots or "crol-list.org" in robots:
        failures.append("robots.txt: sitemap must use only cityscroll.org")

    sitemap_path = ROOT / "sitemap.xml"
    try:
        root = ElementTree.parse(sitemap_path).getroot()
        locations = [
            node.text for node in root.findall("{http://www.sitemaps.org/schemas/sitemap/0.9}url/"
                                               "{http://www.sitemaps.org/schemas/sitemap/0.9}loc")
        ]
    except ElementTree.ParseError as error:
        failures.append(f"sitemap.xml: invalid XML ({error})")
        locations = []
    expected_locations = [expected for _, expected in PAGES]
    if locations != expected_locations:
        failures.append("sitemap.xml: page set or ordering differs from the canonical page contract")
    if any(not location.startswith("https://cityscroll.org") for location in locations):
        failures.append("sitemap.xml: every URL must use cityscroll.org")

    if (ROOT / "CNAME").read_text().strip() != "crol-list.org":
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
    api_page = (ROOT / "api.html").read_text()
    if 'href="https://api.cityscroll.org/property-locations"' not in api_page:
        failures.append("API docs: Property location JSON link must use api.cityscroll.org")

    wrangler = (ROOT / "worker/wrangler.toml").read_text()
    for hostname in (
        "api.cityscroll.org", "api.crol-list.org",
        "api-beta.cityscroll.org", "api-beta.crol-list.org",
    ):
        if hostname not in wrangler:
            failures.append(f"worker routes: missing {hostname}")
    if 'CONFIRM_BASE = "https://api-beta.cityscroll.org"' not in wrangler:
        failures.append("worker routes: beta confirmation links must mint on cityscroll.org")
    if 'CONFIRM_BASE = "https://api.cityscroll.org"' not in wrangler:
        failures.append("worker routes: production confirmation links must mint on cityscroll.org")
    for sender in ("alerts@cityscroll.org", "feedback@crol-list.org", "subscribe@crol-list.org"):
        if sender not in wrangler:
            failures.append(f"email scope: {sender} missing — the site owner's 2026-07-29 sender-domain decision moved alerts@ to cityscroll.org while leaving feedback@/subscribe@ unchanged")
    if "alerts@crol-list.org" in wrangler:
        failures.append("email scope: alerts@crol-list.org should no longer be the live ALERTS_FROM value")

    mirror = (ROOT / "worker/src/mirror.mjs").read_text()
    if 'const ORIGIN = "https://crol-list.org";' not in mirror:
        failures.append("mirror: primary GitHub Pages origin must remain crol-list.org")
    if 'const FALLBACK_ORIGIN = "https://raw.githubusercontent.com/cityscroll/crol-list/main/";' not in mirror:
        failures.append("mirror: missing independent public-source failover seam")
    if 'redirect: "manual"' not in mirror:
        failures.append("mirror: origin fetches must not auto-follow redirects back to CityScroll")
    if "redirectedToMirror(originResponse)" not in mirror:
        failures.append("mirror: missing explicit redirect-loop failover")

    feed = (ROOT / "worker/src/lib/feed.mjs").read_text()
    if "https://cityscroll.org/#notice/" not in feed:
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

    cutover = (ROOT / "").read_text()
    for phrase in (
        "", "status `301`", "URL fragments",
        "Website", "decided on 2026-07-29 to switch the alerts sender",
    ):
        if phrase not in cutover:
            failures.append(f"cutover guide: missing {phrase!r}")

    if failures:
        print("canonical-domain gate FAILED:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        raise SystemExit(1)
    print("canonical-domain gate OK — site, API, beta, redirects, and stable identifiers")


if __name__ == "__main__":
    main()
