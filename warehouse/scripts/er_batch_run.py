#!/usr/bin/env python3
"""CPU-capped WH-04 entity-resolution batch entrypoint.

Wraps the Node identity pass (entity_resolution/) with WH-01 guards:
single-job lock, headroom gate, taskpolicy/nice wrap.

Examples:
  # Offline proof (no network) — fixture OCP + stem variants
  warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py \\
    --from-fixture --limit 25 --force-headroom

  # Small warehouse slice (after WH-01/02 OCP load; headroom must be OK)
  warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py --limit 200
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cpu_guard import IngestLock, check_headroom, run_capped
from paths import REPO_ROOT, WAREHOUSE_DIR, receipts_dir


def _node_bin() -> str:
    return shutil.which("node") or "node"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="CPU-capped batch ER over warehouse tables (WH-04)"
    )
    p.add_argument(
        "--from-fixture",
        action="store_true",
        help="Offline fixture rows (OCP sample + er-batch variants)",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=200,
        help="Max OCP rows (default 200 — incremental slice)",
    )
    p.add_argument(
        "--force-headroom",
        action="store_true",
        help="Allow run when headroom probe is CONSTRAINED (tiny proof only)",
    )
    p.add_argument(
        "--skip-materialize",
        action="store_true",
        help="Write stage JSONL only (no parquet/DuckDB)",
    )
    p.add_argument(
        "--snapshot-date",
        default=None,
        help="Snapshot partition date YYYY-MM-DD (default: UTC today)",
    )
    args = p.parse_args(argv)

    if args.limit < 1:
        raise SystemExit("--limit must be >= 1")
    if args.limit > 5000 and not args.force_headroom:
        raise SystemExit(
            f"--limit {args.limit} > 5000 requires --force-headroom after headroom OK "
            "(CPU discipline — start with ≤200)."
        )

    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with IngestLock():
        headroom = check_headroom(force=args.force_headroom)
        node = _node_bin()
        script = WAREHOUSE_DIR / "scripts" / "er_batch.mjs"
        cmd = [node, str(script), "--limit", str(args.limit)]
        if args.from_fixture:
            cmd.append("--from-fixture")
        if args.skip_materialize:
            cmd.append("--skip-materialize")
        if args.force_headroom:
            cmd.append("--force-headroom")
        if args.snapshot_date:
            cmd.extend(["--snapshot-date", args.snapshot_date])

        # Fixture proof is light; warehouse slice still gets taskpolicy wrap.
        if args.from_fixture and args.limit <= 100:
            import subprocess

            proc = subprocess.run(cmd, cwd=str(REPO_ROOT), check=False)
        else:
            proc = run_capped(cmd, cwd=REPO_ROOT)

        if proc.returncode != 0:
            return proc.returncode

        # Stamp a thin runner receipt alongside the Node proof (gitignored unless proof/).
        runner_receipt = {
            "phase": "WH-04",
            "entrypoint": "er_batch_run.py",
            "started_at": started,
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "from_fixture": bool(args.from_fixture),
            "limit": args.limit,
            "headroom": {
                "status": headroom.get("status"),
                "constrained": headroom.get("constrained"),
            },
            "cpu_discipline": {
                "single_job_lock": True,
                "headroom_gate": True,
                "taskpolicy_or_nice_wrap": not (
                    args.from_fixture and args.limit <= 100
                ),
            },
        }
        out_dir = receipts_dir() / "proof"
        out_dir.mkdir(parents=True, exist_ok=True)
        # Merge into committed proof if Node already wrote it.
        proof_path = out_dir / "wh04_er_batch_latest.json"
        if proof_path.is_file():
            try:
                existing = json.loads(proof_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                existing = {}
            existing["runner"] = runner_receipt
            proof_path.write_text(
                json.dumps(existing, indent=2) + "\n", encoding="utf-8"
            )
        else:
            (out_dir / "wh04_er_batch_runner.json").write_text(
                json.dumps(runner_receipt, indent=2) + "\n", encoding="utf-8"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
