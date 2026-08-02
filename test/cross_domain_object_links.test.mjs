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
  observationFromPeopleRow,
  observationsFromRulesMaterialization,
  observationsFromMeetingsMaterialization,
  observationsFromPeopleMaterialization,
  linkObservation,
  joinKeyLinksForObservation,
  buildEntityIntelligence,
  buildIntelligenceCorpus,
  lookupEntityIntelligence,
  makeObjectLink,
  makeProvenance,
  extractMeetingLandRefs,
  extractZapProjectIds,
  joinMeetingsToLandProjects,
  stampMeetingLandLinksOnCorpus,
  MEETING_LAND_ULURP_METHOD,
  MEETING_LAND_ZAP_METHOD,
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
    // People is a live domain — empty for this entity means empty_in_corpus, not
    // a permanent not_yet_ingested product gap.
    assert.equal(view.domains.people.status, "empty");
    assert.equal(view.domains.people.count, 0);
  });

  it("links person-level votes to City Council as people objects", () => {
    const obs = observationFromPeopleRow({
      person_id: "7801",
      person_name: "Christopher Marte",
      vote: "Affirmative",
      vote_bucket: "aye",
      matter_id: "79193",
      matter_file: "LU 0112-2026",
      event_id: "22526",
      request_id: "20260706036",
      agency_name: "City Council",
      event_date: "2026-07-14",
      source_system: "legistar",
    });
    assert.ok(obs);
    assert.equal(obs.domain, "people");
    assert.equal(obs.subject_ref, "entity:official:7801");
    const { objects, links } = linkObservation(obs);
    assert.equal(objects.length, 1);
    assert.equal(objects[0].link_type, "votes_as_official");
    assert.equal(objects[0].root_ref, "agency:id:city-council");
    assert.match(objects[0].href || "", /#official\/7801/);
    assert.equal(links[0].type, "votes_as_official");
    assert.equal(links[0].to, "agency:id:city-council");

    const view = buildEntityIntelligence(
      { kind: "agency", name: "City Council" },
      [obs],
    );
    assert.equal(view.ok, true);
    assert.equal(view.domains.people.status, "matched");
    assert.equal(view.domains.people.count, 1);
    assert.equal(view.domains.people.objects[0].subject_ref, "entity:official:7801");
  });

  it("observationsFromPeopleMaterialization walks by_person and skips tally_only", () => {
    const rows = observationsFromPeopleMaterialization({
      request_id: "20260706036",
      notice: { agency: "City Council" },
      council_event: { event_id: "22526", event_date: "2026-07-14" },
      agenda_items: [
        {
          matters: [
            {
              matter_id: "1",
              matter_file: "LU 1",
              title: "Demo",
              votes: [
                {
                  vote_identity: "roll_call",
                  by_person: [
                    {
                      person_id: "7801",
                      person_name: "Christopher Marte",
                      vote_value: "Affirmative",
                      vote_bucket: "aye",
                      official: { id: "official:7801", display_name: "Christopher Marte" },
                    },
                  ],
                },
                {
                  vote_identity: "tally_only",
                  counts: { aye: 5, nay: 0 },
                  by_person: [],
                },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].person_id, "7801");
    assert.equal(rows[0].agency_name, "City Council");
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
    // No person rows in this unit fixture — people is empty (not permanent theater).
    assert.equal(view.domains.people.status, "empty");
    // property is empty in this fixture set (no disposition rows) — 4 of 6 domains
    assert.equal(view.domains.property.status, "empty");
    assert.equal(view.metrics.domains_matched, 4);
    assert.ok(view.metrics.coverage_rate >= 4 / CROSS_DOMAIN_DOMAINS.length);
    assert.ok(view.links.every((l) => l.provenance?.source_system && l.provenance?.source_record_id));
    // All domain keys present (money, land, property, rules, meetings, people)
    for (const d of CROSS_DOMAIN_DOMAINS) assert.ok(view.domains[d]);
  });

  it("materialization corpus includes live people observations and Council people matched", () => {
    const observations = collectCrossDomainObservations(ROOT);
    assert.ok(observations.length > 10, "expected warehouse + seed observations");
    const payments = observations.filter((o) => o.object_kind === "payment");
    assert.ok(payments.length >= 1, "expected checkbook payment fixtures");
    const rulesObs = observations.filter((o) => o.domain === "rules");
    const meetingsObs = observations.filter((o) => o.domain === "meetings");
    const peopleObs = observations.filter((o) => o.domain === "people");
    // Live domain snapshots replace seed-thin 3+4 rows
    assert.ok(rulesObs.length >= 20, `expected dense live rules observations, got ${rulesObs.length}`);
    assert.ok(meetingsObs.length >= 20, `expected dense live meetings observations, got ${meetingsObs.length}`);
    assert.ok(rulesObs.every((o) => o.source_record_id && o.agency_name));
    assert.ok(meetingsObs.every((o) => o.source_record_id && o.agency_name));
    // People densified from by_person snapshot (multi-notice roll_call, field case Marte)
    assert.ok(peopleObs.length >= 1, `expected people observations, got ${peopleObs.length}`);
    assert.ok(peopleObs.every((o) => o.person_id && o.person_name && o.subject_ref));
    assert.ok(peopleObs.some((o) => o.person_id === "7801" || /Marte/i.test(o.person_name || "")));
    const peopleNotices = new Set(
      peopleObs.map((o) => String(o.request_id || "")).filter(Boolean),
    );
    const peopleEvents = new Set(
      peopleObs.map((o) => String(o.event_id || "")).filter(Boolean),
    );
    assert.ok(
      peopleNotices.size >= 2,
      `expected people observations from ≥2 notices after densify, got ${peopleNotices.size}`,
    );
    assert.ok(
      peopleEvents.size >= 2,
      `expected people observations from ≥2 events after densify, got ${peopleEvents.size}`,
    );

    const doc = buildEntityIntelligenceDoc(ROOT);
    assert.ok(doc.multi_domain_count >= 1);
    // Demo prefers an entity with people matched when available (City Council).
    assert.ok(doc.verified_demo?.ref);
    const demoView = lookupEntityIntelligence(doc, { ref: doc.verified_demo.ref });
    assert.equal(demoView.domains.people.status, "matched");
    assert.ok(demoView.domains.people.count >= 1);
    // More than one official on the people domain (not a single-seed skim).
    assert.ok(
      demoView.domains.people.count > 1,
      `demo people should list >1 official after densify, got ${demoView.domains.people.count}`,
    );
    const demoOfficials = new Set(
      (demoView.domains.people.objects || []).map((o) => String(o.subject_ref || "")),
    );
    const demoEventIds = new Set(
      (demoView.domains.people.objects || [])
        .map((o) => String(o.event_id || ""))
        .filter(Boolean),
    );
    assert.ok(demoOfficials.size > 1, "demo people shows more than one official");
    assert.ok(
      demoEventIds.size > 1,
      `demo people should surface >1 event after multi-notice densify, got ${demoEventIds.size}`,
    );
    assert.ok(
      (doc.provenance?.sources || []).some((s) => String(s).includes("rules_domain_observations")),
      "provenance lists rules domain snapshot",
    );
    assert.ok(
      (doc.provenance?.sources || []).some((s) => String(s).includes("meetings_domain_observations")),
      "provenance lists meetings domain snapshot",
    );
    assert.ok(
      (doc.provenance?.sources || []).some((s) => String(s).includes("people_domain_observations")),
      "provenance lists people domain snapshot",
    );

    const council = lookupEntityIntelligence(doc, {
      kind: "agency",
      name: "City Council",
    });
    assert.equal(council.domains.people.status, "matched");
    assert.ok(council.domains.people.count >= 1);

    const hit = lookupEntityIntelligence(doc, {
      kind: "agency",
      name: "Department of Parks and Recreation",
    });
    assert.equal(hit.ok, true);
    assert.equal(hit.root.ref, "agency:id:parks-and-recreation");
    assert.ok(hit.domains.money.count + hit.domains.land.count >= 2);
    assert.equal(hit.domains.rules.status, "matched");
    assert.equal(hit.domains.meetings.status, "matched");
    assert.ok(hit.domains.rules.count >= 1);
    assert.ok(hit.domains.meetings.count >= 1);
    assert.ok(
      (hit.links || []).some((l) => l.type === "issued_rule" && l.provenance?.source_record_id),
      "Parks issued_rule edges carry provenance",
    );
    assert.ok(
      (hit.links || []).some((l) => l.type === "hosts_meeting" && l.provenance?.source_record_id),
      "Parks hosts_meeting edges carry provenance",
    );
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

  it("extracts observations from rules + meeting-outcomes materialization shapes", () => {
    const rulesView = JSON.parse(
      readFileSync(
        join(ROOT, "worker/test/fixtures/entity-intelligence/rules_materialized_v2.json"),
        "utf8",
      ),
    );
    const meetingsView = JSON.parse(
      readFileSync(
        join(ROOT, "worker/test/fixtures/entity-intelligence/meeting_outcomes_materialized_v2.json"),
        "utf8",
      ),
    );
    const rulesObs = observationsFromRulesMaterialization(rulesView);
    assert.ok(rulesObs.length >= 2);
    assert.ok(rulesObs.every((o) => o.domain === "rules" && o.agency_name && o.source_record_id));
    // Nested city_record.agency field is accepted
    assert.ok(rulesObs.some((o) => /parks/i.test(o.agency_name)));

    const meetingsObs = observationsFromMeetingsMaterialization(meetingsView);
    assert.ok(meetingsObs.length >= 2);
    assert.ok(meetingsObs.every((o) => o.domain === "meetings" && o.agency_name));
    const council = meetingsObs.find((o) => o.request_id === "20260706036");
    assert.ok(council);
    assert.equal(council.event_id, "22526");
    // Nested notice.agency + council_event accepted with provenance-ready keys
    const { links } = linkObservation(council);
    assert.ok(links.some((l) => l.type === "hosts_meeting"));
    assert.ok(links.every((l) => l.provenance?.source_system && l.provenance?.source_record_id));
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
    assert.equal(parks.domains.rules.status, "matched");
    assert.equal(parks.domains.meetings.status, "matched");
    assert.ok(parks.links[0].provenance.source_record_id);

    // Domain snapshots densify beyond the old 3 rules + 4 meetings seeds
    const rulesSnap = join(ROOT, "site/data/rules_domain_observations.json");
    const meetingsSnap = join(ROOT, "site/data/meetings_domain_observations.json");
    assert.ok(existsSync(rulesSnap), "rules domain snapshot committed");
    assert.ok(existsSync(meetingsSnap), "meetings domain snapshot committed");
    const rDoc = JSON.parse(readFileSync(rulesSnap, "utf8"));
    const mDoc = JSON.parse(readFileSync(meetingsSnap, "utf8"));
    assert.ok((rDoc.rows || []).length >= 20);
    assert.ok((mDoc.rows || []).length >= 20);
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

describe("meeting → land reverse object-link (ULURP / ZAP)", () => {
  const LAND_TIMBALE = observationFromLandRow({
    project_id: "2022M0258",
    project_name: "Timbale Terrace",
    primary_applicant: "HPD - NYC Dept of Housing Preservation & Development",
    public_status: "Completed",
    ulurp_numbers: "240046HAM; 240047PQM",
  });

  it("extracts ULURP tokens and ZAP project URLs from hearing body text", () => {
    const refs = extractMeetingLandRefs({
      short_title: "City Planning Commission public hearing",
      additional_description_1:
        "Application C 240046 HAM and related actions. See also "
        + "https://zap.planning.nyc.gov/projects/2022M0258 for the project record.",
    });
    assert.ok(refs.ulurp_keys.includes("240046HAM"));
    assert.ok(refs.zap_project_ids.includes("2022M0258"));
    assert.equal(extractZapProjectIds("no portal link here").size, 0);
    assert.equal(extractMeetingLandRefs("plain hearing agenda with no land keys").ulurp_keys.length, 0);
  });

  it("hearing body with a ULURP number produces decides_land_project when land resolves", () => {
    const hearing = observationFromMeetingsRow({
      request_id: "20240801001",
      agency_name: "City Planning Commission",
      short_title: "Public hearing on ULURP application",
      event_date: "2024-09-15",
      additional_description_1:
        "NOTICE IS HEREBY GIVEN that the City Planning Commission will hold a public "
        + "hearing on Application No. C 240046 HAM (Timbale Terrace) and 240047PQM.",
    });
    assert.ok(hearing);
    assert.ok(hearing.ulurp_keys.includes("240046HAM") || hearing.ulurp_keys.includes("C240046HAM"));

    const join = joinMeetingsToLandProjects([hearing], [LAND_TIMBALE]);
    assert.equal(join.metrics.matched_meeting_count, 1);
    assert.ok(join.links.length >= 1);
    const edge = join.links.find((l) => l.type === "decides_land_project");
    assert.ok(edge, "expected decides_land_project edge");
    assert.equal(edge.from, "notice:20240801001");
    assert.equal(edge.to, "project:2022M0258");
    assert.equal(edge.domain, "meetings");
    assert.equal(edge.method, MEETING_LAND_ULURP_METHOD);
    assert.ok(edge.provenance?.source_system);
    assert.ok(edge.provenance?.source_record_id);
    assert.ok(
      edge.provenance.source_fields.includes("body")
        || edge.provenance.source_fields.includes("ulurp_numbers"),
    );
    assert.equal(join.by_notice["20240801001"].status, "matched");
    assert.equal(join.by_notice["20240801001"].related_projects[0].project_id, "2022M0258");
  });

  it("hearing body with a ZAP project URL produces reverse link when project is known", () => {
    const hearing = observationFromMeetingsRow({
      request_id: "20240801002",
      agency_name: "City Planning Commission",
      short_title: "ZAP project hearing",
      event_date: "2024-10-01",
      additional_description_1:
        "The project record is at https://zap.planning.nyc.gov/projects/2022M0258.",
    });
    const join = joinMeetingsToLandProjects([hearing], [LAND_TIMBALE]);
    const edge = join.links.find((l) => l.type === "decides_land_project");
    assert.ok(edge);
    assert.equal(edge.to, "project:2022M0258");
    assert.equal(edge.method, MEETING_LAND_ZAP_METHOD);
  });

  it("hearing body with no ULURP/ZAP ref produces no land reverse link", () => {
    const hearing = observationFromMeetingsRow({
      request_id: "20240801003",
      agency_name: "Parks and Recreation",
      short_title: "Concession hearing for outdoor café",
      event_date: "2024-08-10",
      additional_description_1:
        "A public hearing will be held regarding a proposed outdoor café concession. "
        + "No land-use application number is cited.",
    });
    assert.equal(hearing.ulurp_keys.length, 0);
    assert.equal(hearing.zap_project_ids.length, 0);

    const join = joinMeetingsToLandProjects([hearing], [LAND_TIMBALE]);
    assert.equal(join.links.length, 0);
    assert.equal(join.metrics.matched_meeting_count, 0);
    assert.equal(join.by_notice["20240801003"].status, "no_ref");
  });

  it("ULURP in body that does not hit a known land project produces no link (honest punt)", () => {
    const hearing = observationFromMeetingsRow({
      request_id: "20240801004",
      agency_name: "City Planning Commission",
      short_title: "Hearing on unknown ULURP",
      additional_description_1: "Application C 999999 ZMK is on the calendar.",
    });
    assert.ok(hearing.ulurp_keys.length >= 1, "extractor still finds the token");
    const join = joinMeetingsToLandProjects([hearing], [LAND_TIMBALE]);
    assert.equal(join.links.length, 0);
    assert.equal(join.by_notice["20240801004"].status, "no_land_match");
  });

  it("corpus stamp attaches decides_land_project side edge on agency intelligence view", () => {
    const hearing = observationFromMeetingsRow({
      request_id: "20240801005",
      agency_name: "Housing Preservation and Development",
      short_title: "HPD ULURP hearing",
      event_date: "2024-09-01",
      additional_description_1: "ULURP No. 240046HAM for Timbale Terrace.",
    });
    const stamped = stampMeetingLandLinksOnCorpus([hearing, LAND_TIMBALE]);
    const meeting = stamped.find((o) => o.domain === "meetings");
    assert.ok(meeting.related_projects?.some((p) => p.project_id === "2022M0258"));

    const { links } = linkObservation(meeting);
    assert.ok(links.some((l) => l.type === "hosts_meeting"));
    assert.ok(links.some((l) => l.type === "decides_land_project" && l.to === "project:2022M0258"));

    const view = buildEntityIntelligence(
      { kind: "agency", name: "Housing Preservation and Development" },
      [hearing, LAND_TIMBALE],
    );
    assert.equal(view.ok, true);
    assert.ok(
      (view.links || []).some(
        (l) => l.type === "decides_land_project" && l.to === "project:2022M0258",
      ),
      "HPD agency view surfaces meeting→land reverse edge",
    );
  });
});
