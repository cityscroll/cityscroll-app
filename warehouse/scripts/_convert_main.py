#!/usr/bin/env python3
"""Subprocess entry for taskpolicy-wrapped CSV→parquet conversion."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from convert_parquet import csv_to_parquet


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--csv", required=True)
    p.add_argument("--parquet", required=True)
    p.add_argument("--threads", type=int, default=1)
    p.add_argument("--meta-out", default=None)
    args = p.parse_args()
    meta = csv_to_parquet(Path(args.csv), Path(args.parquet), threads=args.threads)
    if args.meta_out:
        Path(args.meta_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.meta_out).write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    else:
        print(json.dumps(meta))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
