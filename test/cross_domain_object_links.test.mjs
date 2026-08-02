/**
 * Cross-domain object-link layer + entity intelligence materialization.
 *
 * verify:
 *   node --test test/cross_domain_object_links.test.mjs worker/test/entity_intelligence.test.mjs
 *   node tools/build_entity_intelligence.mjs --check
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  CROSS_DOMAIN_OBJECT_LINK_VERSION,
  CROSS_DOMAIN_DOMAINS,
  resolveAgencySubject,
  resolveVendorSubject,
  observationFromMoneyRow,
  observationFromPaymentRow,
  observationFromLandRow,
  observationFromRulesRow,
  observationFromMeetingsRow,
  linkObservation,
  joinKeyLinksForObservation,
  buildEntityIntelligence,
  buildIntelligenceCorpus,
  lookupEntityIntelligence,
  makeObjectLink,
  makeProvenance,
} from "../entity_resolution/cross_domain/index.mjs";
import {
  buildEntityIntelligenceDoc,
  collectCrossDomainObservations,
} from "../tools/lib/entity_intelligence_build.mjs";
import {
  buildEntityIntelligenceIndex,
  lookupFromIndex,
  ENTITY_INTELLIGENCE_INDEX_VERSION,
} from "../warehouse/lib/entity_intelligence_index.mjs";
import { sameAgency, canonicalAgency } from "../entity_resolution/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("cross-domain identity roots", () => {
  it("resolves Parks multi-surface strings onto one agency subject", () => {
    const a = resolveAgencySubject("Department of Parks and Recreation");
    const b = resolveAgencySubject("DPR - Department of Parks & Recreation NYC");
    const c = resolveAgencySubject("Parks and Recreation");
    assert.equal(a.ref, b.ref);
    assert.equal(a.ref, c.ref);
    assert.equal(a.ref, "agency:id:parks-and-recreation");
    assert.equal(sameAgency("Department of Parks and Recreation", "Parks and Recreation"), true);
  });

  it("resolves vendor stems without inventing merge ids", () => {
    const v = resolveVendorSubject("Make it Zesty LLC");
    assert.ok(v.stem);
    assert.match(v.ref, /^vendor:stem:/);
    assert.equal(resolveVendorSubject("x"), null, "too-short stem fails closed");
  });
});

describe("observation → links with provenance", () => {
  it("links a money award to agency and vendor with source provenance", () => {
    const obs = observationFromMoneyRow({
      request_id: "FIX005",
      agency_name: "Department of Parks and Recreation",
      vendor_name: "ACME WIDGETS INC",
      short_title: "Fixture parks award",
      pin: "PIN-PARKS",
      contract_amount: "1000",
      start_date: "2024-07-05",
      type_of_notice_description: "Award",
    });
    const { objects, links } = linkObservation(obs);
    assert.equal(objects.length, 2);
    // Identity edges + optional PIN join-key edge when pin is present.
    assert.ok(links.length >= 2);
    const agencyEdge = links.find((l) => l.type === "published_by_agency");
    const vendorEdge = links.find((l) => l.type === "named_vendor");
    const pinEdge = links.find((l) => l.type === "shares_authority_key");
    assert.ok(agencyEdge);
    assert.ok(vendorEdge);
    assert.ok(pinEdge, "PIN join key when pin column is set");
    assert.equal(agencyEdge.to, "agency:id:parks-and-recreation");
    assert.equal(agencyEdge.domain, "money");
    assert.equal(agencyEdge.provenance.source_system, "ocp-recent-contract-awards");
    assert.ok(agencyEdge.provenance.source_record_id.includes("FIX005"));
    assert.deepEqual(agencyEdge.provenance.source_fields, ["agency_name"]);
  });

  it("links a land project applicant agency with tentative confidence", () => {
    const obs = observationFromLandRow({
      project_id: "2022X0150",
      project_name: "Parks-led land action",
      primary_applicant: "DPR - Department of Parks & Recreation NYC",
      public_status: "Active",
      current_milestone_date: "2025-07-03",
    });
    const { objects, links } = linkObservation(obs);
    assert.equal(objects.length, 1);
    const agencyEdge = links.find((l) => l.type === "applicant_agency");
    assert.ok(agencyEdge);
    assert.equal(agencyEdge.to, "agency:id:parks-and-recreation");
    assert.equal(agencyEdge.confidence, "tentative");
    assert.equal(agencyEdge.provenance.input_value, "DPR - Department of Parks & Recreation NYC");
  });

  it("attaches ZAP BBL parcels as sited_on_parcel edges with provenance", () => {
    const obs = observationFromLandRow({
      project_id: "2022M0258",
      project_name: "Timbale Terrace",
      primary_applicant: "HPD - NYC Dept of Housing Preservation & Development",
      public_status: "Completed",
      bbls: ["1017670001", "1017670002"],
    });
    assert.deepEqual(obs.bbls, ["1017670001", "1017670002"]);
    const { objects, links } = linkObservation(obs);
    assert.ok(objects.length >= 1);
    assert.ok(objects[0].bbls?.includes("1017670001"));
    const parcelEdges = links.filter((l) => l.type === "sited_on_parcel");
    assert.equal(parcelEdges.length, 2);
    assert.equal(parcelEdges[0].from, "project:2022M0258");
    assert.ok(parcelEdges.every((e) => e.to.startsWith("parcel:")));
    assert.equal(parcelEdges[0].provenance.source_fields.includes("bbl"), true);
    assert.equal(parcelEdges[0].method, "zap_bbl_project_id_v1");
  });

  it("links award PIN and contract_id join keys with provenance", () => {
    const obs = observationFromMoneyRow({
      request_id: "FIX005",
      agency_name: "Department of Parks and Recreation",
      vendor_name: "FIXTURE VENDOR E",
      pin: "PIN-FIXTURE-5",
      contract_id: "CT-PARKS-FIX005",
      short_title: "Parks award with contract",
      start_date: "2024-07-05",
    });
    assert.equal(obs.contract_id, "CT-PARKS-FIX005");
    const { links } = linkObservation(obs);
    const pinEdge = links.find((l) => l.type === "shares_authority_key");
    const ctEdge = links.find((l) => l.type === "references_contract");
    const agencyCt = links.find((l) => l.type === "contract_published_by_agency");
    assert.ok(pinEdge, "PIN join edge");
    assert.equal(pinEdge.to, "pin:PIN-FIXTURE-5");
    assert.equal(pinEdge.provenance.source_fields.includes("pin"), true);
    assert.ok(ctEdge, "contract_id join edge");
    assert.equal(ctEdge.to, "contract:CT-PARKS-FIX005");
    assert.ok(agencyCt, "contract → agency");
    assert.equal(agencyCt.to, "agency:id:parks-and-recreation");
    assert.ok(joinKeyLinksForObservation(obs).length >= 2);
  });

  it("links Checkbook payment payee + contract (vendor ↔ awards ↔ payments chain)", () => {
    const pay = observationFromPaymentRow({
      document_id: "CHK-PARKS-001",
      payee_name: "FIXTURE VENDOR E",
      contract_id: "CT-PARKS-FIX005",
      check_amount: "250.00",
      issue_date: "2024-08-15",
      agency_name: "Department of Parks and Recreation",
      pin: "PIN-FIXTURE-5",
    });
    assert.equal(pay.object_kind, "payment");
    const { objects, links } = linkObservation(pay);
    assert.equal(objects.length, 1);
    assert.equal(objects[0].link_type, "paid_to_vendor");
    const paid = links.find((l) => l.type === "paid_to_vendor");
    const onCt = links.find((l) => l.type === "payment_on_contract");
    assert.ok(paid);
    assert.match(paid.to, /^vendor:stem:/);
    assert.ok(onCt);
    assert.equal(onCt.to, "contract:CT-PARKS-FIX005");
    assert.equal(paid.provenance.source_system, "checkbook-spending");
  });

  it("does not invent people links without person rows", () => {
    const view = buildEntityIntelligence(
      { kind: "agency", name: "Parks and Recreation" },
      [
        observationFromMoneyRow({
          request_id: "1",
          agency_name: "Parks and Recreation",
          vendor_name: "Vendor A LLC",
          short_title: "A",
          start_date: "2024-01-01",
        }),
      ],
    );
    assert.equal(view.ok, true);
    assert.equal(view.domains.people.status, "not_yet_ingested");
    assert.equal(view.domains.people.count, 0);
    assert.match(view.domains.people.note, /Legistar/i);
  });

  it("fails closed without provenance", () => {
    assert.equal(makeProvenance({ source_system: "x" }), null);
    assert.equal(
      makeObjectLink({
        type: "published_by_agency",
        from: "notice:1",
        to: "agency:id:parks-and-recreation",
        domain: "money",
      }),
      null,
    );
  });
});

describe("entity intelligence view — Parks multi-domain", () => {
  it("builds a multi-domain intelligence view for Parks from mixed observations", () => {
    const observations = [
      observationFromMoneyRow({
        request_id: "FIX005",
        agency_name: "Department of Parks and Recreation",
        vendor_name: "Fixture Vendor",
        short_title: "Parks award",
        start_date: "2024-07-05",
      }),
      observationFromLandRow({
        project_id: "2022X0150",
        project_name: "Parks project",
        primary_applicant: "DPR - Department of Parks & Recreation NYC",
      }),
      observationFromRulesRow({
        request_id: "20260715001",
        agency_name: "Department of Parks and Recreation",
        short_title: "Parks rule",
        start_date: "2026-07-15",
      }),
      observationFromMeetingsRow({
        request_id: "20260720055",
        agency_name: "Department of Parks and Recreation",
        short_title: "Parks hearing",
        event_date: "2026-08-12",
      }),
    ].filter(Boolean);

    const view = buildEntityIntelligence(
      { kind: "agency", name: "Parks and Recreation" },
      observations,
    );
    assert.equal(view.ok, true);
    assert.equal(view.version, CROSS_DOMAIN_OBJECT_LINK_VERSION);
    assert.equal(view.root.ref, "agency:id:parks-and-recreation");
    assert.equal(view.domains.money.status, "matched");
    assert.equal(view.domains.land.status, "matched");
    assert.equal(view.domains.rules.status, "matched");
    assert.equal(view.domains.meetings.status, "matched");
    assert.equal(view.domains.people.status, "not_yet_ingested");
    assert.equal(view.metrics.domains_matched, 4);
    assert.ok(view.metrics.coverage_rate >= 0.8);
    assert.ok(view.links.every((l) => l.provenance?.source_system && l.provenance?.source_record_id));
    // All five domain keys present
    for (const d of CROSS_DOMAIN_DOMAINS) assert.ok(view.domains[d]);
  });

  it("materialization corpus includes Parks as multi-domain demo", () => {
    const observations = collectCrossDomainObservations(ROOT);
    assert.ok(observations.length > 10, "expected warehouse + seed observations");
    const payments = observations.filter((o) => o.object_kind === "payment");
    assert.ok(payments.length >= 1, "expected checkbook payment fixtures");
    const doc = buildEntityIntelligenceDoc(ROOT);
    assert.ok(doc.multi_domain_count >= 1);
    assert.equal(doc.verified_demo?.ref, "agency:id:parks-and-recreation");
    assert.ok(doc.verified_demo.domains_matched >= 3);

    const hit = lookupEntityIntelligence(doc, {
      kind: "agency",
      name: "Department of Parks and Recreation",
    });
    assert.equal(hit.ok, true);
    assert.equal(hit.root.ref, "agency:id:parks-and-recreation");
    assert.ok(hit.domains.money.count + hit.domains.land.count >= 2);
    // Join-key edges present on multi-domain demo when fixtures carry PIN/BBL
    const joinTypes = new Set([
      "sited_on_parcel",
      "shares_authority_key",
      "references_contract",
      "contract_published_by_agency",
    ]);
    assert.ok(
      (hit.links || []).some((l) => joinTypes.has(l.type)),
      "expected at least one join-key edge on Parks",
    );

    // Miss returns honest empty, not fabricated links
    const miss = lookupEntityIntelligence(doc, {
      kind: "agency",
      name: "Office of the Unicorn",
    });
    assert.equal(miss.ok, true);
    assert.equal(miss.serve, "materialization_miss");
    assert.equal(miss.metrics.total_linked_objects, 0);
  });

  it("warehouse entity-intelligence index powers root lookup without re-scan", () => {
    const observations = collectCrossDomainObservations(ROOT);
    const indexDoc = buildEntityIntelligenceIndex(observations, {
      max_entities: 40,
      max_per_domain: 6,
    });
    assert.equal(indexDoc.version, ENTITY_INTELLIGENCE_INDEX_VERSION);
    assert.ok(indexDoc.edge_count > 0);
    assert.ok(indexDoc.join_key_edge_count > 0, "expected PIN/BBL/contract/payment edges");
    assert.ok(indexDoc.root_count >= 1);
    assert.ok(indexDoc.link_type_counts.paid_to_vendor >= 1);
    assert.ok(
      indexDoc.link_type_counts.shares_authority_key >= 1
        || indexDoc.link_type_counts.references_contract >= 1
        || indexDoc.link_type_counts.sited_on_parcel >= 1,
    );

    const fromIndex = lookupFromIndex(indexDoc, {
      kind: "agency",
      name: "Department of Parks and Recreation",
    });
    assert.equal(fromIndex.ok, true);
    assert.equal(fromIndex.serve, "warehouse_index");
    assert.equal(fromIndex.root.ref, "agency:id:parks-and-recreation");
    assert.ok(fromIndex.metrics.domains_matched >= 3);

    // Vendor payment chain: award named_vendor + payment paid_to_vendor share stem
    const vendorHit = lookupFromIndex(indexDoc, {
      kind: "vendor",
      name: "FIXTURE VENDOR E",
    });
    assert.equal(vendorHit.ok, true);
    if (vendorHit.serve === "warehouse_index") {
      const types = new Set((vendorHit.links || []).map((l) => l.type));
      assert.ok(types.has("named_vendor") || types.has("paid_to_vendor"));
    }
  });

  it("committed lookup artifact exists and matches rebuild shape", () => {
    const path = join(ROOT, "site/data/entity_intelligence_lookup.json");
    assert.ok(existsSync(path), "run node tools/build_entity_intelligence.mjs");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(doc.version, CROSS_DOMAIN_OBJECT_LINK_VERSION);
    assert.ok(doc.by_ref["agency:id:parks-and-recreation"]);
    assert.ok(doc.multi_domain_count >= 1);
    const parks = doc.by_ref["agency:id:parks-and-recreation"];
    assert.equal(parks.domains.money.status, "matched");
    assert.equal(parks.domains.land.status, "matched");
    assert.ok(parks.links[0].provenance.source_record_id);
  });
});

describe("agency GROUPS multi-surface aliases used by the layer", () => {
  it("HPD / DCP / DCAS land-or-money surfaces share canonical ids", () => {
    assert.equal(
      canonicalAgency("HPD - NYC Dept of Housing Preservation & Development").canonical_id,
      canonicalAgency("Housing Preservation and Development").canonical_id,
    );
    assert.equal(
      canonicalAgency("DCP Department of City Planning").canonical_id,
      canonicalAgency("City Planning").canonical_id,
    );
    assert.equal(
      canonicalAgency("Department of Citywide Administrative Services").canonical_id,
      canonicalAgency("Citywide Administrative Services").canonical_id,
    );
  });
});
