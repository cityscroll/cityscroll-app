import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AGENCY_CONSTELLATION_CATEGORIES,
  AGENCY_CONSTELLATION_ER_BASIS,
  agencyCategoryBrowseHref,
  agencyConstellationFollowHref,
  agencyPath,
  agencySubjectRef,
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";
import * as CrolScope from "../site/scope_v0.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const intelligence = JSON.parse(
  readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"),
);
const certification = JSON.parse(
  readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8"),
);
const obligations = existsSync(join(ROOT, "site/data/agency_obligations_lookup.json"))
  ? JSON.parse(readFileSync(join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8"))
  : null;

const PARKS = "parks-and-recreation";

test("agency path and subject ref are stable", () => {
  assert.equal(agencyPath(PARKS), "/agencies/parks-and-recreation/");
  assert.equal(agencySubjectRef(PARKS), "agency:id:parks-and-recreation");
  assert.equal(agencySubjectRef("Parks and Recreation"), "agency:id:parks-and-recreation");
});

test("Parks constellation spans contracts, meetings, rules, obligations, and staffing", () => {
  const view = buildAgencyConstellationView(PARKS, { intelligence, certification, obligations });
  assert.equal(view.kind, "agency-constellation");
  assert.equal(view.subject_ref, "agency:id:parks-and-recreation");
  assert.equal(view.display_name, "Parks and Recreation");
  assert.deepEqual(
    view.categories.map((category) => category.id),
    AGENCY_CONSTELLATION_CATEGORIES.map((category) => category.id),
  );

  const byId = Object.fromEntries(view.categories.map((category) => [category.id, category]));
  assert.equal(byId.contracts.status, "matched");
  assert.ok(byId.contracts.count >= 1);
  assert.ok(byId.contracts.items.length >= 1);
  assert.equal(byId.meetings.status, "matched");
  assert.equal(byId.rules.status, "matched");
  assert.equal(byId.obligations.status, "matched");
  assert.ok(byId.obligations.count >= 1);
  assert.equal(byId.staffing.status, "matched");
  assert.ok(byId.staffing.count >= 1);
  assert.ok(byId.staffing.items.length >= 1);
  assert.equal(byId.staffing.method, "publisher_certification_record_v1");
  assert.equal(view.summary.matched_categories, 5);
  assert.equal(view.summary.er_match_basis, AGENCY_CONSTELLATION_ER_BASIS);
  assert.equal(view.summary.iteration, "v1");
});

test("agency scope carries across category browse URLs", () => {
  const contracts = agencyCategoryBrowseHref(PARKS, "contracts");
  const meetings = agencyCategoryBrowseHref(PARKS, "meetings");
  const rules = agencyCategoryBrowseHref(PARKS, "rules");
  const staffing = agencyCategoryBrowseHref(PARKS, "staffing");

  assert.match(contracts, /^\/browse\/contracts\//);
  assert.match(meetings, /^\/browse\/meetings\//);
  assert.match(rules, /^\/browse\/rules\//);
  assert.match(staffing, /^\/browse\/staffing\//);

  for (const href of [contracts, meetings, rules, staffing]) {
    const url = new URL(href, "https://cityscroll.org");
    const facet = JSON.parse(url.searchParams.get("facet") || "{}");
    assert.deepEqual(facet.entity_refs_all, ["agency:id:parks-and-recreation"]);
  }

  const scope = CrolScope.scopeFromRouteHash(
    `#money?${new URL(contracts, "https://cityscroll.org").search.slice(1)}`,
  );
  assert.deepEqual(scope.facets.values.entity_refs_all, ["agency:id:parks-and-recreation"]);
});

test("follow URLs are shareable entity/agency watches", () => {
  const href = agencyConstellationFollowHref(PARKS);
  assert.match(href, /\/following/);
  assert.match(href, /lens=entity/);
  assert.match(href, /Parks/);
});

test("empty categories stay honest and never invent items", () => {
  const view = buildAgencyConstellationView("campaign-finance-board", {
    intelligence: { by_ref: {}, generated_at: "test" },
    certification: { edges: [], by_agency: [], by_exam: [], generated_at: "test" },
    obligations: { by_agency: {}, generated_at: "test" },
  });
  assert.equal(view.summary.matched_categories, 0);
  for (const category of view.categories) {
    assert.equal(category.status, "empty");
    assert.equal(category.items.length, 0);
    assert.ok(category.note);
  }
  const html = renderAgencyConstellationDocument(view);
  // Empty categories are omitted from the reader surface (no absence disclaimers).
  assert.doesNotMatch(html, /data-agency-constellation-category=/);
  assert.doesNotMatch(html, /none in this materialization/i);
  assert.doesNotMatch(html, /not yet shown/i);
  assert.doesNotMatch(html, /fabricat/i);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("rendered document is a parcel-shaped civic object with ER basis stamp", () => {
  const view = buildAgencyConstellationView(PARKS, { intelligence, certification, obligations });
  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /data-civic-object-kind="agency-constellation"/);
  assert.match(html, /data-subject-ref="agency:id:parks-and-recreation"/);
  // Machine ER basis stays on a data attribute, not as reader-facing copy.
  assert.match(html, /data-er-match-basis="/);
  assert.doesNotMatch(html, /Match basis for this iteration/);
  assert.doesNotMatch(html, /Materialization methods:/i);
  assert.match(html, /data-agency-constellation-category="contracts"/);
  assert.match(html, /data-agency-constellation-category="meetings"/);
  assert.match(html, /data-agency-constellation-category="rules"/);
  assert.match(html, /data-agency-constellation-category="obligations"/);
  assert.match(html, /data-agency-constellation-category="staffing"/);
  assert.match(html, /Watch this agency across City Record/);
  assert.match(html, /rel="canonical" href="https:\/\/cityscroll\.org\/agencies\/parks-and-recreation\//);
  assert.match(html, /entity-intelligence lookup/);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("lookup materialization includes Parks multi-category demo when built", () => {
  const path = join(ROOT, "site/data/agency_constellation_lookup.json");
  if (!existsSync(path)) {
    // Build may not have run yet in pure unit environments; model coverage above is enough.
    return;
  }
  const lookup = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(lookup.verified_demo, "agency:id:parks-and-recreation");
  assert.ok(lookup.by_id[PARKS]);
  assert.ok(lookup.by_id[PARKS].matched_categories >= 3);
});
