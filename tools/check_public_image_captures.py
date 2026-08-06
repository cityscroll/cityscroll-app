#!/usr/bin/env python3
"""Reject added public images that identify private product surfaces.

The caller supplies only newly added image paths from the pull request diff. This keeps the
check fast and avoids turning the existing public screenshot corpus into a baseline migration.
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Source: public image-review policy; these are format names, not measured data.
IMAGE_EXTENSIONS = {".gif", ".jpeg", ".jpg", ".png", ".webp"}

# Deliberately require a path boundary: "desktop" is not a desk capture.
# Source: public image-review policy and its documented path-boundary requirements.
PATH_MARKERS = (
    (re.compile(r"(?:^|[/_.-])desk(?:[/_.-]|$)", re.IGNORECASE), "path contains a desk segment"),  # source: docs/public-capture-guard.md
    (re.compile(r"(?:^|[/_.-])team(?:[/_.-]|$)", re.IGNORECASE), "path contains a team segment"),  # source: docs/public-capture-guard.md
    (
        re.compile(r"(?:^|/)(?:internal|private|desk-captures?|team-captures?)(?:/|$)", re.IGNORECASE),  # source: docs/public-capture-guard.md
        "path contains a private capture directory",  # source: docs/public-capture-guard.md
    ),
)
# Source: public image-review policy; exact host supplied by the site owner.
DESK_URL = re.compile(r"(?:https?://)?desk\.cityscroll\.org(?:[/?#\s]|$)", re.IGNORECASE)  # source: docs/public-capture-guard.md
# Source: public image-review policy; multi-token signature supplied by the site owner.
DESK_NAV = re.compile(
    r"(?=.*\b(?:team|projects?)\b)(?=.*\bsettings\b)(?=.*\b(?:dashboard|home)\b)",
    re.IGNORECASE | re.DOTALL,
)


def _png_text(path: Path) -> str:
    """Read PNG tEXt/zTXt/iTXt metadata without a third-party image dependency."""
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ""
    chunks: list[bytes] = []
    offset = 8
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8]
        payload_start = offset + 8
        payload_end = payload_start + length
        if payload_end + 4 > len(data):
            break
        if kind in {b"tEXt", b"zTXt", b"iTXt"}:
            chunks.append(data[payload_start:payload_end])
        offset = payload_end + 4
        if kind == b"IEND":
            break
    return b"\n".join(chunks).decode("latin-1", errors="ignore")


def load_allowlist(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    entries = payload.get("captures", {})
    if not isinstance(entries, dict) or any(not isinstance(k, str) or not isinstance(v, str) or not v.strip() for k, v in entries.items()):
        raise ValueError("allowlist captures must map paths to non-empty reasons")
    return entries


def inspect_image(path: Path, relative: str, allowlist: dict[str, str]) -> list[str]:
    if relative in allowlist:
        return []
    findings: list[str] = []
    for pattern, reason in PATH_MARKERS:
        if pattern.search(relative):
            findings.append(reason)
    if path.suffix.lower() == ".png":
        text = _png_text(path)
        if DESK_URL.search(text):
            findings.append("PNG metadata contains desk.cityscroll.org")
        if DESK_NAV.search(text):
            findings.append("PNG metadata matches the desk navigation signature")
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--paths-file", type=Path, required=True)
    parser.add_argument("--allowlist", type=Path, default=ROOT / "docs/public-capture-allowlist.json")
    args = parser.parse_args(argv)
    allowlist = load_allowlist(args.allowlist)
    failures: list[str] = []
    for raw in args.paths_file.read_text(encoding="utf-8").splitlines():
        relative = raw.strip().replace("\\", "/")
        if not relative:
            continue
        path = ROOT / relative
        if path.suffix.lower() not in IMAGE_EXTENSIONS or not path.is_file():
            continue
        findings = inspect_image(path, relative, allowlist)
        failures.extend(f"{relative}: {finding}" for finding in findings)
    if failures:
        print("public image capture guard FAILED:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    print("public image capture guard OK — no added private-surface captures found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
