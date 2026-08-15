import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MANDATE_CONTRACT_EDGE_TYPE,
  MANDATE_CONTRACTS_METHOD,
  agencyMandateContractsPath,
  buildMandateContractsBridgeView,
  renderMandateContractsBridgeSection,
} from "../site/mandate_contracts_bridge.mjs";
import {
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";
import {
  CROSS_BRIDGE_MANDATE_SUBJECT_REF,
  CROSS_BRIDGE_OBLIGATION_ID,
} from "./helpers/mandate_subject.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOMELESS_SERVICES = "homeless-services";
const obligations = JSON.parse(
  readFileSync(join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8"),
);
const intelligence = JSON.parse(
  readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"),
);
const procurementAwards = JSON.parse(
  readFileSync(join(ROOT, "site/data/ocp_awards_warehouse_lookup.json"), "utf8"),
);

test("shareable path anchors the Mandates → Contracts section", () => {
  assert.equal(
    agencyMandateContractsPath(HOMELESS_SERVICES),
    "/agencies/homeless-services/#mandates-contracts",
  );
});

test("multi-key bridge requires agency, procurement intent, subject scope, and contract authority", () => {
  const view = buildMandateContractsBridgeView("buildings", {
    obligationsLookup: {
      by_agency: {
        buildings: {
          obligations: [{
            obligation_id: CROSS_BRIDGE_OBLIGATION_ID,
            duty_text: "Issue a request for proposals for elevator inspection services.",
            citation: "Local Law demo",
            source: { legistar_url: "https://example.test/law" },
          }],
        },
      },
    },
    intelligenceDossier: {
      domains: {
        money: {
          objects: [{
            object_kind: "solicitation",
            subject_ref: "notice:20260000001",
            request_id: "20260000001",
            label: "Elevator inspection services RFP",
            href: "#notice/20260000001",
            when: "2026-01-02",
            provenance: {
              source_system: "city_record",
              source_record_id: "city_record:20260000001",
              source_fields: ["agency_name", "short_title", "pin"],
            },
          }],
        },
      },
      links: [{
        type: "references_contract",
        from: "notice:20260000001",
        to: "contract:CT1-810-20268800001",
        method: "passport_contract_join_v1",
        confidence: "strong",
        provenance: {
          source_system: "passport-public-contracts",
          source_record_id: "passport-public-contracts:ct:CT1-810-20268800001",
          source_fields: ["epin", "pin"],
          basis: "procurement_pin_exact",
          input_value: "81026P0001001",
          related_source_system: "city_record",
          related_source_record_id: "city_record:20260000001",
        },
      }],
    },
  });

  assert.equal(view.status, "matched");
  assert.equal(view.method, MANDATE_CONTRACTS_METHOD);
  assert.equal(view.edges.length, 1);
  const edge = view.edges[0];
  assert.equal(edge.edge.type, MANDATE_CONTRACT_EDGE_TYPE);
  assert.equal(edge.edge.from, CROSS_BRIDGE_MANDATE_SUBJECT_REF);
  assert.equal(edge.mandate.subject_ref, CROSS_BRIDGE_MANDATE_SUBJECT_REF);
  assert.equal(edge.edge.to, "contract:CT1-810-20268800001");
  assert.deepEqual(edge.evidence.subject_scope_keys, ["elevator", "inspection"]);
  assert.equal(edge.evidence.procurement_action_key, "solicitation");
  assert.equal(edge.evidence.authority_key, "81026P0001001");
  assert.equal(edge.process_conformance.signal_kind, "procurement_contract");
  assert.equal(edge.process_conformance.status, "observed");
  assert.equal(edge.claim.how.warrant_class, "exact");
  assert.equal(edge.claim.confidence.standable, true);
});

test("agency-only and title-only candidates never render", () => {
  const view = buildMandateContractsBridgeView("buildings", {
    obligationsLookup: {
      by_agency: {
        buildings: {
          obligations: [{
            obligation_id: "demo-procurement-2",
            duty_text: "Issue a request for proposals for elevator inspection services.",
          }],
        },
      },
    },
    intelligenceDossier: {
      domains: {
        money: {
          objects: [{
            object_kind: "solicitation",
            subject_ref: "notice:unrelated",
            request_id: "unrelated",
            label: "Elevator inspection services RFP",
          }],
        },
      },
      links: [],
    },
  });
  assert.equal(view.status, "empty");
  assert.equal(renderMandateContractsBridgeSection(view), "");
});

test("committed live corpus links Homeless Services shelter mandates through award PINs to contracts", () => {
  const dossier = intelligence.by_ref["agency:id:homeless-services"];
  const view = buildMandateContractsBridgeView(HOMELESS_SERVICES, {
    obligationsLookup: obligations,
    intelligenceDossier: dossier,
    procurementAwards,
  });
  assert.equal(view.status, "matched");
  assert.ok(view.counts.mandates >= 1);
  assert.ok(view.counts.contracts >= 1);
  assert.ok(view.edges.some((row) => row.mandate_id === "66056-006"));
  assert.equal(view.counts.mandates, 1);
  assert.ok(view.counts.contracts >= 1);
  assert.ok(view.edges.some((row) => row.procurement_record.request_id === "20210820102"));
  assert.ok(view.edges.every((row) => /renewal/i.test(row.procurement_record.label)));
  assert.ok(view.edges.every((row) => row.contract.subject_ref.startsWith("contract:")));
  assert.ok(view.edges.every((row) => row.procurement_record.href.startsWith("/notices/")));
  assert.ok(view.edges.every((row) => row.evidence.authority_key));
  assert.equal(
    new Set(view.edges.map((row) => row.claim.claim_id)).size,
    view.edges.length,
    "each mandate → contract edge has its own inspector claim",
  );
  assert.match(view.follow_href, /lens=money/);
  assert.match(view.share_path, /#mandates-contracts$/);

  const html = renderMandateContractsBridgeSection(view);
  assert.match(html, /id="mandates-contracts"/);
  assert.match(html, /Mandates · Contracts and procurement/);
  // The contract is the linked civic object; its City Record notice remains separately labeled evidence.
  assert.match(html, /Contract · CT1-071-/);
  assert.match(html, /data-target-kind="procurement"/);
  assert.match(html, /Notice evidence/);
  assert.match(html, /data-target-kind="notice"/);
  assert.doesNotMatch(html, /href="\/notices\/[^"]+"[^>]*>Contract/);
  assert.doesNotMatch(html, /not yet|no matching|methodology|disclaimer|fabricat/i);
});

test("below-gate mandate-to-contract candidates remain evidence-only shadows", () => {
  const view = buildMandateContractsBridgeView(HOMELESS_SERVICES, {
    obligationsLookup: obligations,
    intelligenceDossier: intelligence.by_ref["agency:id:homeless-services"],
    crossSpineGate: {
      gate: {
        mandate_contract: {
          status: "pass",
          passed: false,
          precision: 0.89,
          min_precision: 0.9,
        },
      },
    },
  });

  assert.equal(view.status, "empty");
  assert.equal(view.edges.length, 0);
  assert.equal(view.shadow_edges.length, 1);
  assert.equal(view.shadow_edges[0].decision, "evidence_only");
  assert.match(view.shadow_edges[0].mandate, /^mandate:/);
  assert.equal(view.shadow_edges[0].edge_policy.tier, "evidence_only");
  assert.equal(renderMandateContractsBridgeSection(view), "");
});

test("constellation model registers claims and renders the standalone bridge section", () => {
  const view = buildAgencyConstellationView(HOMELESS_SERVICES, {
    intelligence,
    obligations,
    procurement_awards: procurementAwards,
  });
  assert.equal(view.mandates_contracts.status, "matched");
  assert.match(view.mandates_contracts_href, /#mandates-contracts$/);
  assert.ok(view.mandates_contracts.edges.every((row) => row.claim));
  for (const row of view.mandates_contracts.edges) {
    assert.ok(view.claims.some((claim) => claim.claim_id === row.claim.claim_id));
  }

  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /data-agency-constellation-card="mandates-contracts"/);
  assert.match(html, /data-edge-type="implemented_by_contract"/);
  assert.deepEqual(detectNodePageCruft(html), []);
});
