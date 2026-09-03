import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LAND_MAP_AUTHORITY_PROJECTION_VERSION,
  landMapAuthorityHandoff,
} from "../site/land_map_authority_handoff.mjs";
import { buildLandMapModel } from "../site/land_map_model.mjs";
import { landMapSelectionHTML } from "../site/app/map_runtime.mjs";

const point = { points: { "2025K0305": {
  lat: 40.65, lon: -73.95, method: "multi_bbl_anchor", precision: "anchor", bbl_count: 25,
} } };
const summary = (overrides = {}) => ({
  schema: "cityscroll.land_authority_summary.v1",
  project_id: "2025K0305",
  status: "resolved",
  procedure_id: "ulurp_197c",
  procedure_resolution: "uniform",
  current_stage: { stage_id: "ulurp_197c.application_certification", status: "known" },
  current_actor_refs: ["agency:id:city-planning"],
  current_role: "administrative_certifier",
  effect: "supplied effect",
  observed: { status: "draft_only", recommendations: [] },
  source_basis: {
    profile: { source_type: "reviewed_static_registry", registry_version: "2026-08-27.v1" },
    phase: { source_type: "publisher_current_milestone", current_milestone: "MM - Review Filed" },
  },
  freshness: { generated_at: "2026-08-23T07:59:14.162Z" },
  ...overrides,
});
const row = (authority_summary) => ({ project_id: "2025K0305", project_name: "Anchor specimen", authority_summary });

test("adapter joins only the canonical project id and preserves supplied projection fields", () => {
  const handoff = landMapAuthorityHandoff({
    projectId: "2025K0305", row: row(summary()), panelHref: "/browse/zoning/#land/2025K0305",
  });
  assert.equal(handoff.state, "available");
  assert.equal(handoff.project_id, "2025K0305");
  assert.equal(handoff.projection_version, LAND_MAP_AUTHORITY_PROJECTION_VERSION);
  assert.equal(handoff.source_receipt, LAND_MAP_AUTHORITY_PROJECTION_VERSION);
  assert.equal(handoff.procedure_id, "ulurp_197c");
  assert.equal(handoff.stage.stage_id, "ulurp_197c.application_certification");
  assert.equal(handoff.normative.current_role, "administrative_certifier");
  assert.equal(handoff.observed.status, "draft_only");
  assert.equal(handoff.panel_href, "/browse/zoning/#land/2025K0305");
});

test("missing, unknown, and stale summaries are typed without changing location state", () => {
  assert.equal(landMapAuthorityHandoff({ projectId: "2025K0305", row: row(null) }).state, "unavailable");
  assert.equal(landMapAuthorityHandoff({ projectId: "2025K0305", row: row(summary({ status: "unknown", reason: "mixed_procedure" })) }).state, "partial");
  const stale = landMapAuthorityHandoff({ projectId: "2025K0305", row: row(summary({ reason: "stale_source" })) });
  assert.equal(stale.state, "unavailable");
  assert.equal(stale.reason, "stale_source");
  for (const value of [null, row(summary({ project_id: "OTHER" }))]) {
    const result = landMapAuthorityHandoff({ projectId: "2025K0305", row: value });
    assert.equal(result.state, "unavailable");
    assert.equal(result.location_state, "mapped");
  }
});

test("map selection renders a compact handoff and keeps point provenance separate", () => {
  const model = buildLandMapModel({
    rows: [row(summary())], pointLookup: point, selectedProjectId: "2025K0305",
  });
  const html = landMapSelectionHTML(model, { sourceVintage: "cityscroll.land_project_map_points.v1" });
  assert.match(html, /data-land-map-authority-state="available"/);
  assert.match(html, /data-land-map-authority-projection="ldp05_authority_summary_v1"/);
  assert.match(html, /data-land-map-authority-source-vintage="2026-08-23T07:59:14\.162Z"/);
  assert.match(html, /data-land-map-method="multi_bbl_anchor"/);
  assert.match(html, /data-land-map-source-vintage="cityscroll\.land_project_map_points\.v1"/);
  assert.match(html, /data-land-map-authority-detail="2025K0305"/);
  assert.doesNotMatch(html, /land-authority-facts|data-land-authority-actor/);
});
