import assert from "node:assert/strict";
import test from "node:test";

import {
  WARRANT_CLASSES,
  buildEdgeProvenanceClaim,
  claimInspectHref,
  edgeClaimId,
  identityStanceForEdge,
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

test("identity stance never treats a score as verified identity", () => {
  const strong = identityStanceForEdge({ method: "agency_canonical_v1", confidence: "strong" });
  assert.equal(strong.id, "publisher_key");
  assert.match(strong.reader, /not a CityScroll identity merge|source field match/i);

  const possible = identityStanceForEdge({ method: "agency_canonical_v1", confidence: "tentative" });
  assert.equal(possible.id, "possible_link");
  assert.match(possible.reader, /never counted as a verified/i);

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
  assert.equal(claim.confidence.is_verified_identity, false);
  assert.equal(claim.confidence.counts_as_verified_total, true);
  assert.equal(claim.how.warrant_class, "exact");
});

test("missing enrichment fields stay labeled, not invented", () => {
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
  assert.match(html, /Not yet attached/);
  assert.match(html, /Why do we believe this\?/);
  assert.match(html, /data-verified-identity="false"/);
  assert.doesNotMatch(html, /entity_link:[a-z0-9-]+/i);
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

test("possible links never inflate verified totals", () => {
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
  const possible = buildEdgeProvenanceClaim({
    id: "2025Q0316",
    subject_ref: "project:2025Q0316",
    label: "Walk to Park",
    confidence: "tentative",
    method: "agency_canonical_v1",
    relation: "applicant_agency",
    provenance: {
      source_system: "Zoning Application Portal projects (Open Data)",
      source_record_id: "zap:2025Q0316",
      source_fields: ["primary_applicant"],
      basis: "land_primary_applicant",
      input_value: "DPR - Department of Parks & Recreation NYC",
    },
  }, {
    category_id: "land",
    document_path: "/agencies/parks-and-recreation/",
  });

  const why = renderWhyBelieveControl(exact);
  assert.match(why, /Why do we believe this\?/);
  assert.match(why, /data-warrant-class="exact"/);
  assert.match(why, /claim=contracts%3Anotice%3A20030224002/);

  const panel = renderEdgeProvenancePanel([exact, possible], {
    activeClaimId: possible.claim_id,
  });
  assert.match(panel, /Exact match/);
  assert.match(panel, /Probabilistic link/);
  assert.match(panel, /Person-accepted/);
  assert.match(panel, /data-warrant-class="probabilistic"/);
  assert.match(panel, /not(?:<\/strong>)?\s*counted as a verified total/i);
  assert.match(panel, /data-edge-provenance-panel/);
  assert.equal(normalizePublicConfidence("publisher_record"), "strong");
  assert.equal(WARRANT_CLASSES.exact.id, "exact");
});
