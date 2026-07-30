#!/usr/bin/env python3
"""Guard the public CityScroll identity, SVG sources, and generated icon family."""
from __future__ import annotations

import json
from pathlib import Path
import re
import struct
import sys
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[2]
SITE_ROOT = ROOT / "site"
PAGES = [
    "index.html",
    "about.html",
    "data.html",
    "stats.html",
    "api.html",
    "changelog.html",
    "standards.html",
]
LANGUAGES = ["es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"]
SVG_NS = "{http://www.w3.org/2000/svg}"
LEGACY_NAME = "CROL" + "-List"


def png_dimensions(path: Path):
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    return struct.unpack(">II", raw[16:24])


def main():
    failures = []

    for name in PAGES:
        source = (SITE_ROOT / name).read_text()
        required = {
            'content="CityScroll"': "Open Graph site name",
            'property="og:title"': "Open Graph title",
            'property="og:image"': "Open Graph image",
            'rel="icon" href="assets/brand/favicon.svg"': "SVG favicon",
            'rel="apple-touch-icon"': "Apple touch icon",
            'rel="manifest" href="site.webmanifest"': "web manifest",
            'rel="stylesheet" href="brand.css"': "shared brand theme",
        }
        for needle, label in required.items():
            if needle not in source:
                failures.append(f"{name}: missing {label}")
        title = re.search(r"<title>([^<]+)</title>", source)
        if not title or "CityScroll" not in title.group(1):
            failures.append(f"{name}: title does not use CityScroll")
        if LEGACY_NAME in source:
            failures.append(f"{name}: legacy product name remains visible")
        canonical = re.search(r'<link rel="canonical" href="([^"]+)">', source)
        if not canonical or not canonical.group(1).startswith("https://cityscroll.org"):
            failures.append(f"{name}: canonical domain changed or is missing")

    for path in [SITE_ROOT / "i18n.js", *(SITE_ROOT / "i18n" / "lang" / f"{lang}.js" for lang in LANGUAGES)]:
        source = path.read_text()
        if LEGACY_NAME in source:
            failures.append(f"{path.relative_to(ROOT)}: legacy product name remains")
        if "CityScroll" not in source:
            failures.append(f"{path.relative_to(ROOT)}: CityScroll name is missing")

    brand_css = (SITE_ROOT / "brand.css").read_text()
    for token in ("--color-brand:", "--font-brand:", "--space-1:"):
        if token not in brand_css:
            failures.append(f"brand.css: missing token family represented by {token}")

    svg_files = [
        "cityscroll-mark.svg",
        "cityscroll-mark-on-dark.svg",
        "cityscroll-lockup.svg",
        "cityscroll-lockup-on-dark.svg",
        "favicon.svg",
        "cityscroll-app-icon.svg",
        "cityscroll-social-card.svg",
        "candidates/civic-folio.svg",
        "candidates/open-ledger.svg",
        "candidates/record-route.svg",
    ]
    for name in svg_files:
        path = SITE_ROOT / "assets" / "brand" / name
        try:
            tree = ElementTree.parse(path)
            root = tree.getroot()
        except (OSError, ElementTree.ParseError) as error:
            failures.append(f"{path.relative_to(ROOT)}: invalid SVG ({error})")
            continue
        if "viewBox" not in root.attrib:
            failures.append(f"{path.relative_to(ROOT)}: missing viewBox")
        if root.find(f"{SVG_NS}title") is None:
            failures.append(f"{path.relative_to(ROOT)}: missing title")
        if root.find(f".//{SVG_NS}image") is not None:
            failures.append(f"{path.relative_to(ROOT)}: embedded raster image is not allowed")

    mark_source = (SITE_ROOT / "assets" / "brand" / "cityscroll-mark.svg").read_text()
    if "<desc" not in mark_source or "currentColor" not in mark_source:
        failures.append("cityscroll-mark.svg: missing description or currentColor adaptability")

    manifest = json.loads((SITE_ROOT / "site.webmanifest").read_text())
    if manifest.get("name") != "CityScroll":
        failures.append("site.webmanifest: product name is not CityScroll")

    expected_pngs = {
        "apple-touch-icon.png": (180, 180),
        "favicon-32.png": (32, 32),
        "icon-192.png": (192, 192),
        "icon-512.png": (512, 512),
        "cityscroll-social-card.png": (1200, 630),
    }
    for name, dimensions in expected_pngs.items():
        path = SITE_ROOT / "assets" / "brand" / name
        try:
            actual = png_dimensions(path)
        except (OSError, ValueError) as error:
            failures.append(f"{path.relative_to(ROOT)}: {error}")
            continue
        if actual != dimensions:
            failures.append(f"{path.relative_to(ROOT)}: expected {dimensions}, found {actual}")

    if failures:
        print("brand identity gate FAILED:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        raise SystemExit(1)
    print(f"brand identity gate OK — {len(PAGES)} pages, 11 dictionaries, {len(svg_files)} SVGs, 5 PNGs")


if __name__ == "__main__":
    main()
