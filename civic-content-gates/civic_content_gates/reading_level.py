"""Reading-level gate — consolidated path over readable-or-else.

The NYC Web Content Style Guide's reading-level rule is enforced by
[readable-or-else](https://github.com/jimdc/readable-or-else). This module is the
house entrypoint so CI and local checks share one invocation shape with the other
standards gates under test/standards/.

Hard gate (card-style verify; fails any page above the max grade):

    python3 test/standards/reading_level.py --max-grade 7 about.html

Ratchet (default CI mode — fails only on regression vs a committed baseline):

    python3 test/standards/reading_level.py --mode ratchet \\
      --baseline reading-level-baseline.json --root site \\
      about.html api.html changelog.html data.html index.html stats.html standards.html
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional, Sequence

from . import _util


def _find_cli() -> str:
    exe = shutil.which("readable-or-else")
    if exe:
        return exe
    # Some installs only expose the module entrypoint.
    return "readable-or-else"


def build_cmd(
    files: Sequence[str],
    *,
    preset: str = "nycsg7",
    mode: str = "gate",
    max_grade: Optional[float] = None,
    baseline: Optional[Path] = None,
    fmt: str = "table",
    suggest: bool = False,
) -> list[str]:
    cmd = [_find_cli(), "check", *files, "--preset", preset, "--mode", mode, "--format", fmt]
    if max_grade is not None:
        cmd.extend(["--max-grade", str(max_grade)])
    if baseline is not None:
        cmd.extend(["--baseline", str(baseline)])
    if suggest:
        cmd.append("--suggest")
    return cmd


def run(
    site_root: Path,
    files: Optional[Sequence[str]] = None,
    *,
    preset: str = "nycsg7",
    mode: str = "gate",
    max_grade: Optional[float] = None,
    baseline: Optional[Path] = None,
    fmt: str = "table",
    suggest: bool = False,
) -> int:
    """Run the reading-level check. Returns the subprocess exit code."""
    site_root = Path(site_root).resolve()
    pages = list(files) if files else list(_util.DEFAULT_PAGES)
    # Keep paths relative to site_root whenever possible. The committed baseline
    # keys are bare filenames ("about.html"); absolute paths miss those entries
    # and flip ratchet mode into the "new file" hard-grade path.
    resolved = []
    for f in pages:
        p = Path(f)
        if p.is_absolute():
            try:
                resolved.append(str(p.resolve().relative_to(site_root)))
            except ValueError:
                resolved.append(str(p))
        else:
            # Strip a leading "site/" if the caller passed repo-relative paths.
            parts = p.parts
            if parts and parts[0] == site_root.name and (site_root / Path(*parts[1:])).exists():
                resolved.append(str(Path(*parts[1:])))
            else:
                resolved.append(str(p))

    if mode == "ratchet" and baseline is None:
        print("reading_level: --baseline is required in ratchet mode", file=sys.stderr)
        return 2
    if mode == "gate" and max_grade is None and preset == "custom":
        print("reading_level: --max-grade is required for custom preset in gate mode", file=sys.stderr)
        return 2

    # Baseline path: if relative, leave it relative to cwd (site_root) when it
    # resolves there; otherwise absolute so readable-or-else can open it from site_root.
    baseline_path = None
    if baseline is not None:
        b = Path(baseline)
        if b.is_absolute():
            baseline_path = b
        elif (site_root / b).exists():
            baseline_path = b
        elif b.exists():
            baseline_path = b.resolve()
        else:
            # Common house layout: baseline lives in site/ and caller passed
            # site/reading-level-baseline.json from the repo root.
            name = b.name
            if (site_root / name).exists():
                baseline_path = Path(name)
            else:
                baseline_path = b

    cmd = build_cmd(
        resolved,
        preset=preset,
        mode=mode,
        max_grade=max_grade,
        baseline=baseline_path,
        fmt=fmt,
        suggest=suggest,
    )
    try:
        proc = subprocess.run(cmd, cwd=str(site_root), text=True, capture_output=True)
    except FileNotFoundError:
        print(
            "reading_level: readable-or-else is not installed. "
            "Install with: pip install git+https://github.com/jimdc/readable-or-else.git",
            file=sys.stderr,
        )
        return 127

    # Surface tool output unchanged so CI annotations/table formats keep working.
    if proc.stdout:
        sys.stdout.write(proc.stdout)
        if not proc.stdout.endswith("\n"):
            sys.stdout.write("\n")
    if proc.stderr:
        sys.stderr.write(proc.stderr)
        if not proc.stderr.endswith("\n"):
            sys.stderr.write("\n")
    return proc.returncode


def measure_json(
    site_root: Path,
    files: Sequence[str],
    *,
    preset: str = "nycsg7",
    mode: str = "ratchet",
    baseline: Optional[Path] = None,
    max_grade: Optional[float] = None,
) -> list[dict]:
    """Return readable-or-else JSON results (for characterization / drift evidence)."""
    # Delegate path handling to run() via a capture-only format call would discard
    # the exit code; rebuild with the same relative-path rules as run().
    site_root = Path(site_root).resolve()
    resolved = []
    for f in files:
        p = Path(f)
        if p.is_absolute():
            try:
                resolved.append(str(p.resolve().relative_to(site_root)))
            except ValueError:
                resolved.append(str(p))
        else:
            resolved.append(str(p))
    baseline_arg = None
    if baseline is not None:
        b = Path(baseline)
        if not b.is_absolute() and (site_root / b.name).exists() and b.name == "reading-level-baseline.json":
            baseline_arg = Path(b.name) if (site_root / b.name).exists() else b
        elif b.is_absolute():
            baseline_arg = b
        elif (site_root / b).exists():
            baseline_arg = b
        else:
            baseline_arg = b.resolve() if b.exists() else b
    cmd = build_cmd(
        resolved,
        preset=preset,
        mode=mode,
        max_grade=max_grade,
        baseline=baseline_arg,
        fmt="json",
    )
    proc = subprocess.run(cmd, cwd=str(site_root), text=True, capture_output=True)
    out = proc.stdout or "[]"
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return [{"error": "unparseable", "stdout": out, "stderr": proc.stderr, "code": proc.returncode}]


def main(argv: Optional[Sequence[str]] = None, site_root: Optional[Path] = None) -> int:
    import argparse
    p = argparse.ArgumentParser(
        description="Reading-level gate (readable-or-else wrapper)",
    )
    p.add_argument("--root", type=Path, default=site_root,
                   help="Site root (HTML pages live here; cwd for readable-or-else)")
    p.add_argument("--max-grade", type=float, default=None,
                   help="Fail pages above this Flesch–Kincaid grade (gate mode)")
    p.add_argument("--preset", default="nycsg7",
                   choices=["nycsg7", "govuk9", "wcag-aaa", "custom"])
    p.add_argument("--mode", default=None, choices=["gate", "warn", "ratchet"],
                   help="Default: gate when --max-grade is set, else ratchet if --baseline is set, else gate")
    p.add_argument("--baseline", type=Path, default=None,
                   help="Committed baseline JSON (required for ratchet mode)")
    p.add_argument("--format", dest="fmt", default="table",
                   choices=["json", "table", "gh-annotations"])
    p.add_argument("--suggest", action="store_true",
                   help="Ask readable-or-else for rewrite suggestions (needs LLM config)")
    p.add_argument("files", nargs="*", help="HTML files relative to --root (default: public pages)")
    args = p.parse_args(list(argv) if argv is not None else None)

    root = args.root
    if not root:
        # Fallback: if files look like paths with a parent site/, infer — else require --root.
        p.error("--root is required (pass the directory that holds the HTML pages)")

    mode = args.mode
    if mode is None:
        if args.baseline is not None and args.max_grade is None:
            mode = "ratchet"
        else:
            mode = "gate"

    # Card-style: --max-grade 7 about.html implies gate mode with the nycsg7 preset.
    max_grade = args.max_grade
    if mode == "gate" and max_grade is None and args.preset == "nycsg7":
        max_grade = 7.0

    return run(
        root,
        files=args.files or None,
        preset=args.preset,
        mode=mode,
        max_grade=max_grade,
        baseline=args.baseline,
        fmt=args.fmt,
        suggest=args.suggest,
    )


if __name__ == "__main__":
    raise SystemExit(main())
