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
import { AGENCY_CONSTELLATION_SECTIONS } from "../site/agency_constellation_section_registry.mjs";
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

test("section registry composes every capability in stable order", () => {
  assert.deepEqual(
    AGENCY_CONSTELLATION_SECTIONS.map(({ id, order }) => [id, order]),
    [
      ["as-of", 0],
      ["mandate-predictions", 10],
      ["mandate-reports", 20],
      ["mandate-rules", 30],
      ["mandate-meetings", 35],
      ["mandate-contracts", 36],
      ["mandate-land-use", 37],
      ["contracts", 40],
      ["meetings", 50],
      ["rules", 60],
      ["obligations", 70],
      ["staffing", 80],
      ["provenance", 90],
    ],
  );
  for (const section of AGENCY_CONSTELLATION_SECTIONS) {
    assert.equal(typeof section.render, "function", `${section.id} exposes render(view)`);
  }
});

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
  assert.match(html, /class="ui-constellation-link agency-edge-link"/);
  assert.match(html, /class="ui-official-source-link agency-source-link"/);
  assert.match(html, /Watch this agency across City Record/);
  assert.match(html, /Watch mandates and deadlines/);
  assert.match(html, /Mandates · expected vs observed|Statutory mandates/);
  assert.match(html, /rel="canonical" href="https:\/\/cityscroll\.org\/agencies\/parks-and-recreation\//);
  assert.doesNotMatch(html, /civil-service certification|provenance inspector/i);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("Parks edges carry real provenance and a shareable why-inspector", () => {
  const view = buildAgencyConstellationView(PARKS, { intelligence, certification });
  assert.ok(view.claims.length >= 4);

  const contracts = view.categories.find((category) => category.id === "contracts");
  const sample = contracts.items[0];
  assert.ok(sample.claim, "each linked item gets a claim");
  assert.equal(sample.claim.how.warrant_class, "exact");
  assert.equal(sample.claim.confidence.standable, true);
  assert.ok(sample.provenance?.source_record_id || sample.claim.where.source_record_id.available);
  assert.match(sample.claim.inspect_href, /\/agencies\/parks-and-recreation\/\?claim=/);

  const staffing = view.categories.find((category) => category.id === "staffing");
  assert.equal(staffing.items[0].claim.how.warrant_class, "exact");
  assert.ok(
    staffing.items[0].provenance?.input_value
      || staffing.items[0].claim.where.input_value.available,
  );

  const claimId = sample.claim.claim_id;
  const html = renderAgencyConstellationDocument(view, { activeClaimId: claimId });
  assert.match(html, /Why do we believe this\?/); // inspector header only when a claim is open
  assert.match(html, /data-edge-provenance-panel/);
  assert.match(html, /data-warrant-class="exact"/);
  assert.match(html, /edge-prov-token/);
  assert.match(html, />exact</);
  assert.doesNotMatch(html, /Why do we believe this\? · Exact/);
  assert.doesNotMatch(html, /How links are warranted/);
  assert.doesNotMatch(html, /Sources and limits/);
  assert.doesNotMatch(html, /Confidence is not identity/i);
  assert.doesNotMatch(html, /not a confirmed identity|not counted as a verified/i);
  assert.match(html, new RegExp(`data-edge-claim="${claimId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.doesNotMatch(html, /Not yet attached|How it was derived|Joined by an exact publisher key/i);
  assert.match(html, /Share this claim/);
  assert.match(html, new RegExp(`claim=${encodeURIComponent(claimId).replace(/%/g, "%")}`));
  assert.doesNotMatch(html, /fabricat/i);
});

test("tentative edges stay off the public list rather than shipping with hedges", () => {
  const view = buildAgencyConstellationView(PARKS, {
    intelligence: {
      by_ref: {
        "agency:id:parks-and-recreation": {
          domains: {
            money: {
              status: "matched",
              count: 2,
              objects: [
                {
                  subject_ref: "notice:strong1",
                  request_id: "strong1",
                  label: "Strong award",
                  when: "2026-01-01",
                  link_type: "published_by_agency",
                  confidence: "strong",
                  method: "agency_canonical_v1",
                  provenance: {
                    source_system: "city_record",
                    source_record_id: "city_record:strong1",
                    source_fields: ["agency_name"],
                    basis: "money_agency_name",
                    input_value: "Parks and Recreation",
                  },
                },
                {
                  subject_ref: "notice:maybe1",
                  request_id: "maybe1",
                  label: "Possible award",
                  when: "2026-01-02",
                  link_type: "published_by_agency",
                  confidence: "tentative",
                  method: "agency_canonical_v1",
                  provenance: {
                    source_system: "city_record",
                    source_record_id: "city_record:maybe1",
                    source_fields: ["agency_name"],
                    basis: "money_agency_name",
                    input_value: "Parks Dept approx",
                  },
                },
              ],
            },
          },
        },
      },
    },
    certification: { edges: [], by_agency: [], by_exam: [] },
  });
  const contracts = view.categories.find((category) => category.id === "contracts");
  assert.equal(contracts.items.length, 1);
  assert.equal(contracts.items[0].id, "strong1");
  assert.equal(contracts.warrant_summary.standable_total, 1);
  assert.equal(contracts.warrant_summary.possible_total, 0);
  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /1 linked/);
  assert.doesNotMatch(html, /not verified/i);
  assert.doesNotMatch(html, /maybe1|Possible award/);
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
