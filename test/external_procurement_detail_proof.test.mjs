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
  capability_reference: "contract.get@1", availability: "available",
  contract: {
    procurement_id: contractId,
    fields: { title: "Bridge inspection", agency: "Department of Design and Construction", primary_stage: "registered", official_url: "https://example.gov/contract" },
    amount: { value: 1250000, valid: true },
    coverage: { state: "observed", source_envelopes: { passport_public_contracts: { state: "observed" } } },
    freshness: { as_of: "2026-08-18T20:00:00Z" },
    provenance: { identity: { exact: true }, source_observations: [{ source_observation_ref: "passport:contract:CTONE" }] },
    lifecycle: [{ stage: "registered" }],
  },
};

test("notice and contract consume different documented HTTP envelopes without importing app internals", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.toString());
    return new Response(JSON.stringify(calls.length === 1 ? notice : contract), { status: 200 });
  };
  const n = await fetchPublicDetail({ kind: "notice", id: noticeId, fetchImpl });
  const c = await fetchPublicDetail({ kind: "contract", id: contractId, fetchImpl });
  assert.equal(n.fact.citation.request_id, noticeId);
  assert.equal(n.fact.stale, true);
  assert.equal(c.fact.source_observation_refs[0], "passport:contract:CTONE");
  assert.equal(c.fact.coverage.state, "observed");
  assert.deepEqual(calls, [
    `https://api.cityscroll.org/notice?id=${noticeId}`,
    `https://api.cityscroll.org/contract?id=${encodeURIComponent(contractId)}`,
  ]);
});

test("absence and outage stay distinct from an observed empty fact", () => {
  assert.equal(summarizePublicDetail({ kind: "notice", id: noticeId, status: 404, body: { ok: false, reason: "not-found" } }).state, "not_yet_public");
  assert.equal(summarizePublicDetail({ kind: "notice", id: noticeId, status: 503, body: { ok: false, reason: "unavailable" } }).state, "unavailable");
  assert.equal(summarizePublicDetail({ kind: "contract", id: contractId, status: 404, body: { capability_reference: "contract.get@1", availability: "not_yet_public" } }).fact, null);
  assert.equal(summarizePublicDetail({ kind: "contract", id: contractId, status: 503, body: { capability_reference: "contract.get@1", availability: "unavailable" } }).state, "unavailable");
});

test("wrong identity, missing source evidence, and private fields fail closed", () => {
  assert.throws(() => summarizePublicDetail({ kind: "notice", id: noticeId, status: 200, body: { ...notice, row: { request_id: "wrong" } } }), /identity/);
  assert.throws(() => summarizePublicDetail({ kind: "notice", id: noticeId, status: 200, body: { ...notice, citation: { ...notice.citation, official_url: `https://other.example/RequestDetail/${noticeId}` } } }), /identity/);
  assert.throws(() => summarizePublicDetail({ kind: "contract", id: contractId, status: 200, body: { ...contract, contract: { ...contract.contract, provenance: { identity: { exact: true }, source_observations: [] }, raw_snapshot: "secret" } } }), /private field/);
  assert.throws(() => summarizePublicDetail({ kind: "contract", id: contractId, status: 200, body: { ...contract, contract: { ...contract.contract, provenance: { identity: { exact: true }, source_observations: [{}] } } } }), /source observations/);
});
