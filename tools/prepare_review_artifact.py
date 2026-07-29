#!/usr/bin/env python3
"""Add public channel metadata and no-index headers to a built review artifact."""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path

CHANNELS = ("preview", "beta")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
NOINDEX_RULE = "/*\n  X-Robots-Tag: noindex\n"
BODY_RE = re.compile(r"(<body(?:\s[^>]*)?>)", re.IGNORECASE)


def channel_banner(channel: str, commit: str) -> str:
    label = "Draft preview" if channel == "preview" else "Experimental beta"
    return f"""
<script data-release-channel-config>window.CROL_API_ORIGIN = "https://api-beta.cityscroll.org";</script>
<aside data-release-channel-banner role="note" lang="en" style="background:#1f3a5f;color:#fff;padding:10px 18px;text-align:center;font:600 14px/1.45 ui-sans-serif,system-ui,sans-serif">
  <strong>{html.escape(label)}</strong>
  <span aria-hidden="true"> · </span>
  <span>Commit <code style="color:inherit;background:transparent">{html.escape(commit[:12])}</code></span>
  <span aria-hidden="true"> · </span>
  <a href="https://cityscroll.org/" style="color:#fff;text-decoration:underline;text-underline-offset:2px">Go to the stable site</a>
</aside>"""


def prepare(site_root: Path, channel: str, commit: str) -> None:
    if channel not in CHANNELS:
        raise ValueError(f"unsupported review channel: {channel}")
    if not SHA_RE.fullmatch(commit):
        raise ValueError("commit must be a full lowercase 40-character git SHA")
    if not (site_root / "index.html").is_file():
        raise ValueError("site root does not contain index.html")

    banner = channel_banner(channel, commit)
    pages = sorted(site_root.rglob("*.html"))
    if not pages:
        raise ValueError("site root does not contain HTML pages")
    for page in pages:
        source = page.read_text()
        if "data-release-channel-banner" in source or "data-release-channel-config" in source:
            continue
        updated, count = BODY_RE.subn(rf"\1{banner}", source, count=1)
        if count != 1:
            raise ValueError(f"could not find <body> in {page.relative_to(site_root)}")
        page.write_text(updated)

    headers = site_root / "_headers"
    existing = headers.read_text() if headers.exists() else ""
    if "X-Robots-Tag:" not in existing:
        separator = "" if not existing or existing.endswith("\n") else "\n"
        headers.write_text(f"{existing}{separator}{NOINDEX_RULE}")

    (site_root / "release-channel.json").write_text(
        json.dumps(
            {
                "channel": channel,
                "commit": commit,
                "canonical_site": "https://cityscroll.org/",
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site-root", type=Path, required=True)
    parser.add_argument("--channel", required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()

    try:
        prepare(args.site_root.resolve(), args.channel, args.commit)
    except (OSError, ValueError) as error:
        sys.exit(f"review artifact preparation failed: {error}")


if __name__ == "__main__":
    main()
