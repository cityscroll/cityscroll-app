"""Independent expectations for joining a rendered Land List to its point projection."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
POINT_PROJECTION = json.loads(
    (ROOT / "site" / "data" / "land_project_map_points.json").read_text("utf-8")
)


def expected_counts_for_list(list_ids: list[str]) -> dict[str, int]:
    """Join a bounded visible List to the full-catalog generated point projection."""
    ids = list(dict.fromkeys(list_ids))
    points = POINT_PROJECTION.get("points", {})
    unmapped = POINT_PROJECTION.get("unmapped", {})
    missing = [project_id for project_id in ids if project_id not in points and project_id not in unmapped]
    assert not missing, f"visible List ids are absent from the point projection: {missing}"
    mapped_count = sum(project_id in points for project_id in ids)
    return {
        "total": len(ids),
        "mapped": mapped_count,
        "unmapped": len(ids) - mapped_count,
    }
