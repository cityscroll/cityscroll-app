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

// LM-15: the compact handoff also carries a typed procedure state, a normative role kept
// separate from the observed stage, and a next-action affordance that never promises more
// than the supplied evidence threshold clears — never derived from marker position, filters,
// nearby boundaries, or a generic "current status" alone.

test("A1/A4 known specimen exposes procedure_state=known and a published next action", () => {
  const handoff = landMapAuthorityHandoff({
    projectId: "2025K0305",
    row: row(summary({ published_next_opportunity: {
      status: "published", checked: true, checked_vintage: "2026-08-20", source_id: "hearing-1",
      label: "CPC public hearing", date: "2026-09-15", representing: "City Planning Commission",
    } })),
    panelHref: "/browse/zoning/#land/2025K0305",
  });
  assert.equal(handoff.procedure_state, "known");
  assert.equal(handoff.next_action.status, "published");
  assert.equal(handoff.next_action.date, "2026-09-15");
  assert.equal(handoff.next_action.label, "CPC public hearing");
});

test("A1/A2/A4 mixed specimen types procedure_state=mixed and keeps role/effect empty rather than guessed", () => {
  const handoff = landMapAuthorityHandoff({
    projectId: "2025K0305",
    row: row(summary({
      status: "unknown", reason: "mixed_procedure", procedure_resolution: "mixed",
      current_stage: { stage_id: null, spine_phase_id: null, status: "unknown" },
      current_role: null, effect: null, current_actor_refs: [],
    })),
  });
  assert.equal(handoff.state, "partial");
  assert.equal(handoff.procedure_state, "mixed");
  assert.equal(handoff.procedure_resolution, "mixed");
  assert.equal(handoff.normative.current_role, null);
  assert.equal(handoff.stage.status, "unknown");
});

test("A1/A4 unknown-procedure specimen is typed unknown, not partial-as-mixed", () => {
  const handoff = landMapAuthorityHandoff({
    projectId: "2025K0305",
    row: row(summary({
      status: "unknown", reason: "unresolved_procedure", procedure_resolution: "unknown",
      current_stage: { stage_id: null, spine_phase_id: null, status: "unknown" },
    })),
  });
  assert.equal(handoff.procedure_state, "unknown");
  assert.notEqual(handoff.procedure_state, "mixed");
});

test("A1/A4 stale specimen types procedure_state and next_action as stale, not missing", () => {
  const handoff = landMapAuthorityHandoff({
    projectId: "2025K0305",
    row: row(summary({ reason: "stale_source", published_next_opportunity: { status: "published", date: "2026-01-01", checked_vintage: "2025-11-01" } })),
  });
  assert.equal(handoff.state, "unavailable");
  assert.equal(handoff.procedure_state, "stale");
  assert.equal(handoff.next_action.status, "stale");
  assert.equal(handoff.next_action.date, null);
});

test("A1/A4 missing-action specimen: a resolved procedure with no supplied opportunity never invents one", () => {
  const withoutOpportunity = summary();
  delete withoutOpportunity.published_next_opportunity;
  const handoff = landMapAuthorityHandoff({ projectId: "2025K0305", row: row(withoutOpportunity) });
  assert.equal(handoff.procedure_state, "known");
  assert.equal(handoff.next_action.status, "missing");
  assert.equal(handoff.next_action.date, null);
});

test("A1/A4 an explicitly checked-and-none opportunity is typed none, distinct from missing/unknown", () => {
  const handoff = landMapAuthorityHandoff({
    projectId: "2025K0305",
    row: row(summary({ published_next_opportunity: { status: "none", checked: true, checked_vintage: "2026-08-20" } })),
  });
  assert.equal(handoff.next_action.status, "none");
  assert.notEqual(handoff.next_action.status, "missing");
});

test("A4 invalid-summary fixtures (wrong schema, non-object, no project match) are typed missing, never a guessed known state", () => {
  for (const bad of [
    row({ project_id: "2025K0305" }), // no schema at all
    row({ schema: "cityscroll.land_authority_summary.v1", project_id: "OTHER" }), // wrong project joined
    row("not-an-object"),
    row(summary({ schema: "cityscroll.other.v1" })),
  ]) {
    const handoff = landMapAuthorityHandoff({ projectId: "2025K0305", row: bad });
    assert.equal(handoff.procedure_state, "missing");
    assert.equal(handoff.next_action.status, "missing");
    assert.equal(handoff.location_state, "mapped");
  }
});

test("A2 the map selection HTML separates location, next-action, and normative role into distinct data attributes", () => {
  const withRole = summary({
    current_role: "administrative_certifier",
    published_next_opportunity: {
      status: "published", checked: true, checked_vintage: "2026-08-20",
      source_id: "hearing-1", date: "2026-09-15", representing: "City Planning Commission",
    },
  });
  const model = buildLandMapModel({
    rows: [row(withRole)], pointLookup: point, selectedProjectId: "2025K0305",
  });
  const html = landMapSelectionHTML(model, { sourceVintage: "cityscroll.land_project_map_points.v1" });
  assert.match(html, /data-land-map-authority-procedure-state="known"/);
  assert.match(html, /data-land-map-authority-role="administrative_certifier"/);
  assert.match(html, /data-land-map-authority-next-action="published"/);
  assert.match(html, /data-land-map-authority-next-action-date="2026-09-15"/);
  assert.match(html, /data-land-map-location-state="mapped"/);
});

test("A1/A3 a mixed selection never shows a next-action date and never shows raw geometry-derived text", () => {
  const model = buildLandMapModel({
    rows: [row(summary({ status: "unknown", reason: "mixed_procedure", procedure_resolution: "mixed" }))],
    pointLookup: point, selectedProjectId: "2025K0305",
  });
  const html = landMapSelectionHTML(model, { sourceVintage: "cityscroll.land_project_map_points.v1" });
  assert.match(html, /data-land-map-authority-procedure-state="mixed"/);
  assert.match(html, /No next action is published|land_map_authority_next_action_not_published/);
  assert.doesNotMatch(html, /data-land-map-authority-next-action="published"/);
});
