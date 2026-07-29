#!/usr/bin/env python3
"""Stamp built-site i18n URLs from the content that will be deployed.

Source files keep one merge-stable token. The GitHub Pages build replaces that
token in its private artifact; no generated stamp is committed to a feature
branch.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

PAGES = (
    "index.html",
    "about.html",
    "data.html",
    "stats.html",
    "api.html",
    "changelog.html",
    "standards.html",
)
VERSION_MARKER = "__I18N_ASSET_VERSION__"
VERSION_LENGTH = 12
SCRIPT_RE = re.compile(r'(src="i18n\.js\?v=)([^"]+)(")')
SHIPPING_RE = re.compile(r"SHIPPING_LANGS\s*=\s*\[(.*?)\]", re.S)


class StampError(RuntimeError):
    """Raised when the source or built artifact cannot preserve cache safety."""


def shipping_languages(root: Path) -> list[str]:
    source = (root / "i18n.js").read_text()
    match = SHIPPING_RE.search(source)
    if not match:
        raise StampError("could not parse SHIPPING_LANGS in i18n.js")
    return sorted(set(re.findall(r'"([^"]+)"', match.group(1))))


def i18n_asset_paths(root: Path) -> list[Path]:
    paths = list((root / "i18n.js",))
    paths.extend(root / "i18n" / "lang" / f"{lang}.js" for lang in shipping_languages(root))
    missing = tuple(path.relative_to(root).as_posix() for path in paths if not path.is_file())
    if missing:
        raise StampError(f"missing shipping i18n asset(s): {missing}")
    return paths


def i18n_asset_version(root: Path) -> str:
    """Return one content address for the core and every shipping dictionary."""

    digest = hashlib.sha256()
    for path in i18n_asset_paths(root):
        relative = path.relative_to(root).as_posix().encode()
        digest.update(relative)
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:VERSION_LENGTH]


def verify_source(root: Path) -> str:
    """Require every source page to carry the merge-stable build token."""

    for page in PAGES:
        source = (root / page).read_text()
        matches = SCRIPT_RE.findall(source)
        if len(matches) != 1:
            raise StampError(f"{page} must load i18n.js exactly once with ?v=<version>")
        if matches[0][1] != VERSION_MARKER:
            raise StampError(
                f"{page} must keep the build-time i18n token {VERSION_MARKER!r}; "
                f"found {matches[0][1]!r}"
            )
    return i18n_asset_version(root)


def stamp_site(root: Path) -> str:
    """Replace source tokens in a built artifact, leaving the source tree alone."""

    version = verify_source(root)
    for page in PAGES:
        path = root / page
        source = path.read_text()
        stamped = SCRIPT_RE.sub(rf"\g<1>{version}\g<3>", source, count=1)
        path.write_text(stamped)
    return version


def verify_built(root: Path) -> str:
    """Fail if built pages and the deployed i18n content are out of sync."""

    version = i18n_asset_version(root)
    stale: list[tuple[str, str]] = list()
    for page in PAGES:
        source = (root / page).read_text()
        matches = SCRIPT_RE.findall(source)
        if len(matches) != 1:
            raise StampError(f"{page} must load i18n.js exactly once with ?v=<version>")
        got = matches[0][1]
        if got != version:
            stale.append((page, got))
    if stale:
        details = ", ".join(f"{page} has v={got}" for page, got in stale)
        raise StampError(
            f"built i18n cache skew: {details}; deployed assets hash to {version}"
        )
    return version


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site-root", type=Path, default=Path("."))
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check-source", action="store_true")
    action.add_argument("--stamp", action="store_true")
    action.add_argument("--verify-built", action="store_true")
    args = parser.parse_args()
    root = args.site_root.resolve()

    try:
        if args.check_source:
            version = verify_source(root)
            print(f"i18n source is derivable (next content version: {version})")
        elif args.stamp:
            version = stamp_site(root)
            print(f"stamped built i18n assets with v={version}")
        else:
            version = verify_built(root)
            print(f"built i18n cache-skew gate green (v={version})")
    except (OSError, StampError) as error:
        sys.exit(f"i18n stamp gate: {error}")


if __name__ == "__main__":
    main()
