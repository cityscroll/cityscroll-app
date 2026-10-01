/**
 * Served membership read-back for recovered venue edges at BK1503 / QN0602.
 *
 * Public alias: ce08b21f46de9
 *
 * Verify: python3 tools/capture_near_you_place_slices_production_read.py --check
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DELIVERY = join(ROOT, "docs/evidence/near-you-place-slices/delivery.json");
const MEMBERSHIP = join(ROOT, "docs/evidence/near-you-place-slices/membership-served-read.json");
const LANDED = "a1a3fc0128ec2f11da77e26713fa3b61ceed4211";
const SEPT29 =
  "meeting:community_board:nyc-calendar:brooklyn-cb-15:2026-09-29:general-board-meeting-in-person";
const FOREST =
  "meeting:community_board:0pue8uab456hejvloi8sikfpke@google.com::2026-09-08";

function runPython(code, env = {}) {
  const result = spawnSync("python3", ["-c", code], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || ""}` },
  });
  return result;
}

function classifyFixtureHtml() {
  return `
<li class="near-record" data-record-id="${SEPT29}">
  General Board Meeting (In Person) Held in Sheepshead Bay-Manhattan Beach-Gerritsen Beach
  Kingsborough Community College, 2001 Oriental Boulevard
  <a class="near-record-full-record" href="https://cityscroll.org/meetings/x">View the full record</a>
</li>
<li class="near-record" data-record-id="20260723030" data-broader-scope="broader">
  Board of Standards and Appeals Public Hearing Notice
</li>`;
}

test("delivery pin records the landed venue-membership merge on pages", () => {
  const delivery = JSON.parse(readFileSync(DELIVERY, "utf8"));
  assert.equal(delivery.schema, "cityscroll.capture_delivery.v1");
  assert.equal(delivery.public_alias, "ce08b21f46de9");
  assert.equal(delivery.landed_commit, LANDED);
  assert.equal(delivery.surface, "pages");
});

test("classifier separates exact venue rows from broader district rows", () => {
  const code = `
import sys
from pathlib import Path
sys.path.insert(0, str(Path('tools').resolve()))
from lib.near_you_membership_served_read import classify_membership_rows, SEPT29_ID, BOARD_DISTRICT_ONLY_ID
html = ${JSON.stringify(classifyFixtureHtml())}
classified = classify_membership_rows(html, meeting_id=SEPT29_ID)
assert classified['meeting_in_exact'] is True
assert classified['meeting_in_broader'] is False
assert BOARD_DISTRICT_ONLY_ID in classified['broader_ids']
assert BOARD_DISTRICT_ONLY_ID not in classified['exact_ids']
assert classified['exact_row']['held_in'] is True
print('ok')
`;
  const result = runPython(code);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});

test("validator accepts a complete membership packet and refuses a mutated positive", () => {
  const code = `
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path('tools').resolve()))
from lib.near_you_membership_served_read import (
    SCHEMA, PUBLIC_ALIAS, VIEWPORTS, validate_membership_served_read, SEPT29_ID, FOREST_ID,
    BOARD_DISTRICT_ONLY_ID, VIRTUAL_ID,
)

def viewport(name, width, height):
    return {
        "name": name,
        "width": width,
        "height": height,
        "http_status": 200,
        "role": "venue",
        "exact_meeting_present": True,
        "held_in_present": True,
        "venue_text_present": True,
        "broader_district_labeled": True,
        "exact_count": 2,
        "broader_count": 1,
        "keyboard_focusable_count": 12,
        "no_horizontal_overflow": True,
        "full_record": {
            "opened": True,
            "http_status": 200,
            "url": "https://cityscroll.org/meetings/x",
            "identity_matches": True,
            "title_present": True,
            "location_present": True,
            "page_html_sha256": "a" * 64,
            "navigation": "clicked-from-list",
        },
        "back_retains_exact_row": True,
        "page_html_sha256": "b" * 64,
        "screenshot_sha256": "c" * 64,
        "witness_sha256": "d" * 64,
        "result": "pass",
    }

packet = {
    "schema": SCHEMA,
    "public_alias": PUBLIC_ALIAS,
    "observed_at": "2026-10-01T00:00:00Z",
    "evidence_class": "deployed-production-read-back",
    "origin": "https://cityscroll.org",
    "api_origin": "https://api.cityscroll.org",
    "required_ancestor": "${LANDED}",
    "required_ancestor_contained": True,
    "deployment": {
        "pages": {
            "manifest_url": "https://cityscroll.org/artifact-manifest.json",
            "revision": "${LANDED}",
            "generated_at": "2026-10-01T00:00:00Z",
            "deployment_at": "2026-10-01T00:00:00Z",
            "artifact_hash": "e" * 64,
            "manifest_sha256": "f" * 64,
            "contains_required_ancestor": True,
        },
        "worker": {
            "health_url": "https://api.cityscroll.org/health",
            "commit": "${LANDED}",
            "environment": "production",
            "contains_required_ancestor": True,
        },
    },
    "data_generation": {
        "district_activity_built_at": "2026-10-01T00:00:00Z",
        "pages_artifact_generated_at": "2026-10-01T00:00:00Z",
        "bk1503_deferred_sha256": "1" * 64,
    },
    "capture": {
        "tool": "tools/capture_near_you_place_slices_production_read.py",
        "browser": "chromium 1",
        "viewports": [{"name": n, "width": w, "height": h} for n, w, h in VIEWPORTS],
        "screenshot_binaries_committed": False,
    },
    "journeys": [
        {
            "fixture": "BK1503",
            "label": "Sheepshead Bay",
            "meeting_id": SEPT29_ID,
            "role": "venue",
            "broader_district": "K15",
            "route": "/near-you/deferred.json?geo=nta2020%3ABK1503&lens=meetings&surface=records",
            "page_route": "/near-you/?geo=nta2020%3ABK1503&lens=meetings&surface=records",
            "deferred_response_sha256": "2" * 64,
            "deferred_sections": {"primary": {"state": "ready", "count": 2}},
            "exact_count": 2,
            "broader_count": 1,
            "viewports": [viewport(n, w, h) for n, w, h in VIEWPORTS],
            "result": "pass",
        },
        {
            "fixture": "QN0602",
            "label": "Forest Hills",
            "meeting_id": FOREST_ID,
            "role": "venue",
            "broader_district": "Q06",
            "route": "/near-you/deferred.json?geo=nta2020%3AQN0602&lens=meetings&surface=records",
            "page_route": "/near-you/?geo=nta2020%3AQN0602&lens=meetings&surface=records",
            "deferred_response_sha256": "3" * 64,
            "deferred_sections": {"primary": {"state": "ready", "count": 1}},
            "exact_count": 1,
            "broader_count": 1,
            "viewports": [viewport(n, w, h) for n, w, h in VIEWPORTS],
            "result": "pass",
        },
    ],
    "boundaries": {
        "board_district_only": {
            "meeting_id": BOARD_DISTRICT_ONLY_ID,
            "fixture": "BK1503",
            "observed_in_exact": False,
            "observed_in_broader": True,
            "result": "pass",
        },
        "virtual_or_unlocated": {
            "meeting_id": VIRTUAL_ID,
            "fixture": "BK1503",
            "observed_in_exact": False,
            "result": "pass",
        },
        "unsupported_all_nyc_recovery": {
            "fixture": "BK0101",
            "recovery": "unsupported",
            "all_nyc_present": True,
            "deferred_response_sha256": "4" * 64,
            "result": "pass",
        },
    },
    "summary": {
        "result": "pass",
        "journeys_observed": 2,
        "viewport_observations": 4,
        "boundary_controls": 3,
    },
}

validate_membership_served_read(packet)

mutated = json.loads(json.dumps(packet))
mutated["journeys"][0]["meeting_id"] = "meeting:mutated-positive"
try:
    validate_membership_served_read(mutated)
except AssertionError as err:
    assert "positive meeting identity" in str(err) or "BK1503" in str(err) or "lost" in str(err)
    print("mutation_rejected")
else:
    raise SystemExit("mutated positive was accepted")
`;
  const result = runPython(code);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /mutation_rejected/);
});

test("production membership packet is retained with dual ancestry when captured", (t) => {
  let packet;
  try {
    packet = JSON.parse(readFileSync(MEMBERSHIP, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      t.skip(
        "production membership capture pending until Pages and Worker both contain the landed delivery",
      );
      return;
    }
    throw error;
  }
  assert.equal(packet.schema, "cityscroll.near_you_membership_served_read.v1");
  assert.equal(packet.public_alias, "ce08b21f46de9");
  assert.equal(packet.required_ancestor, LANDED);
  assert.equal(packet.required_ancestor_contained, true);
  assert.equal(packet.deployment.pages.contains_required_ancestor, true);
  assert.equal(packet.deployment.worker.contains_required_ancestor, true);
  assert.match(packet.deployment.pages.revision, /^[0-9a-f]{40}$/);
  assert.match(packet.deployment.worker.commit, /^[0-9a-f]{40}$/);
  assert.equal(packet.capture.screenshot_binaries_committed, false);
  assert.deepEqual(
    packet.journeys.map((row) => row.meeting_id),
    [SEPT29, FOREST],
  );
  assert.equal(packet.summary.result, "pass");
  assert.equal(packet.boundaries.board_district_only.observed_in_exact, false);
  assert.equal(packet.boundaries.virtual_or_unlocated.observed_in_exact, false);
  assert.equal(packet.boundaries.unsupported_all_nyc_recovery.all_nyc_present, true);
});
