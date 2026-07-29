#!/usr/bin/env python3
"""Fail when a deploy artifact contains repository-only or secret-bearing files."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

FORBIDDEN_PARTS = {
    ".agents",
    ".claude",
    ".git",
    ".github",
    "backlog",
    "internal",
    "tasks",
}
FORBIDDEN_NAMES = {
    ".env",
    ".scrimignore",
    "AGENTS.html",
    "AGENTS.md",
    "CLAUDE.html",
    "CLAUDE.md",
    "PAPERCUTS.html",
    "PAPERCUTS.md",
}
FORBIDDEN_SUFFIXES = {".key", ".p12", ".pem"}


def violations(site_root: Path) -> list[str]:
    problems: list[str] = []
    if not site_root.is_dir():
        return ["site root does not exist"]
    if not (site_root / "index.html").is_file():
        problems.append("index.html is missing")

    for path in site_root.rglob("*"):
        relative = path.relative_to(site_root)
        if path.is_symlink():
            problems.append(f"symbolic link is not deployable: {relative}")
            continue
        if not path.is_file():
            continue
        if FORBIDDEN_PARTS.intersection(relative.parts):
            problems.append(f"repository-only path: {relative}")
        if path.name in FORBIDDEN_NAMES:
            problems.append(f"repository-only file: {relative}")
        if path.suffix.lower() in FORBIDDEN_SUFFIXES:
            problems.append(f"credential-shaped file: {relative}")
    return sorted(set(problems))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site-root", type=Path, required=True)
    args = parser.parse_args()
    problems = violations(args.site_root.resolve())
    if problems:
        for problem in problems:
            print(f"FAIL {problem}", file=sys.stderr)
        sys.exit(f"public artifact gate: {len(problems)} violation(s)")
    print("public artifact gate green")


if __name__ == "__main__":
    main()
