#!/usr/bin/env python3
"""CLI wrapper for the IBO fiscal-history source ingestion."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from ibo_fiscal_history import main


if __name__ == "__main__":
    raise SystemExit(main())
