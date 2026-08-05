import assert from "node:assert/strict";
import test from "node:test";

import { buildVendorFootprintCoverage } from "../tools/lib/entity_intelligence_build.mjs";
import { vendorCoverageKey } from "../entity_resolution/cross_domain/vendor_coverage_key.mjs";
import {
  renderVendorFootprintHTML,
  vendorFootprintModel,
  vendorFootprintScopeHref,
} from "../site/vendor_footprint.mjs";

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

test("build derives award coverage from the full known set and excludes weak candidates", () => {
  const coverage = buildVendorFootprintCoverage(fixtureDoc(), {
    dataset_id: "awards",
    materialized_at: "2026-08-05T00:00:00Z",
    row_count: 3,
    rows: [
      { request_id: "1", vendor_name: "Acme Inc." },
      { request_id: "2", vendor_name: "ACME LLC" },
      { request_id: "3", vendor_name: "Elsewhere Corp." },
    ],
  }, {
    quality_review: {
      accepted_pair_candidates_reviewed: 45,
      confirmed_false_positives: 0,
      unreviewed_residual: "This does not support a full-corpus precision claim.",
    },
  });

  assert.deepEqual(coverage.awards_by_ref[REF], {
    linked: 1,
    eligible: 2,
    rate: 0.5,
    label: "showing 1 of 2 known awards linked so far (50%)",
  });
  assert.equal(coverage.summary.linked_awards, 1);
  assert.equal(coverage.qualifier_required, true);
  assert.equal(coverage.promotion.gates.precision_review.passed, false);
  assert.deepEqual(coverage.excluded_confidence, ["tentative", "review_only", "not_scored"]);
});

test("vendor footprint renders load-bearing coverage copy and strong objects only", () => {
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
  assert.match(html, /We haven’t measured how complete this section is yet/);
  assert.match(html, /See Acme &amp; Co\.&#39;s awards \(2\)/);
  assert.match(html, /Strong award/);
  assert.doesNotMatch(html, /Weak candidate/);
  assert.doesNotMatch(html, /strongly linked|in this build|coverage not measured|View this vendor as/i);
  assert.match(html, /Acme &amp; Co\./);
});

test("view-all links compose a typed vendor constraint through scope v0", () => {
  const href = vendorFootprintScopeHref(REF, "awards", { query: "Acme & Co.", resultCount: 2 });
  assert.match(href, /^#money\?mode=award&/);
  const params = new URLSearchParams(href.split("?")[1]);
  assert.equal(params.get("q"), "Acme & Co.");
  assert.deepEqual(JSON.parse(params.get("facet")), {
    entity_refs_all: [REF],
    result_count_receipt: 2,
  });
  assert.equal(vendorFootprintScopeHref(REF, "franchise"), "");
});

test("zero confirmed links surface name mentions instead of a dead section", () => {
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
  assert.match(html, /273 records mention this name — identity not yet confirmed/);
  assert.match(html, /See Acme&#39;s awards \(273\)/);
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
  assert.match(html, /links we’ve confirmed/);
});
