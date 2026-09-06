"""Read the Contracts Browse population through its index.

The document at site/data/procurement_browse_rows.json names bounded shards
instead of carrying the rows, so the whole population is the concatenation of
the shards it names, in the order it names them. A document that still carries
its own rows — an offline fixture, say — is returned unchanged.
"""

from __future__ import annotations

import json
from pathlib import Path


def read_browse_population(path: Path | str) -> dict:
    """Return the whole Browse population document, following shards if any."""
    index_path = Path(path)
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    if isinstance(payload.get("rows"), list):
        return payload
    shards = payload.get("shards")
    if not isinstance(shards, list):
        return payload
    rows: list = []
    for descriptor in shards:
        shard_path = index_path.parent / str(descriptor.get("path", ""))
        shard = json.loads(shard_path.read_text(encoding="utf-8"))
        if not isinstance(shard.get("rows"), list):
            raise SystemExit(f"Browse population shard is missing rows[]: {shard_path}")
        rows.extend(shard["rows"])
    combined = {key: value for key, value in payload.items()
                if key not in {"representation", "shard_schema", "shards"}}
    combined["rows"] = rows
    return combined
