// GET /organization-search and GET /vendor-profile?ref=: HTTP status per answer, CORS, cache headers,
// fail-closed reads. The published files are served from an in-memory map instead of Pages.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { buildIndex } from "../../tools/lib/organization_index_build.mjs";
import { handleOrganizationSearch, handleOrganizationRecord, resetOrganizationIndexForTests } from "../src/organization_search_route.mjs";

const contributions = [
  { source: "ocp_recent_contract_awards", name: "Xerox Corporation", via: "name", ref: "20240101001", amount: 1000, date: "2024-01-01", agency: "DCAS", zip: null, extra: null },
  { source: "sbs_certified_businesses", name: "Takbeer Enterprises, Inc.", via: "name", ref: "473", amount: null, date: null, agency: null, zip: "11590", extra: { certification: ["MBE"] } },
];
const built = buildIndex(contributions, { built_from: "worker test" });
const files = () => new Map([...built.files].map(([p, t]) => [p, JSON.parse(t)]));
let served;
const reader = async (p) => { if (!served.has(p)) throw new Error(`${p} 404`); return served.get(p); };
beforeEach(() => { served = files(); resetOrganizationIndexForTests(); });

const req = (path, origin = "https://cityscroll.org") => new Request(`https://api.cityscroll.org${path}`, { headers: { Origin: origin } });

test("matched and no_match answer 200 with the public cache header", async () => {
  const hit = await handleOrganizationSearch(req("/organization-search?q=Xerox%20Corp"), {}, { readFile: reader });
  assert.equal(hit.status, 200);
  assert.match(hit.headers.get("Cache-Control"), /max-age=60/);
  const body = await hit.json();
  assert.equal(body.status, "matched");
  assert.equal(body.results[0].entity_ref, "org:XEROX");
  const miss = await handleOrganizationSearch(req("/organization-search?q=Zxqvbk%20Quillfeather"), {}, { readFile: reader });
  assert.equal(miss.status, 200);
  assert.equal((await miss.json()).status, "no_match");
});

test("query_refused is 400, not_indexed is 503 and never cached", async () => {
  const bad = await handleOrganizationSearch(req("/organization-search?q=ab"), {}, { readFile: reader });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).status, "query_refused");
  served.delete("data/organization_index/stems.json");
  resetOrganizationIndexForTests(); // a new isolate: the open index is cached per isolate
  const down = await handleOrganizationSearch(req("/organization-search?q=Xerox"), {}, { readFile: reader });
  assert.equal(down.status, 503);
  assert.equal(down.headers.get("Cache-Control"), "no-store");
  assert.equal((await down.json()).status, "not_indexed");
});

test("origin allowlist and methods follow the /search contract", async () => {
  assert.equal((await handleOrganizationSearch(req("/organization-search?q=Xerox", "https://evil.example"), {}, { readFile: reader })).status, 403);
  const post = await handleOrganizationSearch(new Request("https://api.cityscroll.org/organization-search?q=x", { method: "POST", headers: { Origin: "https://cityscroll.org" } }), {}, { readFile: reader });
  assert.equal(post.status, 405);
});

test("record: found with blocks; SBS directory unreadable gives a not_available block, not an error", async () => {
  const res = await handleOrganizationRecord(req("/vendor-profile?ref=org%3ATAKBEER%20ENTERPRISES"), {}, { readFile: reader, cors: { "Access-Control-Allow-Origin": "*" } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.schema, "cityscroll.organization_record.v1");
  assert.equal(body.status, "found");
  const sbs = body.blocks.find((b) => b.block === "sbs_certified_business");
  assert.equal(sbs.status, "not_available");
  const none = await handleOrganizationRecord(req("/vendor-profile?ref=org%3AZXQVBK"), {}, { readFile: reader });
  assert.equal((await none.json()).status, "no_match");
  const refused = await handleOrganizationRecord(req("/vendor-profile?ref=vendor%3AXEROX"), {}, { readFile: reader });
  assert.equal(refused.status, 400);
});
