import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AGENCY_CONSTELLATION_CATEGORIES,
  AGENCY_CONSTELLATION_ER_BASIS,
  agencyCategoryArchiveHref,
  agencyCategoryBrowseHref,
  agencyConstellationFollowHref,
  agencyPath,
  agencySubjectRef,
  buildAgencyEdgeSummary,
  buildAgencyConstellationView,
  constellationObjectHref,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import {
  addDerivedFeatureObservation,
  createDerivedFeatureRollup,
  finalizeDerivedFeatureRollup,
} from "../site/derived_feature_rollup.mjs";
import { AGENCY_CONSTELLATION_SECTIONS } from "../site/agency_constellation_section_registry.mjs";
import { reconcileAgencyIdentity, resolveAgencyIdentity } from "../site/agency_identity.mjs";
import { AGENCY_ROUTE_CLASSIFICATIONS } from "../tools/lib/agency_route_classifications.mjs";
import { agencyPublisherCollisions, publisherAgencyRows } from "../tools/lib/agency_publisher_crosswalk.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";
import * as CrolScope from "../site/scope_v0.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const intelligence = JSON.parse(
  readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"),
);
const certification = JSON.parse(
  readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8"),
);
const staffingExams = JSON.parse(
  readFileSync(join(ROOT, "site/data/staffing_exams.json"), "utf8"),
);
const obligations = existsSync(join(ROOT, "site/data/agency_obligations_lookup.json"))
  ? JSON.parse(readFileSync(join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8"))
  : null;
const publisherCrosswalk = JSON.parse(
  readFileSync(join(ROOT, "worker/src/data/agency_crosswalk.json"), "utf8"),
);
const publisherRows = publisherAgencyRows(publisherCrosswalk);

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
      ["vendors", 41],
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

test("publisher reconciliation retains every exact source spelling and fails closed on collisions", () => {
  for (const row of publisherRows) {
    const identity = reconcileAgencyIdentity(row.canonical_id, publisherRows);
    for (const variant of row.variants) {
      assert.ok(identity.variants.includes(variant), `${row.canonical_id} retains ${variant}`);
    }
  }
  const collisions = agencyPublisherCollisions(publisherRows);
  assert.ok(collisions.some((row) => row.comparison_key === "EQUAL EMPLOYMENT PRACTICES COMMISSION"));
  const ambiguous = reconcileAgencyIdentity("Equal Employment Practices Commission", publisherRows);
  assert.equal(ambiguous.matched, false);
});

test("Office of the Mayor meeting-name variants resolve to one canonical agency", () => {
  for (const variant of ["Mayor's Office", "Office of the Mayor", "OFFICE OF THE MAYOR"]) {
    const identity = resolveAgencyIdentity(variant);
    assert.equal(identity.canonical_id, "office-of-the-mayor");
    assert.equal(identity.canonical_name, "Office of the Mayor");
  }
  const crosswalk = publisherRows.find((row) => row.canonical_id === "office-of-the-mayor");
  assert.ok(crosswalk, "Office of the Mayor must remain in the publisher crosswalk");
  assert.deepEqual(
    ["Mayor's Office", "Office of the Mayor", "OFFICE OF THE MAYOR"].map((variant) => crosswalk.variants.includes(variant)),
    [true, true, true],
  );
});

test("all reviewed constellation-only routes have an explicit non-fuzzy disposition", () => {
  assert.equal(AGENCY_ROUTE_CLASSIFICATIONS.length, 20);
  assert.deepEqual(
    Object.fromEntries(["alias_to_canonical", "legitimate_non_crosswalk_entity", "unresolved"]
      .map((classification) => [
        classification,
        AGENCY_ROUTE_CLASSIFICATIONS.filter((row) => row.classification === classification).length,
      ])),
    { alias_to_canonical: 15, legitimate_non_crosswalk_entity: 4, unresolved: 1 },
  );
});

test("Parks constellation spans contracts, meetings, rules, obligations, and staffing", () => {
  const view = buildAgencyConstellationView(PARKS, {
    intelligence,
    certification,
    obligations,
    staffing_exams: staffingExams,
  });
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
  // Staffing count is document-backed only — never the raw certification edge total.
  const documentable = new Set(
    (staffingExams.exams || []).map((exam) => String(exam.exam_number || "").trim()).filter(Boolean),
  );
  assert.ok(byId.staffing.count <= documentable.size);
  for (const item of byId.staffing.items) {
    assert.ok(documentable.has(String(item.id)), `staffing item ${item.id} must be document-backed`);
  }
  assert.equal(view.summary.matched_categories, 5);
  assert.equal(view.summary.er_match_basis, AGENCY_CONSTELLATION_ER_BASIS);
  assert.equal(view.summary.iteration, "v1");
});

test("derived feature rollups accumulate counts, spans, lifecycle, and freshness incrementally", () => {
  const accumulator = createDerivedFeatureRollup({
    totalCount: 3,
    referenceDay: "2026-08-15",
    maxAgeDays: 2,
  });
  addDerivedFeatureObservation(accumulator, {
    id: "one",
    date: "2026-08-10",
    observed_at: "2026-08-11",
    status: "open",
    relation: "hosts_meeting",
  }, { state: "matched" });
  addDerivedFeatureObservation(accumulator, {
    id: "two",
    date: "2026-08-14",
    observed_at: "2026-08-14",
    status: "closed",
    relation: "hosts_meeting",
  }, { state: "matched" });
  // A repeated graph delivery must not inflate the incremental result.
  addDerivedFeatureObservation(accumulator, {
    id: "two",
    date: "2026-08-14",
    status: "closed",
  });

  const rollup = finalizeDerivedFeatureRollup(accumulator);
  assert.equal(rollup.counts.total, 3);
  assert.equal(rollup.counts.materialized, 2);
  assert.equal(rollup.counts.dated, 2);
  assert.equal(rollup.lifecycle.by_bucket.current, 1);
  assert.equal(rollup.lifecycle.by_bucket.historical, 1);
  assert.equal(rollup.lifecycle.complete, false);
  assert.deepEqual(rollup.spans.valid, { start: "2026-08-10", end: "2026-08-14" });
  assert.deepEqual(rollup.spans.observed, { start: "2026-08-11", end: "2026-08-14" });
  assert.equal(rollup.freshness.latest_day, "2026-08-14");
  assert.equal(rollup.freshness.age_days, 1);
  assert.equal(rollup.freshness.status, "fresh");

  const view = buildAgencyConstellationView(PARKS, { intelligence, certification });
  assert.equal(view.derived_feature_rollup.schema, "cityscroll.derived_feature_rollup.v1");
  assert.ok(view.categories.every((category) => category.derived_feature_rollup));
  const edges = buildAgencyEdgeSummary(view);
  assert.ok(edges.every((edge) => edge.derived_feature_rollup));
});

test("agency previews and Browse destinations share open/linked totals and snapshot dates", () => {
  const moneyOpen = {
    open_as_of: "2026-08-11",
    notices: Array.from({ length: 10 }, (_, index) => ({
      request_id: `police-contract-${index + 1}`,
      agency_name: "Police Department",
      entity_refs_all: ["agency:id:police-department"],
      short_title: `Open police service ${index + 1}`,
      type_of_notice_description: "Solicitation",
      due_date: `2026-09-${String(index + 10).padStart(2, "0")}`,
      start_date: "2026-08-01",
    })),
  };
  const meetingsDomain = {
    retrieved_at: "2026-08-11",
    rows: Array.from({ length: 3 }, (_, index) => ({
      request_id: `police-meeting-${index + 1}`,
      agency_name: "Police Department",
      entity_refs_all: ["agency:id:police-department"],
      title: `Police public hearing ${index + 1}`,
      type_of_notice_description: "Public Hearing",
      event_date: `2026-09-${String(index + 10).padStart(2, "0")}`,
    })),
  };
  const view = buildAgencyConstellationView("police-department", {
    intelligence,
    certification,
    obligations,
    staffing_exams: staffingExams,
    money_open: moneyOpen,
    meetings_domain: meetingsDomain,
  });
  const byId = Object.fromEntries(view.categories.map((category) => [category.id, category]));

  assert.equal(byId.contracts.count, 10);
  assert.equal(byId.contracts.total_count, 10);
  assert.equal(byId.contracts.items.length, 8);
  assert.equal(byId.contracts.as_of, "2026-08-11");
  assert.equal(byId.contracts.universe, "open");
  assert.match(byId.contracts.view_all_href, /connection_relation/);
  assert.match(byId.contracts.view_all_href, /mode=open/);
  assert.match(byId.contracts.view_all_href, /as_of=2026-08-11/);
  assert.match(agencyCategoryArchiveHref("police-department", "contracts"), /mode=archive/);

  assert.equal(byId.meetings.count, 3);
  assert.equal(byId.meetings.total_count, 3);
  assert.equal(byId.meetings.items.length, 3);
  assert.equal(byId.meetings.as_of, "2026-08-11");
  assert.equal(byId.meetings.universe, "linked");
  assert.match(byId.meetings.view_all_href, /connection_relation/);
  assert.match(byId.meetings.view_all_href, /as_of=2026-08-11/);

  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /Showing 8 of 10 open/);
  assert.match(html, /data-total-count="10"/);
  assert.match(html, /Open records as of 2026-08-11/);
  assert.match(html, /Browse archived awards and contracts/);
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
    assert.equal(category.note, null);
  }
  const html = renderAgencyConstellationDocument(view);
  // Empty families stay in the model for logic, but do not occupy the reader surface.
  assert.equal((html.match(/data-agency-constellation-category=/g) || []).length, 0);
  assert.doesNotMatch(html, /data-edge-state="empty"|No meetings or hearings linked yet/);
  assert.doesNotMatch(html, /Empty in this scoped materialization|current materialization|none in this materialization/i);
  assert.doesNotMatch(html, /not yet shown/i);
  assert.doesNotMatch(html, /fabricat/i);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("rendered document is a parcel-shaped civic object with ER basis stamp", () => {
  const view = buildAgencyConstellationView(PARKS, {
    intelligence,
    certification,
    obligations,
    staffing_exams: staffingExams,
  });
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
  assert.doesNotMatch(html, /id="mandates-conformance"/);
  assert.match(html, /data-agency-constellation-category="staffing"/);
  assert.match(html, /class="ui-constellation-link agency-edge-link"/);
  assert.match(html, /class="ui-official-source-link agency-source-link"/);
  assert.match(html, /Get updates about this agency&#39;s public records/);
  assert.match(html, /Watch mandates and deadlines/);
  const actionNav = html.match(/<nav class="node-actions civic-object-actions"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.doesNotMatch(actionNav, /href="#edge-provenance"/);
  assert.match(html, /class="ui-constellation-link agency-pivot-link" href="#edge-provenance"/);
  assert.match(html, /main:not\(:has\(#mandates-conformance\)\) a\[href\$="#mandates-conformance"\]/);
  assert.match(html, /rel="canonical" href="https:\/\/cityscroll\.org\/agencies\/parks-and-recreation\//);
  assert.doesNotMatch(html, /civil-service certification|provenance inspector/i);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("Parks edges carry real provenance and a shareable why-inspector", () => {
  const view = buildAgencyConstellationView(PARKS, {
    intelligence,
    certification,
    staffing_exams: staffingExams,
  });
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
  assert.doesNotMatch(html, /Why do we believe this\?/);
  assert.match(html, /data-edge-provenance-panel/);
  assert.match(html, /data-warrant-class="exact"/);
  assert.match(html, /edge-prov-confidence-unmatched/);
  assert.match(html, /Matched by a published record/);
  assert.doesNotMatch(html, /edge-prov-token|Why do we believe this\? · Exact/);
  assert.doesNotMatch(html, /How links are warranted/);
  assert.doesNotMatch(html, /Sources and limits/);
  assert.doesNotMatch(html, /Confidence is not identity/i);
  assert.doesNotMatch(html, /not a confirmed identity|not counted as a verified/i);
  assert.match(html, new RegExp(`data-edge-claim="${claimId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.doesNotMatch(html, /Not yet attached|How it was derived|Joined by an exact publisher key/i);
  assert.match(html, /Copy link to this connection/);
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
  const readerHtml = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  assert.doesNotMatch(readerHtml, /not verified/i);
  assert.doesNotMatch(html, /maybe1|Possible award/);
});

test("public mandate totals count only standable constellation links", () => {
  const view = buildAgencyConstellationView(PARKS, {
    intelligence,
    certification,
    obligations,
    staffing_exams: staffingExams,
  });
  const mandates = view.categories.find((category) => category.id === "obligations");
  const source = obligations.by_agency[PARKS];
  const certified = source.obligations.filter((row) =>
    row.quote_verified || row.certification?.quote_verified || row.certification?.status === "auto_certified");

  assert.ok(source.count > certified.length, "fixture retains provisional quote-miss rows");
  assert.equal(mandates.count, certified.length);
  assert.equal(mandates.warrant_summary.verified_total, certified.length);
  assert.equal(mandates.items.every((item) => item.claim?.confidence?.standable), true);
});

test("constellationObjectHref prefers notice documents over SPA hash routes", () => {
  assert.equal(
    constellationObjectHref({
      request_id: "20260724010",
      subject_ref: "notice:20260724010",
      href: "#notice/20260724010",
      label: "Heat Pump Water Heaters",
    }),
    "/notices/20260724010",
  );
  assert.equal(
    constellationObjectHref({
      subject_ref: "notice:20210917109",
      href: "#notice/20210917109",
      label: "Award notice",
    }),
    "/notices/20210917109",
  );
  // Exam paths already document-shaped; leave them alone.
  assert.equal(
    constellationObjectHref({
      subject_ref: "exam:7016",
      href: "/exams/7016/",
      label: "Caseworker",
    }),
    "/exams/7016/",
  );
});

test("constellationObjectHref links contract rows without a notice to the vendor profile", () => {
  assert.equal(
    constellationObjectHref({
      object_kind: "contract",
      subject_ref: "contract:MA1-857-20228801961",
      contract_id: "MA1-857-20228801961",
      label: "QUADIENT INC",
      href: null,
      provenance: { source_system: "passport-public-contracts" },
    }),
    "/vendors/QUADIENT/",
  );
  assert.equal(
    constellationObjectHref({
      object_kind: "contract",
      subject_ref: "contract:MA1-857-20220000136",
      contract_id: "MA1-857-20220000136",
      label: "T MINA SUPPLY LLC",
      href: null,
    }),
    "/vendors/T%20MINA%20SUPPLY/",
  );
  // Null remains null when there is no notice and no firm name to route.
  assert.equal(
    constellationObjectHref({
      object_kind: "contract",
      subject_ref: "contract:CT-unknown",
      label: null,
      href: null,
    }),
    null,
  );
});

test("agency contracts render document notice links and vendor links for passport rows", () => {
  const view = buildAgencyConstellationView("citywide-administrative-services", {
    intelligence: {
      by_ref: {
        "agency:id:citywide-administrative-services": {
          domains: {
            money: {
              status: "matched",
              count: 2,
              objects: [
                {
                  subject_ref: "notice:20260724010",
                  request_id: "20260724010",
                  object_kind: "award",
                  label: "Heat Pump Water Heaters",
                  when: "2026-07-30",
                  href: "#notice/20260724010",
                  link_type: "published_by_agency",
                  confidence: "strong",
                  method: "agency_canonical_v1",
                  provenance: {
                    source_system: "ocp-recent-contract-awards",
                    source_record_id: "ocp:20260724010",
                    source_fields: ["agency_name"],
                    basis: "money_agency_name",
                    input_value: "Citywide Administrative Services",
                  },
                },
                {
                  subject_ref: "contract:MA1-857-20228801961",
                  object_kind: "contract",
                  contract_id: "MA1-857-20228801961",
                  label: "QUADIENT INC",
                  when: "12/16/2021",
                  href: null,
                  link_type: "published_by_agency",
                  confidence: "strong",
                  method: "agency_canonical_v1",
                  provenance: {
                    source_system: "passport-public-contracts",
                    source_record_id: "passport:MA1-857-20228801961",
                    source_fields: ["agency_name"],
                    basis: "money_agency_name",
                    input_value: "Citywide Administrative Services",
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
  assert.equal(contracts.items.length, 2);
  const noticeItem = contracts.items.find((item) => item.id === "20260724010");
  const contractItem = contracts.items.find((item) => item.subject_ref === "contract:MA1-857-20228801961");
  assert.equal(noticeItem.href, "/notices/20260724010");
  assert.equal(contractItem.href, "/vendors/QUADIENT/");
  assert.equal(noticeItem.claim.object_href, "/notices/20260724010");
  assert.equal(contractItem.claim.object_href, "/vendors/QUADIENT/");

  const html = renderAgencyConstellationDocument(view);
  assert.match(
    html,
    /class="ui-constellation-link agency-edge-link" href="\/notices\/20260724010"[^>]*>[\s\S]*?Heat Pump Water Heaters/,
  );
  assert.doesNotMatch(html, /agency-edge-link" href="#notice\/20260724010"/);
  assert.match(
    html,
    /class="ui-constellation-link agency-edge-link" href="\/vendors\/QUADIENT\/"[^>]*>[\s\S]*?QUADIENT INC/,
  );
  // Exact warrant tokens stay claim inspectors, not the object destination.
  assert.match(html, /edge-prov-why[\s\S]*?claim=contracts%3Anotice%3A20260724010/);
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
  assert.equal(lookup.aliases["n-y-c-housing-authority"], "housing-authority");
  assert.equal(lookup.by_id["n-y-c-housing-authority"], undefined);
  assert.equal(lookup.by_id["housing-authority"].subject_ref, "agency:id:housing-authority");

  const report = JSON.parse(readFileSync(join(ROOT, "site/data/agency_route_identity_report.json"), "utf8"));
  assert.equal(report.constellation_only_source_count, 22);
  assert.deepEqual(report.classification_counts, {
    alias_to_canonical: 15,
    legitimate_non_crosswalk_entity: 4,
    unresolved: 3,
  });
  assert.equal(report.cases.length, 22);
  assert.ok(report.cases.every((row) => row.classification && row.basis));
});
