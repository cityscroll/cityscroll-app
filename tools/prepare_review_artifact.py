#!/usr/bin/env python3
"""Add public channel metadata and no-index headers to a built review artifact."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

CHANNELS = {"preview", "beta"}
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
NOINDEX_RULE = "/*\n  X-Robots-Tag: noindex\n"


def prepare(site_root: Path, channel: str, commit: str) -> None:
    if channel not in CHANNELS:
        raise ValueError(f"unsupported review channel: {channel}")
    if not SHA_RE.fullmatch(commit):
        raise ValueError("commit must be a full lowercase 40-character git SHA")
    if not (site_root / "index.html").is_file():
        raise ValueError("site root does not contain index.html")

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
                "canonical_site": "https://crol-list.org/",
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
