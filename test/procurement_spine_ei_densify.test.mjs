/**
 * PASSPort census → entity-intelligence densify (EB-01).
 * Graph feed must use the population-backed census under a cap, not the 2-row
 * Checkbook-crosswalk compatibility examples alone.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  selectPassportContractsForMaterialization,
  selectCheckbookContractsForMaterialization,
  selectOcpAwardsForMaterialization,
  collectProcurementSpineObservations,
  slimProcurementMaterializationReceipt,
  DEFAULT_PASSPORT_CONTRACT_MATERIALIZATION_CAP,
  DEFAULT_CHECKBOOK_CONTRACT_MATERIALIZATION_CAP,
  DEFAULT_OCP_AWARD_MATERIALIZATION_CAP,
  buildEntityIntelligenceDoc,
} from "../tools/lib/entity_intelligence_build.mjs";
import {
  buildIntelligenceCorpus,
  observationFromMoneyRow,
  observationFromRulesRow,
} from "../entity_resolution/cross_domain/index.mjs";
import { buildEpinIndex, joinPinToEpin } from "../worker/src/lib/passport_join.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPINE = path.join(ROOT, "site/data/procurement_spine_sources.json");

describe("entity-intelligence root selection", () => {
  it("reserves every observable mandate agency and keeps the multi-domain floor", async () => {
    const doc = buildEntityIntelligenceDoc(ROOT);
    const obligations = JSON.parse(readFileSync(path.join(ROOT, "site/data/agency_obligations_lookup.json"), "utf8"));
    const mandateRefs = Object.entries(obligations.by_agency || {})
      .filter(([, agency]) => (agency?.obligations || []).length > 0)
      .map(([agencyId]) => `agency:id:${agencyId}`);
    const observableMandateRefs = mandateRefs.filter((ref) => doc.by_ref[ref]);
    assert.equal(observableMandateRefs.length, doc.selection.mandate_agency_selected);
    assert.ok(observableMandateRefs.every((ref) => doc.by_ref[ref]));
    assert.ok(doc.entity_count <= 200);
    assert.ok(doc.multi_domain_count >= 30);
    assert.equal(doc.selection.mandate_agency_selected, doc.selection.mandate_agency_candidates);
    assert.equal(doc.selection.mandate_agency_omitted, 0);
    assert.equal(doc.selection.reason_counts.multi_domain, doc.multi_domain_count);
    assert.equal(
      Object.values(doc.selection.reason_counts).reduce((sum, value) => sum + value, 0),
      doc.entity_count,
    );
  });

  it("lets a low-fan-out mandate agency beat an unrelated filler without displacing a multi-domain root", () => {
    const observations = [
      observationFromMoneyRow({ request_id: "multi-money", agency_name: "Parks and Recreation", vendor_name: "Multi Vendor" }),
      observationFromRulesRow({ request_id: "multi-rule", agency_name: "Parks and Recreation", title: "Multi Rule" }),
      observationFromMoneyRow({ request_id: "mandate-money", agency_name: "Department of Transportation", vendor_name: "Mandate Vendor" }),
      observationFromMoneyRow({ request_id: "filler-money", agency_name: "City Clerk", vendor_name: "Filler Vendor" }),
    ];
    const doc = buildIntelligenceCorpus(observations, {
      max_entities: 2,
      mandate_agency_refs: ["agency:id:transportation"],
    });
    const refs = doc.entities.map((entity) => entity.root.ref);
    assert.deepEqual(refs, [
      "agency:id:parks-and-recreation",
      "agency:id:transportation",
    ]);
    assert.equal(doc.multi_domain_count, 1);
    assert.deepEqual(doc.selection.reason_counts, {
      multi_domain: 1,
      mandate_agency_reserve: 1,
      richness_fill: 0,
    });
  });
});

describe("passport contract materialization selection", () => {
  it("prefers compatibility examples then fills from the population census under the cap", () => {
    const doc = {
      rows: {
        passport_contracts_materialization: [
          { ctr_id: "c-demo-1", epin: "AAA", vendor: "Demo One" },
          { ctr_id: "c-demo-2", epin: "BBB", vendor: "Demo Two" },
        ],
        passport_contracts: Array.from({ length: 20 }, (_, i) => ({
          ctr_id: `c-${i}`,
          epin: `EPIN${i}`,
          vendor: `Vendor ${i}`,
        })),
      },
    };
    const selected = selectPassportContractsForMaterialization(doc, { cap: 5 });
    assert.equal(selected.selected_rows, 5);
    assert.equal(selected.census_rows, 20);
    assert.equal(selected.compatibility_rows, 2);
    assert.equal(selected.rows[0].ctr_id, "c-demo-1");
    assert.equal(selected.rows[1].ctr_id, "c-demo-2");
    assert.equal(selected.rows[2].ctr_id, "c-0");
    assert.ok(selected.strategy.includes("population-backed census"));
  });

  it("dedupes compatibility rows already present in the census", () => {
    const doc = {
      rows: {
        passport_contracts_materialization: [
          { ctr_id: "shared", epin: "X", vendor: "Same" },
        ],
        passport_contracts: [
          { ctr_id: "shared", epin: "X", vendor: "Same" },
          { ctr_id: "only-census", epin: "Y", vendor: "Other" },
        ],
      },
    };
    const selected = selectPassportContractsForMaterialization(doc, { cap: 10 });
    assert.equal(selected.selected_rows, 2);
    assert.deepEqual(
      selected.rows.map((r) => r.ctr_id),
      ["shared", "only-census"],
    );
  });

  it("committed spine selection exceeds the historical 2-row fixture", () => {
    assert.ok(existsSync(SPINE), "procurement_spine_sources.json committed");
    const doc = JSON.parse(readFileSync(SPINE, "utf8"));
    assert.ok((doc.rows?.passport_contracts || []).length > 1000);
    const selected = selectPassportContractsForMaterialization(doc);
    assert.equal(selected.cap, DEFAULT_PASSPORT_CONTRACT_MATERIALIZATION_CAP);
    assert.ok(
      selected.selected_rows > 2,
      `expected densified passport materialization >2, got ${selected.selected_rows}`,
    );
    assert.ok(selected.selected_rows <= selected.cap);
    assert.ok((doc.materialization?.passport_contracts?.graph_cap || 0) >= 500);
  });
});

describe("OCP award materialization selection", () => {
  it("prefers awards whose PIN joins the selected PASSPort slice", () => {
    const passportRows = [
      { epin: "81626W0043001", vendor: "MAKE IT ZESTY LLC" },
      { epin: "07225W0020001", vendor: "Routerati Inc." },
    ];
    const awards = [
      { request_id: "old", pin: "806026008180", vendor_name: "Old Co", start_date: "2003-01-01" },
      { request_id: "joined-a", pin: "81626W0043001", vendor_name: "Make it Zesty LLC", start_date: "2026-07-30" },
      { request_id: "joined-b", pin: "07225W0020001", vendor_name: "Routerati Inc.", start_date: "2025-06-01" },
      { request_id: "recent", pin: "NOJOIN999", vendor_name: "Recent Co", start_date: "2026-01-01" },
    ];
    const selected = selectOcpAwardsForMaterialization(awards, passportRows, { cap: 3 });
    assert.equal(selected.selected_rows, 3);
    assert.equal(selected.joined_available, 2);
    assert.equal(selected.selected_joined, 2);
    assert.equal(selected.rows[0].request_id, "joined-a");
    assert.equal(selected.rows[1].request_id, "joined-b");
    // Fill is newest-first among non-joined (reverse of input order among rest).
    assert.equal(selected.rows[2].request_id, "recent");
    assert.equal(selected.cap, 3);
  });

  it("uses the default award cap constant", () => {
    const selected = selectOcpAwardsForMaterialization([], [], {});
    assert.equal(selected.cap, DEFAULT_OCP_AWARD_MATERIALIZATION_CAP);
    assert.equal(selected.selected_rows, 0);
  });
});

describe("Checkbook contract materialization selection", () => {
  it("dedupes exact contract ids and enforces the independent cap", () => {
    const doc = {
      sources: { checkbook_contracts: { population: { normalized_unique_contracts: 50 } } },
      rows: {
        checkbook_contracts: [
          { contract_id: "A", pin: "1" },
          { contract_id: "A", pin: "1" },
          { prime_contract_id: "B", pin: "2" },
          { contract_id: "C", pin: "3" },
        ],
      },
    };
    const selected = selectCheckbookContractsForMaterialization(doc, { cap: 2 });
    assert.deepEqual(selected.rows.map((row) => row.contract_id || row.prime_contract_id), ["A", "B"]);
    assert.equal(selected.population_rows, 50);
    assert.equal(selected.committed_slice_rows, 4);
    assert.equal(selected.selected_rows, 2);
  });
});

describe("procurement spine observation feed", () => {
  it("collects far more than two PASSPort contract observations from the live spine", () => {
    const spine = collectProcurementSpineObservations(ROOT);
    const contractObs = spine.observations.filter(
      (o) => o.object_kind === "contract" && /passport/i.test(o.source_system || ""),
    );
    assert.ok(
      contractObs.length > 2,
      `expected densified passport contract observations >2, got ${contractObs.length}`,
    );
    assert.ok(
      contractObs.length <= DEFAULT_PASSPORT_CONTRACT_MATERIALIZATION_CAP,
    );
    assert.equal(
      spine.materialization?.passport_contracts?.selected_rows,
      contractObs.length,
    );
    const receipt = slimProcurementMaterializationReceipt(spine.materialization);
    assert.equal(receipt.passport_contracts.selected_rows, contractObs.length);
    assert.equal(receipt.passport_contracts.rows, undefined);
    assert.equal(receipt.checkbook_contracts.rows, undefined);
  });

  it("collects a bounded population-backed Checkbook contract slice", () => {
    const spine = collectProcurementSpineObservations(ROOT);
    const contractObs = spine.observations.filter(
      (observation) => observation.object_kind === "contract" && /checkbook/i.test(observation.source_system || ""),
    );
    const doc = JSON.parse(readFileSync(SPINE, "utf8"));
    if (doc.sources?.checkbook_contracts?.population_backed) {
      assert.ok(contractObs.length > 1);
      assert.ok(contractObs.length <= DEFAULT_CHECKBOOK_CONTRACT_MATERIALIZATION_CAP);
      assert.equal(spine.materialization?.checkbook_contracts?.selected_rows, contractObs.length);
      assert.equal(
        spine.materialization?.checkbook_contracts?.population_rows,
        doc.sources.checkbook_contracts.population.normalized_unique_contracts,
      );
    }
  });

  it("selected passport slice joins real OCP award PINs via the existing join", () => {
    const spine = collectProcurementSpineObservations(ROOT);
    const ocpPath = path.join(ROOT, "site/data/ocp_awards_warehouse_lookup.json");
    assert.ok(existsSync(ocpPath));
    const ocp = JSON.parse(readFileSync(ocpPath, "utf8"));
    const selected = selectOcpAwardsForMaterialization(
      ocp.rows,
      spine.passport_rows,
      { cap: DEFAULT_OCP_AWARD_MATERIALIZATION_CAP },
    );
    assert.ok(
      selected.selected_joined > 50,
      `expected substantial joined awards in EI feed, got ${selected.selected_joined}`,
    );
    const epinIndex = buildEpinIndex(
      spine.passport_rows.map((r) => r.epin || r.epin_norm).filter(Boolean),
    );
    const sample = selected.rows.find((r) => joinPinToEpin(r.pin, epinIndex));
    assert.ok(sample?.pin, "at least one selected award joins the passport slice");
  });
});
