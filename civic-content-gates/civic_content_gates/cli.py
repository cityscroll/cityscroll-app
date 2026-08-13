"""CLI entry for the civic-content-gates suite."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import SUITE_MEMBERS, __version__
from .suite import overall_exit, run_suite, verdicts_to_machine


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="civic-content-gates",
        description=(
            "Reusable civic content gate suite (NYC Web Content Style Guide and "
            "companion checks). Point --root at a static site directory."
        ),
    )
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = p.add_subparsers(dest="cmd")

    run_p = sub.add_parser("run", help="Run the full suite (default when no subcommand)")
    _add_run_args(run_p)

    list_p = sub.add_parser("list", help="List suite members")

    one_p = sub.add_parser("check", help="Run one named gate")
    one_p.add_argument("gate", choices=list(SUITE_MEMBERS))
    _add_run_args(one_p)

    return p


def _add_run_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--root", type=Path, required=True,
                   help="Site root (HTML pages + i18n.js)")
    p.add_argument("--page", action="append", dest="page_flags", default=None,
                   help="Limit to this page (repeatable). Prefer this over trailing paths "
                        "so options and page lists never fight argparse intermixing.")
    p.add_argument("--allowlist", type=Path, default=None,
                   help="nyc_copy_lint allowlist path")
    p.add_argument("--no-gate", action="store_true",
                   help="Run nyc_copy_lint in report-only mode")
    p.add_argument("--skip-reading-level", action="store_true",
                   help="Omit the reading-level member (when readable-or-else is unavailable)")
    p.add_argument("--baseline", type=Path, default=None,
                   help="reading-level baseline JSON (ratchet mode)")
    p.add_argument("--reading-level-mode", default="ratchet",
                   choices=["gate", "warn", "ratchet"])
    p.add_argument("--max-grade", type=float, default=None,
                   help="reading-level hard max grade (gate mode)")
    p.add_argument("--preset", default="nycsg7")
    p.add_argument(
        "--no-disclaimer-slop-mode",
        choices=["warn", "block"],
        default=os.environ.get("NO_DISCLAIMER_SLOP_MODE", "warn"),
        help="Plain-language disclaimer check mode (default: warn; block after calibration)",
    )
    p.add_argument(
        "--no-disclaimer-slop-allowlist",
        type=Path,
        default=None,
        help="Reviewed exceptions for the no-disclaimer-slop member",
    )
    p.add_argument("--machine", action="store_true",
                   help="Print VERDICT lines suitable for before/after comparison")
    p.add_argument("--json", action="store_true", help="Print verdicts as JSON")
    # Trailing positionals kept for convenience; combined with --page below.
    p.add_argument("pages", nargs="*", help="Optional page subset (same as repeated --page)")


def _resolve_pages(args) -> list | None:
    pages: list[str] = []
    if getattr(args, "page_flags", None):
        pages.extend(args.page_flags)
    if getattr(args, "pages", None):
        pages.extend(args.pages)
    return pages or None


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    # Default subcommand: run
    if not argv or argv[0] not in {"run", "list", "check", "--help", "-h", "--version"}:
        argv = ["run", *argv]

    parser = build_parser()
    args = parser.parse_args(argv)

    if args.cmd == "list":
        for name in SUITE_MEMBERS:
            print(name)
        return 0

    members = None
    if args.cmd == "check":
        members = [args.gate]

    if args.cmd in {"run", "check"}:
        if args.cmd == "run" and not args.skip_reading_level:
            if args.reading_level_mode == "ratchet" and not args.baseline:
                # Soft: skip reading_level with a note if no baseline rather than hard-fail
                # the whole suite for consumers who only want the style-guide members.
                print(
                    "note: no --baseline; skipping reading_level (pass --baseline for ratchet, "
                    "or --reading-level-mode gate --max-grade N)",
                    file=sys.stderr,
                )
                args.skip_reading_level = True

        verdicts = run_suite(
            args.root,
            members=members,
            pages=_resolve_pages(args),
            allowlist=args.allowlist,
            gate=not args.no_gate,
            reading_level_mode=args.reading_level_mode,
            reading_level_baseline=args.baseline,
            reading_level_max_grade=args.max_grade,
            reading_level_preset=args.preset,
            skip_reading_level=args.skip_reading_level,
            disclaimer_slop_mode=args.no_disclaimer_slop_mode,
            disclaimer_slop_allowlist=args.no_disclaimer_slop_allowlist,
        )
        if args.json:
            print(json.dumps(
                [{"name": v.name, "exit_code": v.exit_code, "detail": v.detail} for v in verdicts],
                indent=2,
            ))
        if args.machine:
            sys.stdout.write(verdicts_to_machine(verdicts))
        print("\nSuite summary:")
        for v in verdicts:
            status = "PASS" if v.passed else f"FAIL({v.exit_code})"
            print(f"  {v.name}: {status}")
        return overall_exit(verdicts)

    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
