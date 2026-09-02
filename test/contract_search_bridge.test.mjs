import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONTRACTS_BROWSE_SCOPE,
  CONTRACT_SCOPED_RETRIEVAL_IDLE,
  contractScopedRetrievalOutcome,
  contractScopedRetrievalRequest,
  contractScopedRetrievalUnavailable,
  contractSearchDocumentToMoneyRow,
  mergeContractSearchRows,
} from "../site/contract_search_bridge.mjs";
import { FEDERATED_SEARCH_PRESENTATION_SCOPES } from "../capabilities/federated_search.mjs";
import { searchContractAwardDocuments } from "../site/contract_award_search_producer.mjs";
import { filterMoneySnapshot } from "../site/resident_snapshot_queries.mjs";

function cityRecordDocument(pin, requestId, title) {
  return {
    schema: "cityscroll.search_document.v1",
    object_ref: `procurement:${pin}`,
    object_type: "procurement",
    domain: "contracts",
    canonical_href: `/browse/contracts/?mode=award&q=${pin}`,
    title,
    summary: `Public comment notice for contract ${pin}.`,
    search_text: `${title} ${pin}`,
    source_family: "city_record_notice",
    source_observation_refs: [`notice:${requestId}`],
    process_role: "award",
    classification: { method: "canonical_procurement_projection", basis: "stable identifier" },
    provenance: { producer: "city_record_search_document.v1" },
    outcome: "indexed",
    coverage_state: "matched",
  };
}

test("current D1 contract SearchDocuments recover Browse award rows for regressed PINs", () => {
  const documents = [
    cityRecordDocument(
      "05626S0012",
      "20260807032",
      "Fixed Wing aircraft program management support services.",
    ),
    cityRecordDocument(
      "05626W0023001",
      "20260731016",
      "Fire Alarm Maintenance and Repair for the boroughs of Manhattan & Bronx",
    ),
  ];
  const rows = documents.map(contractSearchDocumentToMoneyRow);
  assert.deepEqual(rows.map((row) => row.pin), ["05626S0012", "05626W0023001"]);
  assert.deepEqual(rows.map((row) => row.request_id), ["20260807032", "20260731016"]);
  assert.ok(rows.every((row) => row.primary_stage === "award"));
  assert.ok(rows.every((row) => !Object.hasOwn(row, "type_of_notice_description")));

  const merged = mergeContractSearchRows([
    { request_id: "old", pin: "OLD-1", type_of_notice_description: "Award" },
  ], documents);
  assert.deepEqual(merged.map((row) => row.request_id), ["old", "20260807032", "20260731016"]);
});

test("the Browse bridge rejects evidence-only notices and inconsistent contract identity", () => {
  const valid = cityRecordDocument("05626S0012", "20260807032", "Fixed Wing aircraft support");
  assert.equal(contractSearchDocumentToMoneyRow({ ...valid, outcome: "evidence_only" }), null);
  assert.equal(contractSearchDocumentToMoneyRow({ ...valid, domain: null }), null);
  assert.equal(contractSearchDocumentToMoneyRow({
    ...valid,
    provenance: {
      browse_record: { request_id: "20260807032", pin: "OTHER" },
      producer: "fixture",
    },
  }), null);
});

test("the Contracts award query path augments the bounded resident snapshot from universal search", () => {
  const source = readFileSync(new URL("../site/app/money-list.mjs", import.meta.url), "utf8");
  assert.match(source, /loadContractScopedRetrieval\(retrievalQuery,contractIdentity\)/);
  assert.match(source, /workerFetch\(request\.path,null,SLOW_MS\)/);
  assert.match(source, /const retrievalQuery=kw\|\|scopedVendorStem/);
  assert.match(source, /contractObjectRef:contractIdentity\?\.object_ref\|\|""/);
  assert.match(source, /mergeContractSearchRows\(retainedRows,scopedRetrieval\.documents\)/);
  assert.match(source, /loadMoneyProcurementSnapshot\(\{\.\.\.common,method:methodSel\},\[\]\)/);
  assert.match(source, /loadMoneyProcurementSnapshot\(\{\.\.\.common,method:methodSel\},searchedRows\)/);
  assert.match(source, /mergeCanonicalProcurementBrowseRows\(searchedRows,hydrated\.rows\)/);
  // Retrieval is no longer gated on the award/archive read models: every keyword
  // and exact reference goes to the capability, in every Browse mode.
  assert.match(source, /const needsSearch=Boolean\(contractIdentity\|\|retrievalQuery\)/);
  // The transport failure path resolves to a disclosed outcome, never to [].
  assert.match(source, /contractScopedRetrievalUnavailable\(request,error\?\.message\)/);
  assert.doesNotMatch(source, /\.catch\(\(\)=>\[\]\)/);
});

test("the spaced vendor pivot returns all 16 retained P&T II awards in-window", () => {
  const lookup = JSON.parse(readFileSync(
    new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url),
    "utf8",
  ));
  const documents = searchContractAwardDocuments(lookup, "P T II CONTRACTING", { limit: 100 }).documents;
  const rows = mergeContractSearchRows([], documents);
  const matched = filterMoneySnapshot(rows, {
    mode: "award",
    entityRefs: ["vendor:stem:P T II CONTRACTING"],
    limit: rows.length,
  });
  assert.equal(matched.length, 16);
  assert.ok(matched.every((row) => /P\s*&\s*T II Contracting/i.test(row.vendor_name)));
});

function scopedPayload(documents, byLens = { notices: { state: "matched", as_of: "2026-09-01" }, vendors: { state: "empty", as_of: "2026-08-30" } }) {
  return {
    schema: "cityscroll.universal_search_response.v1",
    capability_reference: "search.federated@1",
    results: documents,
    federated: { coverage: { by_lens: byLens } },
  };
}

test("Contracts Browse asks the capability the registered Contracts scope, and only that", () => {
  const request = contractScopedRetrievalRequest({ query: "  mosquito   control " });
  assert.equal(request.match_mode, "scoped_keyword");
  assert.equal(request.query, "mosquito control");
  assert.deepEqual([...request.lenses], [...FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.lenses]);
  assert.equal(request.path, "/search?q=mosquito+control&scope=notices&scope=vendors");
  // The lane the search front door renders and the Browse request are the same
  // registered scope object, so the two surfaces cannot drift apart.
  assert.equal(CONTRACTS_BROWSE_SCOPE, FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts);

  // The same query is the same request no matter which Browse mode is showing.
  assert.equal(contractScopedRetrievalRequest({ query: "mosquito control" }).path, request.path);
  assert.equal(contractScopedRetrievalRequest({ query: "" }), null);
  assert.equal(contractScopedRetrievalRequest({}), null);
  assert.equal(contractScopedRetrievalRequest({ query: "x".repeat(400) }).query.length, 240);
});

test("an exact object reference stays an exact lookup and requests no lens scope", () => {
  const request = contractScopedRetrievalRequest({
    query: "ignored when an object reference is present",
    identity: { object_ref: "procurement:05626S0012", source_observation_ref: "notice:20260807032" },
  });
  assert.equal(request.match_mode, "exact_object_ref");
  assert.equal(request.path, "/search?object_ref=procurement%3A05626S0012&source_ref=notice%3A20260807032");
  assert.deepEqual([...request.lenses], []);
  assert.ok(!request.path.includes("scope="));
});

test("a provider failure is an unavailable outcome, never an empty contract set", () => {
  const request = contractScopedRetrievalRequest({ query: "mosquito" });
  const down = contractScopedRetrievalOutcome(
    scopedPayload([], { notices: { state: "provider_unavailable" }, vendors: { state: "empty", as_of: "2026-09-01" } }),
    request,
  );
  assert.equal(down.outcome, "unavailable");
  assert.equal(down.coverage_state, "provider_unavailable");
  assert.deepEqual(down.lens_coverage.map((row) => row.state), ["provider_unavailable", "empty"]);

  const transportFailure = contractScopedRetrievalUnavailable(request, "HTTP 503");
  assert.equal(transportFailure.outcome, "unavailable");
  assert.equal(transportFailure.documents.length, 0);
  assert.equal(transportFailure.reason, "HTTP 503");
  assert.deepEqual([...transportFailure.requested_lenses], [...CONTRACTS_BROWSE_SCOPE.lenses]);

  // Each of the five states a Browse surface must be able to tell apart.
  assert.equal(CONTRACT_SCOPED_RETRIEVAL_IDLE.outcome, "idle");
  assert.equal(contractScopedRetrievalOutcome(scopedPayload([]), request).outcome, "empty");
  assert.equal(
    contractScopedRetrievalOutcome(
      scopedPayload([], { notices: { state: "stale", as_of: "2026-06-01" }, vendors: { state: "matched", as_of: "2026-09-02" } }),
      request,
    ).outcome,
    "partial",
  );
});

test("the scoped outcome keeps capability rank order, the contracts domain, and its freshness", () => {
  const first = cityRecordDocument("05626S0012", "20260807032", "Fixed Wing aircraft support");
  const second = cityRecordDocument("05626W0023001", "20260731016", "Fire Alarm Maintenance");
  const offDomain = { ...cityRecordDocument("05626X0001", "20260731017", "Vendor profile"), domain: "vendors" };
  const request = contractScopedRetrievalRequest({ query: "aircraft" });
  const outcome = contractScopedRetrievalOutcome(scopedPayload([first, offDomain, second]), request);

  assert.equal(outcome.outcome, "matched");
  assert.deepEqual(outcome.documents.map((document) => document.object_ref), [first.object_ref, second.object_ref]);
  assert.equal(outcome.candidate_count, 2);
  assert.equal(outcome.as_of, "2026-09-01");
  assert.equal(outcome.coverage_reported, true);
  assert.equal(outcome.source, CONTRACTS_BROWSE_SCOPE.source);

  // The rows Browse renders are the same documents, in the same order.
  const rows = mergeContractSearchRows([], outcome.documents);
  assert.deepEqual(rows.map((row) => row.procurement_id), [first.object_ref, second.object_ref]);
});

test("a response that carried no coverage receipt does not invent one", () => {
  const request = contractScopedRetrievalRequest({ query: "mosquito" });
  const outcome = contractScopedRetrievalOutcome({ results: [] }, request);
  assert.equal(outcome.coverage_reported, false);
  assert.deepEqual([...outcome.lens_coverage], []);
  assert.equal(outcome.outcome, "empty");
});

test("the worker Contracts lane and Contracts Browse read one registered scope", () => {
  const worker = readFileSync(new URL("../worker/src/search.mjs", import.meta.url), "utf8");
  assert.match(worker, /FEDERATED_SEARCH_PRESENTATION_SCOPES\.contracts\.lenses/);
  assert.match(worker, /FEDERATED_SEARCH_PRESENTATION_SCOPES\.contracts\.domains/);
  assert.match(worker, /FEDERATED_SEARCH_PRESENTATION_SCOPES\.contracts\.source/);
});
