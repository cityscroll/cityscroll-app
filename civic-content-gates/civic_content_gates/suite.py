"""Named suite runner — one invocable entry for CI and other civic sites."""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence

from . import SUITE_MEMBERS
from . import control_labels, genai_disclosure, heading_punctuation, i18n_keys, link_text
from . import nyc_copy_lint, page_metadata, reading_level


@dataclass
class GateVerdict:
    name: str
    exit_code: int
    detail: str = ""

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


def _runner(name: str, site_root: Path, **opts) -> int:
    if name == "link_text":
        return link_text.run(site_root, pages=opts.get("pages"))
    if name == "control_labels":
        return control_labels.run(site_root)
    if name == "i18n_keys":
        return i18n_keys.run(site_root)
    if name == "nyc_copy_lint":
        return nyc_copy_lint.run(
            site_root,
            pages=opts.get("pages"),
            allowlist_file=opts.get("allowlist"),
            gate=opts.get("gate", True),
        )
    if name == "heading_punctuation":
        return heading_punctuation.run(site_root, pages=opts.get("pages"))
    if name == "page_metadata":
        return page_metadata.run(site_root, pages=opts.get("pages"))
    if name == "genai_disclosure":
        return genai_disclosure.run(site_root)
    if name == "reading_level":
        return reading_level.run(
            site_root,
            files=opts.get("pages") or opts.get("files"),
            preset=opts.get("preset", "nycsg7"),
            mode=opts.get("mode", "ratchet"),
            max_grade=opts.get("max_grade"),
            baseline=opts.get("baseline"),
            fmt=opts.get("format", "table"),
        )
    raise KeyError(f"unknown gate: {name}")


def run_suite(
    site_root: Path,
    members: Optional[Sequence[str]] = None,
    *,
    pages: Optional[Sequence[str]] = None,
    allowlist: Optional[Path] = None,
    gate: bool = True,
    reading_level_mode: str = "ratchet",
    reading_level_baseline: Optional[Path] = None,
    reading_level_max_grade: Optional[float] = None,
    reading_level_preset: str = "nycsg7",
    skip_reading_level: bool = False,
) -> list[GateVerdict]:
    """Run each suite member and return verdicts. Does not short-circuit on failure."""
    site_root = Path(site_root)
    names = list(members) if members is not None else list(SUITE_MEMBERS)
    if skip_reading_level:
        names = [n for n in names if n != "reading_level"]

    verdicts: list[GateVerdict] = []
    for name in names:
        opts = {
            "pages": pages,
            "allowlist": allowlist,
            "gate": gate,
            "mode": reading_level_mode,
            "baseline": reading_level_baseline,
            "max_grade": reading_level_max_grade,
            "preset": reading_level_preset,
            "format": "table",
        }
        print(f"\n—— {name} ——", flush=True)
        try:
            code = _runner(name, site_root, **opts)
        except Exception as exc:  # noqa: BLE001 — suite boundary; surface as failed gate
            print(f"{name}: ERROR {exc}", file=sys.stderr)
            code = 2
            detail = str(exc)
        else:
            detail = "pass" if code == 0 else "fail"
        verdicts.append(GateVerdict(name=name, exit_code=code, detail=detail))
    return verdicts


def verdicts_to_machine(verdicts: Sequence[GateVerdict]) -> str:
    lines = []
    for v in verdicts:
        lines.append(f"VERDICT {v.name} exit={v.exit_code}")
    return "\n".join(lines) + ("\n" if lines else "")


def overall_exit(verdicts: Sequence[GateVerdict]) -> int:
    if any(v.exit_code != 0 for v in verdicts):
        return 1
    return 0
