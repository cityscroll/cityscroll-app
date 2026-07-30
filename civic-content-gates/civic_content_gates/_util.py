"""Shared helpers for gate modules."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Iterable, Optional, Sequence

DEFAULT_PAGES = (
    "index.html",
    "about.html",
    "data.html",
    "stats.html",
    "api.html",
    "changelog.html",
    "standards.html",
)


def load_strings(site_root: Path, lang: Optional[str] = None) -> dict:
    """Load window.STRINGS from site_root/i18n.js via Node (classic-script shape)."""
    # Absolute path is required: node require() does not resolve relative paths against cwd.
    i18n = (Path(site_root) / "i18n.js").resolve()
    out = subprocess.check_output(
        [
            "node",
            "-e",
            "global.window={};require(process.argv[1]);console.log(JSON.stringify(window.STRINGS))",
            str(i18n),
        ],
        text=True,
    )
    data = json.loads(out)
    if lang is None:
        return data
    return data.get(lang, {})


def load_strings_en(site_root: Path) -> dict:
    return load_strings(site_root, "en")


def resolve_pages(pages: Optional[Sequence[str]]) -> list[str]:
    if pages is None:
        return list(DEFAULT_PAGES)
    return list(pages)
