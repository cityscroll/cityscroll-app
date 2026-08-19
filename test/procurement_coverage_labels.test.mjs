import assert from "node:assert/strict";
import { test } from "node:test";

import { loadOntologyRegistry } from "../ontology/load.mjs";
import { resolveProcurementPublicationPolicy } from "../ontology/procurement_policy.mjs";
import {
  PROCUREMENT_COVERAGE_AMOUNT_BANDS,
  PROCUREMENT_COVERAGE_KINDS,
  PROCUREMENT_COVERAGE_POLICY_EFFECTIVE_FROM,
  coverageInputFromBrowseRow,
  formatProcurementCoverageCopy,
  mapPublisherMethodFamily,
  projectProcurementCoverageFact,
  projectProcurementCoverageLabel,
  projectProcurementCoverageSignals,
  renderProcurementCoverageHtml,
  renderProcurementObjectCoverageHtml,
  renderProcurementRowCoverageHtml,
} from "../site/procurement_coverage_labels.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";

const registry = loadOntologyRegistry().procurement_policy_registry;

const ordinaryFivePlusTen = {
  method_family: "ordinary_5_plus_10",
  procurement_category: "goods_and_non_construction_services",
  amount: 75_000,
  occurred_on: "2024-01-15",
};

const ordinaryMicro = {
  method_family: "ordinary_micropurchase",
  procurement_category: "goods_and_non_construction_services",
  amount: 8_000,
  occurred_on: "2024-01-15",
};

const mwbeSmallPurchase = {
  method_family: "mwbe_small_purchase",
  procurement_category: "goods_and_non_construction_services",
  amount: 75_000,
  occurred_on: "2024-01-15",
};

function withPolicy(record, stage, extras = {}) {
  const policy = resolveProcurementPublicationPolicy(record, stage, registry);
  return { ...record, ...policy, stage, ...extras };
}

const SLOP = [
  /coverage may be incomplete/i,
  /data may be incomplete/i,
  /results may be incomplete/i,
  /coverage is incomplete/i,
  /coverage by collection/i,
  /CROL absence/i,
  /legal exemption/i,
  /not_required/,
  /source_checked_no_record/,
  /unmapped_publisher_variant/,
  /violation/i,
  /noncompliant/i,
  /out of compliance/i,
];

function assertNoSlop(text) {
  for (const pattern of SLOP) {
    assert.doesNotMatch(String(text || ""), pattern);
  }
}

test("ordinary matched small-purchase rows get the targeted-solicitation label", () => {
  for (const record of [ordinaryFivePlusTen, ordinaryMicro]) {
    const label = projectProcurementCoverageLabel(withPolicy(record, "solicitation"), "solicitation");
    assert.equal(label.kind, PROCUREMENT_COVERAGE_KINDS.TARGETED_SMALL_PURCHASE);
    assert.equal(label.is_compliance_verdict, false);
    assert.equal(
      formatProcurementCoverageCopy(label),
      "Targeted small-purchase — no public solicitation required",
    );
    assertNoSlop(formatProcurementCoverageCopy(label));
  }
});

test("M/WBE award notice label fires only after required plus source_checked_no_record", () => {
  const missing = projectProcurementCoverageLabel(
    withPolicy(mwbeSmallPurchase, "award", { coverage_state: "source_checked_no_record" }),
    "award",
  );
  assert.equal(missing.kind, PROCUREMENT_COVERAGE_KINDS.MWBE_AWARD_NOTICE_NOT_YET_FOUND);
  assert.equal(missing.is_compliance_verdict, false);
  assert.equal(formatProcurementCoverageCopy(missing), "M/WBE award notice not yet found");
  assertNoSlop(formatProcurementCoverageCopy(missing));

  const found = projectProcurementCoverageLabel(
    withPolicy(mwbeSmallPurchase, "award", { coverage_state: "observed" }),
    "award",
  );
  assert.equal(found, null);

  const unchecked = projectProcurementCoverageLabel(
    withPolicy(mwbeSmallPurchase, "award", { coverage_state: "not_checked" }),
    "award",
  );
  assert.equal(unchecked, null);
});

test("unknown and unmapped methods make no legal claim", () => {
  assert.equal(mapPublisherMethodFamily("SMALL PURCHASE - EMERGENCY"), null);
  assert.equal(mapPublisherMethodFamily("SMALL PURCHASE - SOLE SOURCE"), null);
  assert.equal(mapPublisherMethodFamily("SMALL PURCHASE - RFP"), null);
  assert.equal(mapPublisherMethodFamily("SMALL PURCHASE"), null);

  const unmapped = projectProcurementCoverageLabel({
    method_family: "unmapped_publisher_variant",
    publisher_method: "SMALL PURCHASE - OTHER",
    procurement_category: "goods_and_non_construction_services",
    amount: 75_000,
    occurred_on: "2024-01-15",
  }, "solicitation");
  assert.equal(unmapped, null);

  const absenceOnly = projectProcurementCoverageLabel({
    publisher_method: "Small Purchase",
    coverage_state: "source_checked_no_record",
    procurement_category: "goods_and_non_construction_services",
    amount: 75_000,
    occurred_on: "2024-01-15",
  }, "award");
  assert.equal(absenceOnly, null);
  assert.equal(
    resolveProcurementPublicationPolicy(absenceOnly || {
      publisher_method: "Small Purchase",
      coverage_state: "source_checked_no_record",
      procurement_category: "goods_and_non_construction_services",
      amount: 75_000,
      occurred_on: "2024-01-15",
    }, "award", registry).publication_obligation,
    "unknown",
  );
});

test("exact publisher labels map to policy families and variants stay out", () => {
  assert.equal(mapPublisherMethodFamily("SMALL PURCHASE - WRITTEN"), "ordinary_5_plus_10");
  assert.equal(mapPublisherMethodFamily("Micropurchase"), "ordinary_micropurchase");
  assert.equal(mapPublisherMethodFamily("SMALL PURCHASE - UNDER $5,000"), "ordinary_micropurchase");
  assert.equal(mapPublisherMethodFamily("MWBE Non Competitive Small Purchase"), "mwbe_small_purchase");
  assert.equal(mapPublisherMethodFamily("M/WBE SMALL PURCHASE"), "mwbe_small_purchase");
});

test("collection fact names both counts and stays silent when they agree or the facet is empty without a publisher figure", () => {
  const gap = projectProcurementCoverageFact({ observed_count: 12, publisher_count: 40 });
  assert.equal(formatProcurementCoverageCopy(gap), "12 observed, publisher reports 40");
  assert.equal(gap.is_compliance_verdict, false);
  assertNoSlop(formatProcurementCoverageCopy(gap));

  const emptyWithPublisher = projectProcurementCoverageFact({
    observed_count: 0,
    publisher_count: 40,
    facet_empty: true,
  });
  assert.equal(formatProcurementCoverageCopy(emptyWithPublisher), "0 observed, publisher reports 40");

  assert.equal(projectProcurementCoverageFact({ observed_count: 40, publisher_count: 40 }), null);
  assert.equal(projectProcurementCoverageFact({ observed_count: 0, facet_empty: true }), null);
  assert.equal(projectProcurementCoverageFact({ publisher_count: 40 }), null);
});

test("HTML renders only varying signals and never paints disclaimer or debug furniture", () => {
  const ordinaryHtml = renderProcurementCoverageHtml(withPolicy(ordinaryFivePlusTen, "solicitation"));
  assert.match(ordinaryHtml, /data-coverage-kind="targeted_small_purchase"/);
  assert.match(ordinaryHtml, /data-compliance-verdict="not_adjudicated"/);
  assert.match(ordinaryHtml, /Targeted small-purchase — no public solicitation required/);
  assert.doesNotMatch(ordinaryHtml, /coverage may be incomplete|data may be incomplete/i);
  assertNoSlop(ordinaryHtml);

  const silent = renderProcurementCoverageHtml({
    method_family: "unmapped_publisher_variant",
    amount: 75_000,
    occurred_on: "2024-01-15",
    procurement_category: "goods_and_non_construction_services",
  });
  assert.equal(silent, "");

  const emptyFacet = renderProcurementCoverageHtml({
    observed_count: 0,
    facet_empty: true,
  });
  assert.equal(emptyFacet, "");
});

test("M/WBE missing-notice copy is coverage, not a violation, and ordinary award rows stay fact-first when CROL is present", () => {
  const html = renderProcurementCoverageHtml({
    ...mwbeSmallPurchase,
    coverage_state: "source_checked_no_record",
    stages: ["award"],
  });
  assert.match(html, /M\/WBE award notice not yet found/);
  assert.match(html, /data-compliance-verdict="not_adjudicated"/);
  assert.doesNotMatch(html, /violat|noncompliant|out of compliance/i);

  const observedOrdinary = renderProcurementRowCoverageHtml({
    selection_method_description: "SMALL PURCHASE - WRITTEN",
    procurement_category: "goods_and_non_construction_services",
    contract_amount: 75_000,
    start_date: "2024-01-15",
    coverage_state: "observed",
    procurement_stages: ["registered"],
  });
  assert.match(observedOrdinary, /Targeted small-purchase/);
});

test("site amount bands stay aligned with the versioned PPB 3-08 registry", () => {
  assert.equal(PROCUREMENT_COVERAGE_POLICY_EFFECTIVE_FROM, registry.source.effective_from);
  for (const family of registry.method_families) {
    if (family.id === "unmapped_publisher_variant") continue;
    const siteBands = PROCUREMENT_COVERAGE_AMOUNT_BANDS[family.id];
    assert.ok(siteBands, family.id);
    for (const band of family.applicability.amount_bands) {
      const site = siteBands[band.procurement_category];
      assert.deepEqual({
        min: site.min,
        minInclusive: site.minInclusive,
        max: site.max,
        maxInclusive: site.maxInclusive,
      }, {
        min: band.minimum,
        minInclusive: band.minimum_inclusive,
        max: band.maximum,
        maxInclusive: band.maximum_inclusive,
      });
    }
  }
});

test("procurement documents paint the informative label and omit silent cases", () => {
  const object = {
    procurement_id: "procurement:contract:CT101520271400806",
    identity_keys: { contract_ids: ["CT101520271400806"], epins: ["01523BLA66814"] },
    source_observation_refs: ["checkbook_contracts:ct-small"],
    stages: [{ stage: "registered" }],
    coverage_state: "not_checked",
    method_family: "ordinary_5_plus_10",
    procurement_category: "goods_and_non_construction_services",
    occurred_on: "2024-01-15",
  };
  const observations = [{
    source_observation_ref: "checkbook_contracts:ct-small",
    snapshot: {
      title: "Written small purchase legal services",
      agency: "Office of the Comptroller",
      vendor: "BILLIG LAW PC",
      current: 75_000,
      selection_method_description: "SMALL PURCHASE - WRITTEN",
      registered: "2024-01-15",
    },
  }];
  const html = renderProcurementDocument(object, observations);
  assert.match(html, /Targeted small-purchase — no public solicitation required/);
  assert.doesNotMatch(html, /coverage may be incomplete|not_required|source_checked_no_record/);
  assert.equal(renderProcurementObjectCoverageHtml({
    procurement_id: "procurement:contract:CT-UNKNOWN",
    source_observation_refs: ["checkbook_contracts:other"],
    stages: [{ stage: "registered" }],
  }, [{
    source_observation_ref: "checkbook_contracts:other",
    snapshot: {
      title: "Emergency buy",
      selection_method_description: "SMALL PURCHASE - EMERGENCY",
      current: 75_000,
      registered: "2024-01-15",
    },
  }]), "");
});

test("signals compose labels and count facts without a standing caveat", () => {
  const composed = projectProcurementCoverageSignals({
    ...ordinaryFivePlusTen,
    stages: ["registered"],
    observed_count: 5616,
    publisher_count: 8303,
  });
  assert.equal(composed.labels[0].kind, PROCUREMENT_COVERAGE_KINDS.TARGETED_SMALL_PURCHASE);
  assert.equal(
    formatProcurementCoverageCopy(composed.fact),
    "5616 observed, publisher reports 8303",
  );
  const html = renderProcurementCoverageHtml(composed);
  assert.match(html, /Targeted small-purchase/);
  assert.match(html, /5616 observed, publisher reports 8303/);
  assertNoSlop(html);

  const input = coverageInputFromBrowseRow({
    selection_method_description: "SMALL PURCHASE - PUBLICLY LET",
    contract_amount: 75_000,
    start_date: "2024-01-15",
  });
  assert.equal(projectProcurementCoverageSignals(input).labels.length, 0);
});

test("Browse contracts paint a row label and a collection fact only when they vary", () => {
  const labeled = renderBrowseView(buildBrowseView("contracts", {
    notices: [{
      request_id: "1",
      short_title: "Written small purchase",
      selection_method_description: "SMALL PURCHASE - WRITTEN",
      procurement_category: "goods_and_non_construction_services",
      contract_amount: 75_000,
      start_date: "2024-01-15",
    }],
    procurement_coverage: { observed_count: 12, publisher_count: 40 },
  }));
  assert.match(labeled, /Targeted small-purchase — no public solicitation required/);
  assert.match(labeled, /12 observed, publisher reports 40/);
  assert.doesNotMatch(labeled, /coverage may be incomplete/i);

  const empty = renderBrowseView(buildBrowseView("contracts", { notices: [] }));
  assert.doesNotMatch(empty, /observed, publisher reports|coverage may be incomplete/i);
});

test("i18n formatter keeps concrete counts in the sentence", () => {
  const fact = projectProcurementCoverageFact({ observed_count: 1, publisher_count: 9 });
  assert.equal(
    formatProcurementCoverageCopy(fact, {
      translate(key, variables) {
        assert.equal(key, "procurement_coverage_counts");
        return `${variables.observed} observados, el editor informa ${variables.publisher}`;
      },
    }),
    "1 observados, el editor informa 9",
  );
});
