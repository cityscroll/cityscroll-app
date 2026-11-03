import test from "node:test";
import assert from "node:assert/strict";
import { fetchPublicDetail, summarizePublicDetail } from "../examples/external-procurement-detail-proof/index.mjs";

const noticeId = "20260807001";
const contractId = "procurement:contract:CTONE";

const notice = {
  ok: true,
  row: { request_id: noticeId, short_title: "Materialized notice", agency_name: "Department of Test", due_date: "2026-08-20" },
  source: "materialized", generated_at: "2026-08-07T11:00:00Z", stale: true,
  citation: {
    schema: "cityscroll.notice_get.citation.v1", publisher: "NYC City Record",
    request_id: noticeId, publication_date: "2026-08-07",
    cityscroll_url: `https://cityscroll.org/notices/${noticeId}/`,
    official_url: `https://a856-cityrecord.nyc.gov/RequestDetail/${noticeId}`,
  },
};

const contract = {
  capability_reference: "contract.get@1", availability: "available", error: null,
  contract: {
    object_type: "procurement", procurement_id: contractId, canonical_id: contractId,
    fields: { short_title: "Bridge inspection", agency_name: "Department of Design and Construction", primary_stage: "registered", official_url: "https://example.gov/contract" },
    amount: { value: 1250000, valid: true },
    coverage: {
      state: "observed",
      source_envelopes: {
        passport_public_contracts: { state: "observed", status: "available", generated_at: "2026-08-18T19:45:00Z" },
        city_record: { state: "not_published", status: "available", generated_at: "2026-08-18T19:40:00Z" },
      },
      not_published: ["city_record"], not_observed: [], not_yet_joined: ["vendor"],
      publication: { generated_by: "shared procurement read model" },
    },
    freshness: {
      as_of: "2026-08-18T20:00:00Z", generated_at: "2026-08-18T20:00:00Z",
      checked_at: "2026-08-18T20:01:00Z", sources: { passport_public_contracts: "available" },
    },
    provenance: {
      identity: { exact: true, canonical_id: contractId },
      source_observations: [{
        source_observation_ref: "passport:contract:CTONE", source_system: "passport_public_contracts",
        source_id: "contract:CTONE", ingested_at: "2026-08-18T19:46:32Z",
      }],
    },
    lifecycle: [{ stage: "registered" }],
  },
};

test("notice and contract consume different documented HTTP envelopes without importing app internals", async () => {
  const calls = [];
  const fetchImpl = (url) => {
    calls.push(url.toString());
    return new Response(JSON.stringify(calls.length === 1 ? notice : contract), { status: 200 });
  };
  const n = await fetchPublicDetail({ kind: "notice", id: noticeId, fetchImpl });
  const c = await fetchPublicDetail({ kind: "contract", id: contractId, fetchImpl });
  assert.equal(n.fact.citation.request_id, noticeId);
  assert.equal(n.fact.stale, true);
  assert.equal(c.fact.title, "Bridge inspection");
  assert.equal(c.fact.agency, "Department of Design and Construction");
  assert.deepEqual(c.fact.source_observations, contract.contract.provenance.source_observations);
  assert.equal(c.fact.coverage.state, "observed");
  assert.deepEqual(c.fact.coverage, contract.contract.coverage);
  assert.deepEqual(c.fact.freshness, contract.contract.freshness);
  assert.deepEqual(calls, [
    `https://api.cityscroll.org/notice?id=${noticeId}`,
    `https://api.cityscroll.org/contract?id=${encodeURIComponent(contractId)}`,
  ]);
});

test("absence and outage stay distinct from an observed empty fact", () => {
  assert.equal(summarizePublicDetail({ kind: "notice", id: noticeId, status: 404, body: { ok: false, reason: "not-found", source: "public-source", citation: null } }).state, "not_yet_public");
  assert.equal(summarizePublicDetail({ kind: "notice", id: noticeId, status: 503, body: { ok: false, reason: "unavailable", source: "public-source", citation: null } }).state, "unavailable");
  assert.equal(summarizePublicDetail({ kind: "contract", id: contractId, status: 404, body: { capability_reference: "contract.get@1", availability: "not_yet_public", contract: null, error: "not-found" } }).fact, null);
  assert.equal(summarizePublicDetail({ kind: "contract", id: contractId, status: 503, body: { capability_reference: "contract.get@1", availability: "unavailable", contract: null, error: "unavailable" } }).state, "unavailable");
});

test("nullable public clocks and citation dates retain their documented meaning", () => {
  const nullableCitation = {
    ...notice,
    citation: { ...notice.citation, publication_date: null },
  };
  assert.equal(summarizePublicDetail({ kind: "notice", id: noticeId, status: 200, body: nullableCitation }).fact.citation.publication_date, null);

  const nullableClock = {
    ...contract,
    contract: {
      ...contract.contract,
      provenance: {
        ...contract.contract.provenance,
        source_observations: contract.contract.provenance.source_observations.map((entry) => ({ ...entry, ingested_at: null })),
      },
    },
  };
  assert.deepEqual(
    summarizePublicDetail({ kind: "contract", id: contractId, status: 200, body: nullableClock }).fact.source_observations,
    nullableClock.contract.provenance.source_observations,
  );
});

test("available contracts may omit the optional search projection", () => {
  const fieldless = {
    ...contract,
    contract: { ...contract.contract, fields: undefined },
  };
  const result = summarizePublicDetail({ kind: "contract", id: contractId, status: 200, body: fieldless });
  assert.equal(result.state, "available");
  assert.equal(result.fact.procurement_id, contractId);
  assert.equal(result.fact.title, null);
  assert.equal(result.fact.agency, null);
  assert.equal(result.fact.stage, null);
  assert.equal(result.fact.official_url, null);
  assert.deepEqual(result.fact.source_observations, contract.contract.provenance.source_observations);
  assert.deepEqual(result.fact.coverage, contract.contract.coverage);
  assert.deepEqual(result.fact.freshness, contract.contract.freshness);
  assert.deepEqual(result.fact.amount, contract.contract.amount);
  assert.deepEqual(result.fact.lifecycle, contract.contract.lifecycle);
});

test("malformed identity, state, nullability, evidence, and private fields fail closed", () => {
  assert.throws(() => summarizePublicDetail({ kind: "notice", id: noticeId, status: 200, body: { ...notice, row: { request_id: "wrong" } } }), /identity/);
  assert.throws(() => summarizePublicDetail({ kind: "notice", id: noticeId, status: 200, body: { ...notice, citation: { ...notice.citation, official_url: `https://other.example/RequestDetail/${noticeId}` } } }), /identity/);
  assert.throws(() => summarizePublicDetail({ kind: "notice", id: noticeId, status: 200, body: { ...notice, citation: { ...notice.citation, publication_date: "2026-02-30" } } }), /citation/);
  assert.throws(() => summarizePublicDetail({ kind: "notice", id: noticeId, status: 200, body: { ...notice, citation: { ...notice.citation, publication_date: undefined } } }), /citation/);
  assert.throws(() => summarizePublicDetail({ kind: "notice", id: noticeId, status: 404, body: { ok: false, reason: "not-found", source: "public-source", citation: notice.citation } }), /envelope/);
  assert.throws(() => summarizePublicDetail({ kind: "contract", id: contractId, status: 200, body: { ...contract, contract: { ...contract.contract, provenance: { identity: { exact: true }, source_observations: [] }, raw_snapshot: "secret" } } }), /private field/);
  assert.throws(() => summarizePublicDetail({ kind: "contract", id: contractId, status: 200, body: { ...contract, contract: { ...contract.contract, provenance: { identity: { exact: true }, source_observations: [{}] } } } }), /source observations/);
  assert.throws(() => summarizePublicDetail({ kind: "contract", id: contractId, status: 200, body: { ...contract, contract: { ...contract.contract, canonical_id: "procurement:contract:OTHER" } } }), /identity/);
  assert.throws(() => summarizePublicDetail({ kind: "contract", id: contractId, status: 404, body: { capability_reference: "contract.get@1", availability: "not_yet_public", contract: contract.contract, error: "not-found" } }), /envelope/);
  assert.throws(() => summarizePublicDetail({ kind: "contract", id: contractId, status: 503, body: { capability_reference: "contract.get@1", availability: "unavailable", contract: null, error: "not-found" } }), /envelope/);
});
