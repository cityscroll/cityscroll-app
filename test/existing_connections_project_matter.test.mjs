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

const TITLE_STOPWORDS = new Set([
  "avenue", "ave", "street", "st", "rezoning", "zoning", "landmarks", "the", "of", "and",
  "boulevard", "road", "place", "amendment", "designation", "open", "space", "brooklyn",
  "queens", "bronx", "manhattan", "staten", "island", "park", "site", "selection",
  "acquisition", "north", "south", "east", "west", "walk",
]);

function significantWords(text) {
  return (text || "").toLowerCase().match(/[a-z]{4,}/g)?.filter((word) => !TITLE_STOPWORDS.has(word)) || [];
}

/**
 * The first (by project id, then matter id) published matter whose own title
 * shares a significant word with some joined project's published name, while
 * that matter is not among that project's own matter_ids — a genuine
 * resembling-title negative control rather than a chosen one.
 */
function findResemblingTitleCase() {
  const candidates = [];
  for (const [projectId, project] of Object.entries(LOOKUP.projects)) {
    const projectWords = new Set(significantWords(project.project_name));
    if (!projectWords.size) continue;
    for (const [matterId, matter] of Object.entries(MATTER_LOOKUP.matters)) {
      if (project.matter_ids.includes(matterId)) continue;
      if (significantWords(matter.title).some((word) => projectWords.has(word))) {
        candidates.push({ projectId, matterId });
      }
    }
  }
  candidates.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.matterId.localeCompare(b.matterId));
  if (!candidates.length) {
    throw new Error("no resembling-title negative-control pair found in the live catalog; pin one by hand");
  }
  return candidates[0];
}

// The three source-backed cases the published connection is expected to carry,
// and the two that must stay unjoined — each picked by rule against the
// currently live, committed data rather than a fixed id, since ordinary
// refresh churn keeps retiring whichever specific project or matter last
// demonstrated a given shape (a multi-matter project, a solo-matter project,
// a project with no retained application number, a matter whose own title
// resembles a joined project's name but is not that project's own matter).
const JOINED_PROJECTS_BY_MATTER_COUNT = Object.entries(LOOKUP.projects)
  .map(([projectId, project]) => ({ projectId, matterCount: project.matter_ids.length }))
  .sort((a, b) => a.projectId.localeCompare(b.projectId));
const MULTI_MATTER_PROJECTS = JOINED_PROJECTS_BY_MATTER_COUNT
  .filter((row) => row.matterCount >= 2)
  .map((row) => row.projectId);
const SOLO_MATTER_PROJECTS = JOINED_PROJECTS_BY_MATTER_COUNT
  .filter((row) => row.matterCount === 1)
  .map((row) => row.projectId);
const [MONITOR_POINT, RICHMOND_TERRACE] = MULTI_MATTER_PROJECTS;
const [WALK_TO_PARK] = SOLO_MATTER_PROJECTS;
const NO_APPLICATION_NUMBER_PROJECT = ZAP.rows
  .filter((row) => row.ulurp_numbers === null && !LOOKUP.projects[row.project_id])
  .map((row) => row.project_id)
  .sort()[0];

const ALL_JOINED_MATTER_IDS = new Set(Object.values(LOOKUP.projects).flatMap((project) => project.matter_ids));
const RESEMBLING_TITLE_CASE = findResemblingTitleCase();
const RESEMBLING_TITLE_PROJECT = RESEMBLING_TITLE_CASE.projectId;
const RESEMBLING_TITLE_MATTER = RESEMBLING_TITLE_CASE.matterId;
const NO_APPLICATION_NUMBER_MATTER = Object.keys(MATTER_LOOKUP.matters)
  .filter((matterId) => !ALL_JOINED_MATTER_IDS.has(matterId) && matterId !== RESEMBLING_TITLE_MATTER)
  .sort()[0];

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

test("Monitor Point exposes its own Council matters and each one returns", () => {
  const monitorPointMatters = matterIdsFor(MONITOR_POINT);
  assert.ok(monitorPointMatters.length >= 2, "the Monitor Point replacement must still carry multiple matters");
  for (const matterId of monitorPointMatters) {
    const context = councilLandMatterContext(matterId);
    assert.equal(context.project_id, MONITOR_POINT);
    assert.equal(context.project_href, `/browse/zoning/#land/${MONITOR_POINT}`);
    assert.deepEqual(
      context.companions.map((companion) => companion.matter_id).sort(),
      monitorPointMatters.filter((id) => id !== matterId),
    );
    for (const companion of context.companions) {
      assert.equal(companion.href, `/matters/${companion.matter_id}/`);
    }
  }
});

test("Richmond Terrace and Walk to Park expose their own retained matters", () => {
  const richmondMatters = matterIdsFor(RICHMOND_TERRACE);
  const walkMatters = matterIdsFor(WALK_TO_PARK);
  assert.ok(richmondMatters.length >= 2, "the Richmond Terrace replacement must still carry multiple matters");
  assert.equal(walkMatters.length, 1, "the Walk to Park replacement must still carry exactly one matter");
  assert.equal(councilLandMatterContext(richmondMatters[0]).project_id, RICHMOND_TERRACE);
  assert.deepEqual(
    councilLandMatterContext(richmondMatters[1]).companions.map((c) => c.matter_id),
    [richmondMatters[0]],
  );

  // One matter under one application is a complete connection, not a broken
  // one: the project link still resolves and the companion list is honestly
  // empty rather than padded.
  const solo = councilLandMatterContext(walkMatters[0]);
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
  // This matter's title shares a significant word with RESEMBLING_TITLE_PROJECT's
  // published name, but its application number is not in that project's
  // retained list.
  const resembling = MATTER_LOOKUP.matters[RESEMBLING_TITLE_MATTER];
  assert.ok(resembling, "the negative control must still be a published matter");
  const resemblingProjectName = LOOKUP.projects[RESEMBLING_TITLE_PROJECT].project_name;
  assert.ok(
    significantWords(resembling.title).some((word) => significantWords(resemblingProjectName).includes(word)),
    `${resembling.title} must still read like ${resemblingProjectName}`,
  );
  assert.equal(councilLandMatterContext(RESEMBLING_TITLE_MATTER), null);
  assert.ok(!matterIdsFor(RESEMBLING_TITLE_PROJECT).includes(RESEMBLING_TITLE_MATTER));

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

    // A missing vote stays missing; it never becomes a zero, an official, or a
    // disposition. Stated as that rule rather than as one generation's answer:
    // this corpus now retains a roll call on some matched records, and what the
    // lookup publishes is the retained count, or null where there is none.
    const retainedVotes = edge.council_depth.votes;
    if (retainedVotes === null) {
      assert.equal(appearance.named_votes, null, `matter ${matterId} invents no roll call`);
    } else {
      assert.equal(appearance.named_votes, retainedVotes.by_person.length);
      assert.equal(appearance.named_votes, retainedVotes.person_count);
      assert.ok(appearance.named_votes > 0, "a retained roll call is never published as zero");
    }
  }
  assert.equal(LOOKUP.relation.is_decision, false);
  assert.equal(LOOKUP.relation.canonical, "about_project");
  assert.equal(LOOKUP.relation.proceeding, "reviews_project");
});

test("the project group publishes the matters as a typed, non-deciding connection", () => {
  const monitorPointMatters = matterIdsFor(MONITOR_POINT);
  const evidence = buildProjectConnectionEvidence({
    projectId: MONITOR_POINT,
    projectRows: [{ project_id: MONITOR_POINT, project_name: LOOKUP.projects[MONITOR_POINT].project_name }],
    councilMatterRows: councilLandMatterProjectItems(MONITOR_POINT),
  });
  const group = evidence.groups.find((entry) => entry.id === "council_matters");
  assert.equal(group.relation, "about_project");
  assert.equal(group.status, "matched");
  assert.equal(group.gap, null);
  assert.deepEqual(group.items.map((item) => item.href), monitorPointMatters.map((id) => `/matters/${id}/`));
  for (const item of group.items) {
    assert.equal(item.is_decision, false);
    assert.equal(item.canonical_relation, "about_project");
    assert.equal(item.confidence, "strong");
    assert.match(item.evidence, /exact retained application number/);
    assert.match(item.label, /^LU \d{4}-\d{4} — /);
    assert.match(item.when, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(item.outcome, /Hearing Held by Committee/);
  }
});

test("a project the bridge did not join renders no connection furniture", () => {
  const noApplicationNumberProjectName = ZAP.rows.find((row) => row.project_id === NO_APPLICATION_NUMBER_PROJECT).project_name;
  const evidence = buildProjectConnectionEvidence({
    projectId: NO_APPLICATION_NUMBER_PROJECT,
    projectRows: [{ project_id: NO_APPLICATION_NUMBER_PROJECT, project_name: noApplicationNumberProjectName }],
    councilMatterRows: councilLandMatterProjectItems(NO_APPLICATION_NUMBER_PROJECT),
  });
  const group = evidence.groups.find((entry) => entry.id === "council_matters");
  assert.equal(group.status, "not_observed");
  assert.deepEqual(group.items, []);
  assert.equal(group.gap, "no_exact_council_matter_edge_in_bounded_corpus");
});

test("a joined matter document returns to its project and to its companions", () => {
  const [primaryMatter, ...companionMatters] = matterIdsFor(MONITOR_POINT);
  const projectName = LOOKUP.projects[MONITOR_POINT].project_name;
  const view = buildLegislativeMatterDocument(MATTER_LOOKUP, primaryMatter);
  assert.equal(view.land_project.project_id, MONITOR_POINT);
  const html = renderLegislativeMatterDocument(view, {
    currentHref: `/matters/${primaryMatter}/`,
    today: "2026-09-06",
  });

  // Native links: an href the browser owns, so a modified click and the back
  // button behave exactly as they do everywhere else on the page.
  assert.match(html, new RegExp(`<a href="/browse/zoning/#land/${MONITOR_POINT}" data-council-land-project="${MONITOR_POINT}">${projectName} \\(${MONITOR_POINT}\\)</a>`));
  for (const companion of companionMatters) {
    assert.match(html, new RegExp(`<a href="/matters/${companion}/" data-council-land-companion="${companion}">`));
  }
  assert.match(html, new RegExp(`data-council-land-companion-count="${companionMatters.length}"`));
  assert.match(html, /data-council-land-decision="false"/);
  assert.doesNotMatch(html, new RegExp(`data-council-land-project="${MONITOR_POINT}"[^>]*target=`));

  // The section is reachable and labelled for assistive technology, and it says
  // what the connection is and what it is not.
  assert.match(html, /<h2 id="matter-land-project">Land use project<\/h2>/);
  assert.match(html, /aria-labelledby="matter-land-project"/);
  assert.match(html, new RegExp(`same city application number, ${view.land_project.join.value}`));
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
  const [primaryMatter, ...companionMatters] = matterIdsFor(MONITOR_POINT);
  const items = councilLandMatterProjectItems(MONITOR_POINT, { published: [primaryMatter] });
  assert.deepEqual(items.map((item) => item.href), [`/matters/${primaryMatter}/`, ...companionMatters.map(() => null)]);
  const context = councilLandMatterContext(primaryMatter, { published: [primaryMatter] });
  assert.deepEqual(context.companions.map((companion) => companion.href), companionMatters.map(() => null));
  const view = buildLegislativeMatterDocument(MATTER_LOOKUP, primaryMatter);
  const html = renderLegislativeMatterDocument(
    { ...view, land_project: { ...view.land_project, companions: context.companions } },
    { currentHref: `/matters/${primaryMatter}/`, today: "2026-09-06" },
  );
  assert.match(html, /No other Council matter in this materialization names the same project application/);
  assert.doesNotMatch(html, /data-council-land-companion=/);
});

test("every published matter route in the lookup is a matter the generation publishes", () => {
  for (const matterId of Object.keys(LOOKUP.matters)) {
    assert.ok(MATTER_LOOKUP.matters[matterId], `matter ${matterId} must have a published history`);
  }
});
