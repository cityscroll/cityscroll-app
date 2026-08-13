import assert from "node:assert/strict";
import test from "node:test";

import {
  CROSS_SPINE_CONFIDENCE,
  WARRANT_CLASSES,
  buildEdgeProvenanceClaim,
  claimInspectHref,
  edgeClaimId,
  identityStanceForEdge,
  isStandablePublicClaim,
  normalizePublicConfidence,
  parseClaimParam,
  renderEdgeProvenanceInspector,
  renderEdgeProvenancePanel,
  renderWhyBelieveControl,
  summarizeCategoryWarrants,
  warrantClassForEdge,
} from "../site/graph_edge_provenance.mjs";

test("warrant class maps exact publisher methods and keeps tentative probabilistic", () => {
  assert.equal(
    warrantClassForEdge({ method: "agency_canonical_v1", confidence: "strong" }).id,
    "exact",
  );
  assert.equal(
    warrantClassForEdge({ method: "publisher_certification_record_v1", confidence: "publisher_record" }).id,
    "exact",
  );
  assert.equal(
    warrantClassForEdge({ method: "agency_canonical_v1", confidence: "tentative" }).id,
    "probabilistic",
  );
  assert.equal(
    warrantClassForEdge({ method: "manual_review", decision: "reviewed" }).id,
    "reviewed",
  );
  assert.equal(
    warrantClassForEdge({ method: "unknown_method_xyz", confidence: "strong" }).id,
    "not_yet_classified",
  );
});

test("identity stance labels standable publisher and linkage connections", () => {
  const strong = identityStanceForEdge({ method: "agency_canonical_v1", confidence: "strong" });
  assert.equal(strong.id, "publisher_key");
  assert.equal(strong.label, "Publisher key match");

  const possible = identityStanceForEdge({ method: "agency_canonical_v1", confidence: "tentative" });
  assert.equal(possible.id, "possible_link");

  const claim = buildEdgeProvenanceClaim({
    id: "n1",
    subject_ref: "notice:n1",
    label: "Demo",
    confidence: "strong",
    method: "agency_canonical_v1",
    relation: "published_by_agency",
    provenance: {
      source_system: "city_record",
      source_record_id: "city_record:n1",
      source_fields: ["agency_name"],
      basis: "money_agency_name",
      input_value: "Parks and Recreation",
    },
  }, {
    category_id: "contracts",
    document_path: "/agencies/parks-and-recreation/",
    root_ref: "agency:id:parks-and-recreation",
  });
  assert.equal(claim.confidence.standable, true);
  assert.equal(claim.confidence.counts_as_verified_total, true);
  assert.equal(claim.how.warrant_class, "exact");
});

test("missing enrichment fields are omitted, not invented", () => {
  const claim = buildEdgeProvenanceClaim({
    id: "x",
    subject_ref: "notice:x",
    label: "Sparse edge",
    confidence: "strong",
    method: "agency_canonical_v1",
    source: "City Record",
  }, { category_id: "rules", document_path: "/agencies/demo/" });

  assert.equal(claim.where.source_record_id.available, false);
  assert.equal(claim.enrichment.entity_link_id.available, false);
  assert.equal(claim.enrichment.resolution_run_id.available, false);
  assert.ok(claim.enrichment.missing_fields.includes("entity_link_id"));
  assert.ok(claim.enrichment.missing_fields.includes("resolution_run_id"));

  const html = renderEdgeProvenanceInspector(claim, { open: true });
  assert.doesNotMatch(html, /Not yet attached/);
  assert.doesNotMatch(html, /Link record|Resolution run|Source excerpt/);
  assert.match(html, /edge-prov-confidence-unmatched/);
  assert.doesNotMatch(html, /Confidence is not identity/i);
  assert.doesNotMatch(html, /entity_link:[a-z0-9-]+/i);
  assert.doesNotMatch(html, /Source detail still to attach/);
  assert.doesNotMatch(html, /Later iterations may attach/i);
  assert.doesNotMatch(html, /How it was derived|Method:/i);
});

test("deep-link grammar is shareable and parseable", () => {
  assert.equal(
    edgeClaimId({ category_id: "contracts", subject_ref: "notice:20030224002" }),
    "contracts:notice:20030224002",
  );
  assert.equal(
    claimInspectHref("/agencies/parks-and-recreation/", "contracts:notice:20030224002"),
    "/agencies/parks-and-recreation/?claim=contracts%3Anotice%3A20030224002",
  );
  assert.equal(
    parseClaimParam("?claim=contracts%3Anotice%3A20030224002"),
    "contracts:notice:20030224002",
  );
  assert.equal(parseClaimParam(""), null);
});

test("summarize separates standable edges from tentative ones", () => {
  const summary = summarizeCategoryWarrants([
    {
      claim: buildEdgeProvenanceClaim({
        id: "a",
        subject_ref: "notice:a",
        confidence: "strong",
        method: "agency_canonical_v1",
      }, { category_id: "contracts" }),
    },
    {
      claim: buildEdgeProvenanceClaim({
        id: "b",
        subject_ref: "notice:b",
        confidence: "tentative",
        method: "agency_canonical_v1",
      }, { category_id: "contracts" }),
    },
  ]);
  assert.equal(summary.listed_total, 2);
  assert.equal(summary.standable_total, 1);
  assert.equal(summary.verified_total, 1);
  assert.equal(summary.possible_total, 1);
  assert.equal(summary.exact, 1);
  assert.equal(summary.probabilistic, 1);
});

test("inspector panel and why-control render warrant classes without fabricating trails", () => {
  const exact = buildEdgeProvenanceClaim({
    id: "20030224002",
    subject_ref: "notice:20030224002",
    label: "Wetland reconstruction",
    confidence: "strong",
    method: "agency_canonical_v1",
    relation: "published_by_agency",
    provenance: {
      source_system: "warehouse",
      source_record_id: "warehouse:20030224002",
      source_fields: ["agency_name"],
      basis: "money_agency_name",
      input_value: "Parks and Recreation",
      observed_at: "2003-03-03",
    },
  }, {
    category_id: "contracts",
    document_path: "/agencies/parks-and-recreation/",
  });
  const reviewed = buildEdgeProvenanceClaim({
    id: "rev1",
    subject_ref: "notice:rev1",
    label: "Reviewed notice",
    confidence: "strong",
    method: "manual_review",
    decision: "reviewed",
    relation: "published_by_agency",
    provenance: {
      source_system: "city_record",
      source_record_id: "city_record:rev1",
      source_fields: ["agency_name"],
      basis: "manual_review",
      input_value: "Parks and Recreation",
    },
  }, {
    category_id: "contracts",
    document_path: "/agencies/parks-and-recreation/",
  });

  const why = renderWhyBelieveControl(exact);
  assert.doesNotMatch(why, /Why do we believe this\? ·/);
  assert.match(why, /edge-prov-confidence-unmatched/);
  assert.match(why, />Details</);
  assert.doesNotMatch(why, />unmatched</);
  assert.match(why, /data-warrant-class="exact"/);
  assert.match(why, /aria-label="View connection details"/);
  assert.match(why, /claim=contracts%3Anotice%3A20030224002/);

  const panel = renderEdgeProvenancePanel([exact, reviewed], {
    activeClaimId: exact.claim_id,
  });
  assert.match(panel, /Exact match/);
  assert.match(panel, /Connection evidence/);
  assert.doesNotMatch(panel, /How links are warranted/);
  assert.match(panel, /data-warrant-class="exact"/);
  assert.doesNotMatch(panel, /Confidence is not identity/i);
  assert.doesNotMatch(panel, /not counted as a verified/i);
  assert.match(panel, /data-edge-provenance-panel/);
  assert.doesNotMatch(panel, /How it was derived|Joined by an exact publisher key|Method:/i);
  assert.equal(normalizePublicConfidence("publisher_record"), "strong");
  assert.equal(WARRANT_CLASSES.exact.id, "exact");
  assert.equal(WARRANT_CLASSES.exact.token, "exact");
  assert.equal(WARRANT_CLASSES.probabilistic.token, "probable");

  const inactivePanel = renderEdgeProvenancePanel([exact, reviewed]);
  assert.match(inactivePanel, /data-edge-provenance-panel="1"[^>]* hidden/);
  assert.match(inactivePanel, /data-edge-prov-body="1"><\/div>/);
  assert.doesNotMatch(inactivePanel, /Open a warrant chip/);
});

test("cross-spine confidence stays in the exact set and preserves null evidence", () => {
  assert.deepEqual(CROSS_SPINE_CONFIDENCE, ["confirmed", "review", "unmatched"]);
  const review = buildEdgeProvenanceClaim({
    id: "review-1",
    subject_ref: "notice:review-1",
    label: "Review edge",
    confidence: "strong",
    method: "agency_canonical_v1",
    cross_spine: { confidence: "review" },
    href: null,
    provenance: {
      source_system: "city_record",
      source_record_id: null,
      source_fields: null,
      observed_at: null,
    },
  }, { category_id: "contracts" });

  assert.equal(review.cross_spine.confidence, "review");
  assert.equal(review.cross_spine.explicit, true);
  assert.equal(review.where.source_record_id.available, false);
  assert.equal(review.where.source_fields.available, false);
  assert.equal(review.where.source_fields.value, null);
  assert.equal(review.object_href, null);
  assert.equal(review.confidence.standable, false);
  assert.equal(isStandablePublicClaim(review), false);
  assert.match(renderWhyBelieveControl(review), /data-cross-spine-confidence="review"/);
  assert.match(renderEdgeProvenanceInspector(review, { open: true }), /edge-prov-confidence-review/);
  assert.doesNotMatch(renderEdgeProvenanceInspector(review, { open: true }), /Source fields|Unavailable|does not choose a winner or merge identities/);
});
