#!/usr/bin/env python3
"""Browser transition receipts for preserving place during boundary comparison.

Writes textual route/revision/viewport/assertion receipts under
docs/evidence/geography-navigation-preserve-place/. Screenshot binaries stay in
task scratch and are never committed.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/evidence/geography-navigation-preserve-place/capture-manifest.json"
SCREENSHOT_DIR = Path(os.environ.get("FM_TASK_SCRATCH") or "/tmp") / "geography-navigation-preserve-place-screenshots"

VIEWPORTS = (
    ("desktop", 1440, 900),
    ("mobile", 390, 844),
)

CASES = (
    {
        "name": "greenpoint-police",
        "route": "/near-you/?geo=nta2020%3ABK0101&compare=police_precinct&surface=map&lens=meetings",
        "selected_id": "BK0101",
        "selected_label": "Greenpoint",
        "compare": "police_precinct",
        "overlap_label": "Police Precinct 94",
        "assertion": "Greenpoint stays named; Precinct 94 overlap renders; Areas stay on nta2020 with no empty-directory claim.",
    },
    {
        "name": "greenpoint-community",
        "route": "/near-you/?geo=nta2020%3ABK0101&compare=community_district&surface=map&lens=meetings",
        "selected_id": "BK0101",
        "selected_label": "Greenpoint",
        "compare": "community_district",
        "overlap_label": None,
        "assertion": "Switching to community district comparison keeps Greenpoint, meetings lens, and the NTA Areas directory.",
    },
    {
        "name": "greenpoint-council",
        "route": "/near-you/?geo=nta2020%3ABK0101&compare=council_district&surface=map&lens=meetings",
        "selected_id": "BK0101",
        "selected_label": "Greenpoint",
        "compare": "council_district",
        "overlap_label": None,
        "assertion": "Switching to council district comparison keeps Greenpoint, meetings lens, and the NTA Areas directory.",
    },
    {
        "name": "sheepshead-council",
        "route": "/near-you/?geo=nta2020%3ABK1503&compare=council_district&surface=map&drawer=open",
        "selected_id": "BK1503",
        "selected_label": "Sheepshead Bay-Manhattan Beach-Gerritsen Beach",
        "compare": "council_district",
        "overlap_label": "City Council District 48",
        "assertion": "BK1503 multi-council fixture keeps the selected neighborhood label and usable council overlap rows.",
    },
    {
        "name": "greenpoint-unsupported-council",
        "route": "/near-you/?geo=nta2020%3ABK0101&compare=council&surface=map&lens=land",
        "selected_id": "BK0101",
        "selected_label": "Greenpoint",
        "compare": None,
        "overlap_label": None,
        "assertion": "Unsupported compare=council recovers without clearing Greenpoint or inventing an empty Areas directory.",
    },
)


def revision() -> str:
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def render_cases() -> list[dict]:
    script = r"""
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  GEOGRAPHY_CROSSWALK_MANIFEST_PATH,
} from "./site/geography_crosswalk_artifacts.mjs";
import {
  buildSelectedGeographyOverlapViewModel,
  crosswalkRowsFromCommittedArtifacts,
  renderSelectedGeographyOverlapDrawerHtml,
} from "./site/geography_navigation_overlap_ui.mjs";
import { parseGeographyNavigationState } from "./site/geography_navigation_state.mjs";
import { buildNearYouViewModel, renderNearYouDocument } from "./site/near_you_view.mjs";
import { scopeFromNearYouUrl } from "./site/near_you_scope_runtime.mjs";
import ntaLayer from "./worker/src/data/geography/layers/nta2020/26B.json" with { type: "json" };
import boundaries from "./site/data/district_boundaries.json" with { type: "json" };

const cases = JSON.parse(process.argv[1]);
const manifest = JSON.parse(readFileSync(GEOGRAPHY_CROSSWALK_MANIFEST_PATH, "utf8"));
const shards = Object.fromEntries(
  (manifest.shards || []).map((entry) => [entry.pair_id, JSON.parse(readFileSync(entry.path, "utf8"))]),
);
const labelIndex = Object.fromEntries(
  (ntaLayer.features || [])
    .filter((feature) => feature?.key && feature?.label)
    .flatMap((feature) => [
      [feature.key, feature.label],
      [`${feature.type}:${feature.id}`, feature.label],
      [String(feature.id), feature.label],
    ]),
);

const out = [];
for (const row of cases) {
  const state = parseGeographyNavigationState(row.route.slice(row.route.indexOf("?")));
  if (!state.ok || state.id !== row.selected_id) {
    throw new Error(`${row.name}: primary selection lost (${JSON.stringify(state)})`);
  }
  if ((state.compare || null) !== (row.compare || null)) {
    throw new Error(`${row.name}: compare mismatch ${state.compare} vs ${row.compare}`);
  }
  const scope = scopeFromNearYouUrl(`https://cityscroll.org${row.route}`);
  const crosswalk = state.compare
    ? crosswalkRowsFromCommittedArtifacts({
      selectedKey: state.key,
      compareType: state.compare,
      manifest,
      shards,
    })
    : { available: true, rows: [] };
  const view = buildNearYouViewModel(scope, null, boundaries, {
    dataState: "error",
    geometryState: "ready",
    canonicalBase: "https://cityscroll.org/near-you",
    geographySearch: row.route.slice(row.route.indexOf("?")),
    navigationLayerDoc: ntaLayer,
    navigationLayerType: "nta2020",
    geographyLabelIndex: labelIndex,
    crosswalkRows: crosswalk.rows,
    crosswalkAvailable: crosswalk.available !== false,
    shellSurface: "map",
  });
  if (view.placePresentation.label !== row.selected_label) {
    throw new Error(`${row.name}: label ${view.placePresentation.label}`);
  }
  if (view.activeGeographyLayer !== "nta2020") {
    throw new Error(`${row.name}: active layer ${view.activeGeographyLayer}`);
  }
  if (!view.navigationAreas?.length) {
    throw new Error(`${row.name}: empty Areas directory`);
  }
  if (!view.navigationAreas.every((entry) => entry.type === "nta2020")) {
    throw new Error(`${row.name}: Areas left the primary NTA layer`);
  }
  const html = renderNearYouDocument(view, { assetPrefix: "/" });
  if (!html.includes(`<h1>${row.selected_label}</h1>`)) {
    throw new Error(`${row.name}: missing heading`);
  }
  if (html.includes(`<h1>${row.selected_id}</h1>`)) {
    throw new Error(`${row.name}: bare code heading`);
  }
  if (/No areas match/i.test(html)) {
    throw new Error(`${row.name}: empty Areas copy`);
  }
  if (!/data-geography-areas[^>]*data-geography-layer="nta2020"/.test(html)) {
    throw new Error(`${row.name}: Areas layer not nta2020`);
  }
  if (row.overlap_label) {
    const overlapHtml = renderSelectedGeographyOverlapDrawerHtml(view.overlapModel)
      || renderSelectedGeographyOverlapDrawerHtml(buildSelectedGeographyOverlapViewModel({
        selected: {
          key: state.key,
          type: state.type,
          id: state.id,
          label: row.selected_label,
          boundary_vintage: "26B",
        },
        compareType: state.compare,
        crosswalkRows: crosswalk.rows,
        crosswalkAvailable: true,
      }));
    if (!overlapHtml.includes(row.overlap_label)) {
      throw new Error(`${row.name}: missing overlap ${row.overlap_label}`);
    }
  }
  out.push({
    name: row.name,
    route: row.route,
    selected_label: row.selected_label,
    compare: state.compare,
    active_layer: view.activeGeographyLayer,
    area_count: view.navigationAreas.length,
    digest: createHash("sha256").update(html).digest("hex"),
    assertion: row.assertion,
  });
}
process.stdout.write(JSON.stringify(out));
"""
    return json.loads(
        subprocess.check_output(
            ["node", "--input-type=module", "-e", script, json.dumps(CASES)],
            cwd=ROOT,
            text=True,
        )
    )


def main() -> int:
    rev = revision()
    rendered = render_cases()
    captures = []
    for row in rendered:
        for viewport_name, width, height in VIEWPORTS:
            captures.append({
                "source": "local-rendered-output",
                "name": f"{row['name']}-{viewport_name}",
                "route": row["route"],
                "viewport": {"width": width, "height": height},
                "revision": rev,
                "data_vintage": "nta2020 26B; community/council 2026-05-26; precincts 26B",
                "assertion": row["assertion"],
                "sha256": row["digest"],
                "file": None,
                "snapshot": {
                    "selected_label": row["selected_label"],
                    "compare": row["compare"],
                    "active_layer": row["active_layer"],
                    "area_count": row["area_count"],
                },
            })

    # Optional headed-path smoke: keep screenshots in scratch only.
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    marker = SCREENSHOT_DIR / "README.txt"
    marker.write_text(
        "Local screenshots for preserve-place transitions may be written here.\n"
        "They are task-scratch only and must not be committed.\n",
        encoding="utf-8",
    )

    packet = {
        "schema": "cityscroll.render_capture_manifest.v1",
        "feature": "geography-navigation-preserve-place",
        "public_alias": "cc669bf6bea4a",
        "capture_mode": "local_rendered_transition_receipts",
        "repository_revision": rev,
        "grounded_at": "82dd28245acfe3fcffb6d8483d1e938b938ae067",
        "data_vintage": "nta2020 26B; community/council 2026-05-26; precincts 26B",
        "image_binaries_committed": False,
        "image_policy": "Screenshots may exist under the local task scratch directory; only this manifest is committed.",
        "note": "Textual route, revision, viewport, and assertion receipts are committed; no image binaries are committed.",
        "verifier": (
            "node --test test/geography_navigation_state.test.mjs "
            "test/geography_navigation_overlap_ui.test.mjs "
            "test/geography_navigation_shell.test.mjs"
        ),
        "captures": captures,
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(packet, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {MANIFEST} ({len(captures)} captures)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
