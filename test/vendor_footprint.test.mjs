import assert from "node:assert/strict";
import test from "node:test";

import { buildVendorFootprintCoverage } from "../tools/lib/entity_intelligence_build.mjs";
import { vendorCoverageKey } from "../entity_resolution/cross_domain/vendor_coverage_key.mjs";
import {
  renderVendorFootprintHTML,
  vendorAgencyIntersectionHref,
  vendorFootprintModel,
  vendorFootprintScopeHref,
} from "../site/vendor_footprint.mjs";
import { pivotDestinationCompatibility } from "../site/pivot_destination_compatibility.mjs";
import { scopeFromRouteHash } from "../site/scope_v0.mjs";

const REF = "vendor:stem:ACME";

test("coverage reverse-index keys are stable and do not expose vendor refs", () => {
  const key = vendorCoverageKey(REF);
  assert.equal(key, vendorCoverageKey(REF));
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.doesNotMatch(key, /ACME/);
});

function fixtureDoc() {
  return {
    entities: [{ root: { kind: "vendor", ref: REF }, metrics: { domains_matched: 1 } }],
    by_ref: {
      [REF]: {
        root: { kind: "vendor", ref: REF, display_name: "Acme" },
        domains: {
          money: {
            objects: [
              { object_kind: "award", request_id: "1", confidence: "strong" },
              { object_kind: "award", request_id: "2", confidence: "tentative" },
              { object_kind: "payment", request_id: "pay-1", confidence: "strong" },
            ],
          },
        },
      },
    },
  };
}

test("build derives award coverage from the full snapshot aggregate, not the bounded graph", () => {
  const coverage = buildVendorFootprintCoverage(fixtureDoc(), {
    dataset_id: "awards",
    materialized_at: "2026-08-05T00:00:00Z",
    row_count: 3,
    rows: [
      { request_id: "1", vendor_name: "Acme Inc." },
      { request_id: "2", vendor_name: "ACME LLC" },
      { request_id: "3", vendor_name: "Elsewhere Corp." },
      { request_id: "4", vendor_name: null },
    ],
  }, {
    quality_review: {
      accepted_pair_candidates_reviewed: 45,
      confirmed_false_positives: 0,
      unreviewed_residual: "This does not support a full-corpus precision claim.",
    },
  });

  assert.deepEqual(coverage.awards_by_ref[REF], {
    linked: 2,
    eligible: 2,
    rate: 1,
    label: "showing 2 of 2 known awards linked so far (100%)",
  });
  assert.equal(coverage.summary.known_awards, 4);
  assert.equal(coverage.summary.named_awards, 3);
  assert.equal(coverage.summary.linked_awards, 3);
  assert.equal(coverage.summary.award_linkage_rate, 0.75);
  assert.equal(coverage.summary.vendor_roots, 2);
  assert.deepEqual(coverage.census.survival, {
    observed: 4,
    normalized: 3,
    blocked: 1,
    scored: 3,
    published: 3,
  });
  assert.deepEqual(coverage.census.blockers, {
    missing_vendor_name: 1,
    empty_vendor_stem: 0,
    missing_request_id: 0,
  });
  assert.equal(coverage.census.no_name_floor.label, "25.00% of snapshot rows have no vendor name");
  assert.equal(coverage.qualifier_required, true);
  assert.equal(coverage.promotion.gates.precision_review.passed, false);
  assert.deepEqual(coverage.excluded_confidence, ["tentative", "review_only", "not_scored"]);
});

test("population-backed procurement spine publishes a separate multi-kind census", () => {
  const coverage = buildVendorFootprintCoverage(
    fixtureDoc(),
    { row_count: 4, rows: [{ request_id: "1", vendor_name: "Acme Inc." }] },
    {},
    {
      observed_on: "2026-08-06",
      coverage: {
        passport_contracts: {
          award_corroboration: { vendor_roots: 1, rate: 0.5 },
          section_denominator: { status: "measured", rows: 2, source_population: 10 },
        },
      },
    },
  );

  assert.equal(coverage.summary.multi_kind_vendor_roots, 1);
  assert.equal(coverage.summary.multi_kind_vendor_rate, 0.5);
  assert.equal(coverage.summary.section_denominators.contracts.status, "measured");
  assert.equal(coverage.promotion.gates.section_denominator_rate.actual, 0.25);
  assert.equal(coverage.provenance.procurement_spine_observed_on, "2026-08-06");
});

test("vendor footprint renders populated groups and strong objects only", () => {
  const response = {
    ok: true,
    root: { kind: "vendor", ref: REF, display_name: "Acme & Co." },
    domains: {
      money: {
        objects: [
          { object_kind: "award", request_id: "1", confidence: "strong", label: "Strong award", href: "#notice/1" },
          { object_kind: "award", request_id: "2", confidence: "tentative", label: "Weak candidate", href: "#notice/2" },
        ],
      },
      land: { objects: [] },
      property: { objects: [] },
      rules: { objects: [] },
      meetings: { objects: [] },
      franchise: { objects: [] },
    },
    vendor_footprint: {
      qualifier_required: true,
      award_coverage: {
        linked: 1,
        eligible: 2,
        rate: 0.5,
        label: "showing 1 of 2 known awards linked so far (50%)",
      },
      section_counts: {
        awards: { confirmed_count: 1, mention_count: 2, scope_count: 2 },
      },
      promotion: { eligible: false },
      provenance: { denominator_materialized_at: "2026-08-05" },
    },
  };

  const model = vendorFootprintModel(response);
  assert.equal(model.groups.find((group) => group.id === "awards").objects.length, 1);
  assert.equal(model.groups.find((group) => group.id === "awards").scope_count, 2);

  const html = renderVendorFootprintHTML(response);
  assert.match(html, /Awards <span class="ct">2<\/span>/);
  assert.match(html, /1 link we’ve confirmed/);
  assert.match(html, /2 records mention this name/);
  assert.doesNotMatch(html, /We haven’t measured how complete this section is yet/);
  assert.doesNotMatch(html, /snapshot|source_record_id/i);
  assert.match(html, /See Acme &amp; Co\.&#39;s awards \(2\)/);
  assert.match(html, /Strong award/);
  assert.match(html, /class="ui-constellation-link pivot vendor-record-link"/);
  assert.match(html, /class="ui-constellation-link vendor-footprint-scope"/);
  assert.doesNotMatch(html, /Weak candidate/);
  assert.doesNotMatch(html, /strongly linked|in this build|coverage not measured|View this vendor as/i);
  assert.doesNotMatch(html, /This summary groups|identity not yet confirmed/i);
  assert.match(html, /Acme &amp; Co\./);
});

test("view-all links compose a typed vendor constraint through scope v0", () => {
  const href = vendorFootprintScopeHref(REF, "awards", { query: "Acme & Co.", resultCount: 2 });
  assert.match(href, /^\/browse\/contracts\/\?mode=award&/);
  const params = new URLSearchParams(new URL(href, "https://cityscroll.org").search);
  assert.equal(params.get("q"), "Acme & Co.");
  assert.deepEqual(JSON.parse(params.get("facet")), {
    entity_refs_all: [REF],
    result_count_receipt: 2,
  });
  assert.equal(vendorFootprintScopeHref(REF, "franchise"), "");
});

test("zero confirmed links surface populated name-mention counts without methodology copy", () => {
  const html = renderVendorFootprintHTML({
    root: { kind: "vendor", ref: REF, display_name: "Acme" },
    domains: { money: { objects: [] } },
    vendor_footprint: {
      qualifier_required: true,
      award_coverage: { linked: 0, eligible: 273, rate: 0 },
      section_counts: {
        awards: { confirmed_count: 0, mention_count: 273, scope_count: 273 },
      },
    },
  });
  assert.match(html, /Awards <span class="ct">273<\/span>/);
  assert.match(html, /273 records mention this name/);
  assert.doesNotMatch(html, /identity not yet confirmed|This summary groups/i);
  assert.match(html, /See Acme&#39;s awards \(273\)/);
});

test("an empty footprint paints every supported family honestly", () => {
  const html = renderVendorFootprintHTML({
    root: { kind: "vendor", ref: REF, display_name: "Acme" },
    domains: {},
    vendor_footprint: { section_counts: {} },
  });
  assert.match(html, /data-footprint-section="awards"/);
  assert.match(html, /data-footprint-section="franchise"/);
  assert.match(html, /No meetings or hearings linked yet/);
  assert.doesNotMatch(html, /Empty in this scoped materialization|current materialization|none in this materialization/i);
});

test("promotion removes qualifier labels but never admits tentative rows", () => {
  const response = {
    root: { kind: "vendor", ref: REF, display_name: "Acme" },
    domains: {
      money: { objects: [{ object_kind: "award", confidence: "tentative", label: "Maybe" }] },
    },
    vendor_footprint: {
      qualifier_required: false,
      award_coverage: { label: "showing 1 of 1 known awards linked so far (100%)" },
      section_counts: {
        awards: { confirmed_count: 1, mention_count: 1, scope_count: 1 },
      },
      promotion: { eligible: true },
    },
  };
  const html = renderVendorFootprintHTML(response);
  assert.doesNotMatch(html, /showing 1 of 1/);
  assert.doesNotMatch(html, /coverage not measured/);
  assert.doesNotMatch(html, /Maybe/);
  assert.match(html, /link we’ve confirmed/);
});

test("PASSPort/Checkbook contract corroboration (VI-02) gets its own section, distinct from award and payment", () => {
  const response = {
    ok: true,
    root: { kind: "vendor", ref: REF, display_name: "Make it Zesty LLC" },
    domains: {
      money: {
        objects: [
          { object_kind: "award", request_id: "1", confidence: "strong", label: "Catering Services", href: "#notice/1" },
          { object_kind: "contract", subject_ref: "contract:CT1", confidence: "strong", label: "PASSPort contract" },
          { object_kind: "contract", subject_ref: "contract:CT2", confidence: "strong", label: "Checkbook contract" },
          { object_kind: "payment", subject_ref: "entity:spending:1", confidence: "strong", label: "Checkbook payment" },
        ],
      },
      land: { objects: [] },
      property: { objects: [] },
      rules: { objects: [] },
      meetings: { objects: [] },
      franchise: { objects: [] },
    },
    vendor_footprint: {
      qualifier_required: true,
      award_coverage: { linked: 1, eligible: 1, rate: 1, label: "showing 1 of 1 known awards linked so far (100%)" },
      section_counts: {
        awards: { confirmed_count: 1, mention_count: 1, scope_count: 1 },
        contracts: { confirmed_count: 2, mention_count: 2, scope_count: 2 },
        payments: { confirmed_count: 1, mention_count: 1, scope_count: 1 },
      },
      promotion: { eligible: false },
      provenance: {},
    },
  };

  const model = vendorFootprintModel(response);
  const awards = model.groups.find((group) => group.id === "awards");
  const contracts = model.groups.find((group) => group.id === "contracts");
  const payments = model.groups.find((group) => group.id === "payments");
  assert.equal(awards.objects.length, 1);
  assert.equal(contracts.objects.length, 2);
  assert.equal(payments.objects.length, 1);
  assert.equal(contracts.coverage_kind, "unknown");

  const html = renderVendorFootprintHTML(response);
  assert.match(html, /Contract corroboration <span class="ct">2<\/span>/);
  assert.match(html, /PASSPort contract/);
  assert.match(html, /Checkbook contract/);
});

test("vendorAgencyIntersectionHref composes a typed vendor ∩ named-agency scope", () => {
  const href = vendorAgencyIntersectionHref(REF, "Health and Mental Hygiene", { query: "MAKE IT ZESTY" });
  assert.match(href, /^\/browse\/contracts\/\?mode=award&/);
  const params = new URLSearchParams(new URL(href, "https://cityscroll.org").search);
  assert.equal(params.get("mode"), "award");
  assert.equal(params.has("agency"), false);
  assert.equal(params.get("q"), "MAKE IT ZESTY");
  assert.deepEqual(JSON.parse(params.get("facet")), { entity_refs_all: ["agency:id:health-and-mental-hygiene", REF] });
  assert.equal(vendorAgencyIntersectionHref(REF, ""), "");
  assert.equal(vendorAgencyIntersectionHref("", "Health and Mental Hygiene"), "");
});

test("pivot round-trip detector rejects a destination that cannot contain the origin record", () => {
  const award = scopeFromRouteHash("#money?mode=award");
  const open = scopeFromRouteHash("#money?mode=open");
  assert.equal(pivotDestinationCompatibility({
    destinationSurface: "money", destinationScope: award, originRecordType: "award",
  }).compatible, true);
  assert.equal(pivotDestinationCompatibility({
    destinationSurface: "money", destinationScope: open, originRecordType: "award",
  }).compatible, false);
});
