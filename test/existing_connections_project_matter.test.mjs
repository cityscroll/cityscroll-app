/**
 * Reciprocal navigation between a land use project and its Council matters.
 *
 * The exact-identifier bridge that decides which Council matter belongs to
 * which land project already existed and was already accepted; its receipt said
 * in as many words that nothing had been published to residents from it. These
 * tests cover the publication: the compact lookup both reader surfaces share,
 * the project connection group built from it, and the matter document section
 * that returns to the project and to the other matters filed under the same
 * application.
 *
 * Counts are never hard-coded here. The committed bridge receipt is the machine
 * evidence, and every population assertion is derived from it, so a later source
 * refresh that legitimately moves the numbers reports its own new figures
 * instead of failing on a stale fixture. What is pinned is the reasoning: an
 * exact retained application number joins, a resembling title does not, and a
 * recorded committee step is never a project decision.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { flattenCouncilMatterRows, measureCouncilLandBridge } from "../warehouse/lib/council_land_bridge.mjs";
import { buildCouncilLandMatterLinks } from "../warehouse/lib/council_land_matter_links.mjs";
import {
  councilLandMatterContext,
  councilLandMatterProjectItems,
} from "../site/council_land_matter_links.mjs";
import { buildProjectConnectionEvidence } from "../site/project_connections.mjs";
import {
  buildLegislativeMatterDocument,
  renderLegislativeMatterDocument,
} from "../site/legislative_matter_document.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const RECEIPT = read("warehouse/receipts/proof/council_land_bridge_latest.json");
const LOOKUP = read("site/data/council_land_matter_links.json");
const MATTER_LOOKUP = read("site/data/legislative_matter_lookup.json");
const SNAPSHOT = read("site/data/meeting_outcomes_snapshot.json");
const ZAP = read("site/data/zap_projects_warehouse_lookup.json");

const receiptEdges = RECEIPT.materialized_edges;
const receiptMatterIds = new Set(receiptEdges.map((edge) => edge.council_depth.matter.matter_id));
const receiptProjectIds = new Set(receiptEdges.map((edge) => edge.project_id));

// The three source-backed cases the published connection is expected to carry,
// and the two that must stay unjoined. Each is named by its own publisher
// identifiers so a failure says which record moved.
const MONITOR_POINT = "2024K0358";
const RICHMOND_TERRACE = "2024R0300";
const WALK_TO_PARK = "2025Q0316";
const RESEMBLING_TITLE_MATTER = "78875";
const NO_APPLICATION_NUMBER_MATTER = "79062";
const NO_APPLICATION_NUMBER_PROJECT = "2026K0443";

function matterIdsFor(projectId) {
  return councilLandMatterProjectItems(projectId).map((item) => item.ref.replace(/^matter:/, ""));
}

test("the published lookup is the accepted bridge, re-measured over the committed inputs", () => {
  const measured = measureCouncilLandBridge({
    rows: flattenCouncilMatterRows(SNAPSHOT),
    zapRows: ZAP.rows,
    generatedAt: RECEIPT.generated_at,
    sourceVintage: RECEIPT.source_vintage,
  });
  assert.equal(measured.gate.result, RECEIPT.gate.result);
  assert.deepEqual(measured.coverage, RECEIPT.coverage);
  assert.deepEqual(measured.join_measurement.rates, RECEIPT.join_measurement.rates);
  assert.equal(measured.materialized_edges.length, receiptEdges.length);

  // The shipped artifact is a projection of that same measurement, not a second
  // join with its own opinion about which matters belong to which project.
  const projected = buildCouncilLandMatterLinks({ measurement: measured, zapRows: ZAP.rows });
  assert.deepEqual(projected.projects, LOOKUP.projects);
  assert.deepEqual(projected.matters, LOOKUP.matters);
  assert.equal(LOOKUP.generated_at, RECEIPT.generated_at);
});

test("published population matches the receipt's own coverage figures", () => {
  assert.equal(LOOKUP.bridge.eligible_appearances, RECEIPT.coverage.eligible_rows);
  assert.equal(LOOKUP.bridge.matched_appearances, RECEIPT.coverage.matched);
  assert.equal(LOOKUP.bridge.linked_matters, receiptMatterIds.size);
  assert.equal(LOOKUP.bridge.linked_projects, receiptProjectIds.size);
  assert.equal(Object.keys(LOOKUP.matters).length, receiptMatterIds.size);
  assert.equal(Object.keys(LOOKUP.projects).length, receiptProjectIds.size);

  // Deduplicated: a project holds each matter identity once, and the matter
  // identities across all projects add up to the distinct matched population.
  const listed = Object.values(LOOKUP.projects).flatMap((project) => project.matter_ids);
  assert.equal(listed.length, new Set(listed).size);
  assert.equal(new Set(listed).size, receiptMatterIds.size);
});

test("Monitor Point exposes its three Council matters and each one returns", () => {
  assert.deepEqual(matterIdsFor(MONITOR_POINT), ["78872", "78873", "78874"]);
  for (const matterId of ["78872", "78873", "78874"]) {
    const context = councilLandMatterContext(matterId);
    assert.equal(context.project_id, MONITOR_POINT);
    assert.equal(context.project_href, `/browse/zoning/#land/${MONITOR_POINT}`);
    assert.deepEqual(
      context.companions.map((companion) => companion.matter_id).sort(),
      ["78872", "78873", "78874"].filter((id) => id !== matterId),
    );
    for (const companion of context.companions) {
      assert.equal(companion.href, `/matters/${companion.matter_id}/`);
    }
  }
});

test("Richmond Terrace and Walk to Park expose their own retained matters", () => {
  assert.deepEqual(matterIdsFor(RICHMOND_TERRACE), ["79069", "79070"]);
  assert.deepEqual(matterIdsFor(WALK_TO_PARK), ["79200"]);
  assert.equal(councilLandMatterContext("79069").project_id, RICHMOND_TERRACE);
  assert.deepEqual(councilLandMatterContext("79070").companions.map((c) => c.matter_id), ["79069"]);

  // One matter under one application is a complete connection, not a broken
  // one: the project link still resolves and the companion list is honestly
  // empty rather than padded.
  const solo = councilLandMatterContext("79200");
  assert.equal(solo.project_id, WALK_TO_PARK);
  assert.deepEqual(solo.companions, []);
});

test("every published link is reciprocal in both directions", () => {
  for (const [projectId, project] of Object.entries(LOOKUP.projects)) {
    for (const matterId of project.matter_ids) {
      const context = councilLandMatterContext(matterId);
      assert.equal(context.project_id, projectId, `matter ${matterId} must return to ${projectId}`);
      const companions = new Set(context.companions.map((companion) => companion.matter_id));
      for (const sibling of project.matter_ids) {
        if (sibling === matterId) continue;
        assert.ok(companions.has(sibling), `matter ${matterId} must list companion ${sibling}`);
      }
    }
  }
});

test("a resembling title never joins, and an absent application number never joins", () => {
  // This matter's title names the same development as the three joined ones,
  // but its application number is not in that project's retained list.
  const resembling = MATTER_LOOKUP.matters[RESEMBLING_TITLE_MATTER];
  assert.ok(resembling, "the negative control must still be a published matter");
  assert.match(resembling.title, /Monitor Point/);
  assert.equal(councilLandMatterContext(RESEMBLING_TITLE_MATTER), null);
  assert.ok(!matterIdsFor(MONITOR_POINT).includes(RESEMBLING_TITLE_MATTER));

  // The project side of the same rule: a project whose source carries no
  // application number gets no matter, however closely the names read.
  const project = ZAP.rows.find((row) => row.project_id === NO_APPLICATION_NUMBER_PROJECT);
  assert.ok(project, "the negative-control project must still be retained");
  assert.equal(project.ulurp_numbers, null);
  assert.deepEqual(matterIdsFor(NO_APPLICATION_NUMBER_PROJECT), []);
  assert.equal(councilLandMatterContext(NO_APPLICATION_NUMBER_MATTER), null);
});

test("recorded actions, source dates and published availability are preserved as retained", () => {
  for (const edge of receiptEdges) {
    const matterId = edge.council_depth.matter.matter_id;
    const entry = LOOKUP.matters[matterId];
    assert.ok(entry, `matter ${matterId} must be published`);
    assert.equal(entry.matter_file, edge.council_depth.matter.matter_file);
    assert.equal(entry.title, edge.council_depth.matter.title);
    const appearance = entry.appearances.find((held) => held.event_id === edge.council_depth.event.event_id);
    assert.ok(appearance, `matter ${matterId} must retain event ${edge.council_depth.event.event_id}`);
    assert.equal(appearance.event_date, edge.council_depth.event.date);
    assert.deepEqual(appearance.actions, edge.council_depth.actions);
    assert.equal(appearance.outcome, edge.council_depth.outcome);

    // No matched record retains a roll call. A missing vote stays missing; it
    // never becomes a zero, an official, or a disposition.
    assert.equal(edge.council_depth.votes, null);
    assert.equal(appearance.named_votes, null);
  }
  assert.equal(LOOKUP.relation.is_decision, false);
  assert.equal(LOOKUP.relation.canonical, "about_project");
  assert.equal(LOOKUP.relation.proceeding, "reviews_project");
});

test("the project group publishes the matters as a typed, non-deciding connection", () => {
  const evidence = buildProjectConnectionEvidence({
    projectId: MONITOR_POINT,
    projectRows: [{ project_id: MONITOR_POINT, project_name: "Monitor Point" }],
    councilMatterRows: councilLandMatterProjectItems(MONITOR_POINT),
  });
  const group = evidence.groups.find((entry) => entry.id === "council_matters");
  assert.equal(group.relation, "about_project");
  assert.equal(group.status, "matched");
  assert.equal(group.gap, null);
  assert.deepEqual(group.items.map((item) => item.href), [
    "/matters/78872/", "/matters/78873/", "/matters/78874/",
  ]);
  for (const item of group.items) {
    assert.equal(item.is_decision, false);
    assert.equal(item.canonical_relation, "about_project");
    assert.equal(item.confidence, "strong");
    assert.match(item.evidence, /exact retained application number/);
    assert.match(item.label, /^LU \d{4}-\d{4} — /);
    assert.equal(item.when, "2026-05-27");
    assert.match(item.outcome, /Hearing Held by Committee/);
  }
});

test("a project the bridge did not join renders no connection furniture", () => {
  const evidence = buildProjectConnectionEvidence({
    projectId: NO_APPLICATION_NUMBER_PROJECT,
    projectRows: [{ project_id: NO_APPLICATION_NUMBER_PROJECT, project_name: "Public School 15 Annex (LP-2696)" }],
    councilMatterRows: councilLandMatterProjectItems(NO_APPLICATION_NUMBER_PROJECT),
  });
  const group = evidence.groups.find((entry) => entry.id === "council_matters");
  assert.equal(group.status, "not_observed");
  assert.deepEqual(group.items, []);
  assert.equal(group.gap, "no_exact_council_matter_edge_in_bounded_corpus");
});

test("a joined matter document returns to its project and to its companions", () => {
  const view = buildLegislativeMatterDocument(MATTER_LOOKUP, "78872");
  assert.equal(view.land_project.project_id, MONITOR_POINT);
  const html = renderLegislativeMatterDocument(view, {
    currentHref: "/matters/78872/",
    today: "2026-09-06",
  });

  // Native links: an href the browser owns, so a modified click and the back
  // button behave exactly as they do everywhere else on the page.
  assert.match(html, /<a href="\/browse\/zoning\/#land\/2024K0358" data-council-land-project="2024K0358">Monitor Point \(2024K0358\)<\/a>/);
  assert.match(html, /<a href="\/matters\/78873\/" data-council-land-companion="78873">/);
  assert.match(html, /<a href="\/matters\/78874\/" data-council-land-companion="78874">/);
  assert.match(html, /data-council-land-companion-count="2"/);
  assert.match(html, /data-council-land-decision="false"/);
  assert.doesNotMatch(html, /data-council-land-project="2024K0358"[^>]*target=/);

  // The section is reachable and labelled for assistive technology, and it says
  // what the connection is and what it is not.
  assert.match(html, /<h2 id="matter-land-project">Land use project<\/h2>/);
  assert.match(html, /aria-labelledby="matter-land-project"/);
  assert.match(html, /same city application number, 260105ZMK/);
  assert.match(html, /not a decision on the project/);

  // One generation, stated on the page rather than implied.
  assert.match(html, new RegExp(`Land use project connections materialized at ${LOOKUP.generated_at}`));
});

test("an unjoined matter document renders no land use project section at all", () => {
  const view = buildLegislativeMatterDocument(MATTER_LOOKUP, RESEMBLING_TITLE_MATTER);
  assert.equal(view.land_project, null);
  const html = renderLegislativeMatterDocument(view, {
    currentHref: `/matters/${RESEMBLING_TITLE_MATTER}/`,
    today: "2026-09-06",
  });
  assert.ok(html.includes("Observed appearances"));
  assert.doesNotMatch(html, /matter-land-project/);
  assert.doesNotMatch(html, /Land use project/);
});

test("an unpublished matter is named without advertising a route that answers 404", () => {
  const items = councilLandMatterProjectItems(MONITOR_POINT, { published: ["78872"] });
  assert.deepEqual(items.map((item) => item.href), ["/matters/78872/", null, null]);
  const context = councilLandMatterContext("78872", { published: ["78872"] });
  assert.deepEqual(context.companions.map((companion) => companion.href), [null, null]);
  const view = buildLegislativeMatterDocument(MATTER_LOOKUP, "78872");
  const html = renderLegislativeMatterDocument(
    { ...view, land_project: { ...view.land_project, companions: context.companions } },
    { currentHref: "/matters/78872/", today: "2026-09-06" },
  );
  assert.match(html, /No other Council matter in this materialization names the same project application/);
  assert.doesNotMatch(html, /data-council-land-companion=/);
});

test("every published matter route in the lookup is a matter the generation publishes", () => {
  for (const matterId of Object.keys(LOOKUP.matters)) {
    assert.ok(MATTER_LOOKUP.matters[matterId], `matter ${matterId} must have a published history`);
  }
});
