// Live e2e over every public route of the deployed worker. Read-only where possible; the one
// write (/inv) is a tiny TTL'd snapshot. Never completes a real subscription (that would email).
//
//   CROL_WORKER_URL=https://api.crol-list.org npm run test:live
//
// Defaults to the workers.dev alias so the suite also proves the alias stays alive
// (regression for the 2026-07-02 workers_dev=false incident).

import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.CROL_WORKER_URL || "https://crol-worker.crol-worker.workers.dev").replace(/\/+$/, "");
const ORIGIN = { Origin: "https://crol-list.org" };
const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json", ...ORIGIN }, body: JSON.stringify(body) });

test("health", async () => {
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /crol-worker ok/);
});

test("feed.xml money: valid Atom with entries and permalink links", async () => {
  const r = await fetch(`${BASE}/feed.xml?lens=money`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /atom\+xml/);
  const t = await r.text();
  assert.match(t, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(t, /<entry>/);
  assert.match(t, /crol-list\.org\/#notice\//);
});

test("feed.ics meetings: subscribable calendar with events", async () => {
  const r = await fetch(`${BASE}/feed.ics?lens=meetings`);
  assert.equal(r.status, 200);
  const t = await r.text();
  assert.match(t, /BEGIN:VCALENDAR/);
  assert.match(t, /BEGIN:VEVENT/);
});

test("feed entity/vendor: stem-resolved title", async () => {
  const r = await fetch(`${BASE}/feed.json?lens=entity&kind=vendor&name=Sinergia%20Inc`);
  assert.equal(r.status, 200);
  const j = JSON.parse(await r.text());
  assert.match(j.title, /vendor .Sinergia Inc./);
  assert.equal(j.version, "https://jsonfeed.org/version/1.1");
});

test("feed error paths: unknown lens 400, POST 405", async () => {
  assert.equal((await fetch(`${BASE}/feed.xml?lens=nonsense`)).status, 400);
  assert.equal((await fetch(`${BASE}/feed.xml?lens=money`, { method: "POST" })).status, 405);
});

test("batch: hit matrix with stem-refined awards; empty names 400", async () => {
  const r = await fetch(`${BASE}/batch`, json({ names: ["Sinergia Inc", "ZZZXQJ Nonexistent"] }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.ok);
  assert.ok(j.results["Sinergia Inc"].awards > 0, "known vendor has awards");
  assert.match(j.results["Sinergia Inc"].entity, /#vendor\//);
  assert.equal(j.results["ZZZXQJ Nonexistent"].awards, 0);
  assert.equal(j.results["ZZZXQJ Nonexistent"].entity, null);
  assert.equal((await fetch(`${BASE}/batch`, json({ names: [] }))).status, 400);
});

test("inv: share roundtrip, bad id 404, junk payload 400", async () => {
  const snap = { name: "e2e probe", items: [{ t: "notice", id: "20260625017", title: "probe", meta: "e2e", note: "", added: "2026-07-02" }] };
  const r = await fetch(`${BASE}/inv`, json(snap));
  assert.equal(r.status, 200);
  const { ok, id } = await r.json();
  assert.ok(ok && id, "share stored");
  const back = await fetch(`${BASE}/inv/${id}`);
  assert.equal(back.status, 200);
  const j = await back.json();
  assert.equal(j.items[0].id, "20260625017");
  assert.equal((await fetch(`${BASE}/inv/zzzzzzzzzz`)).status, 404);
  assert.equal((await fetch(`${BASE}/inv`, json({ name: "x", items: [] }))).status, 400);
});

test("/api redirects to the docs page", async () => {
  const r = await fetch(`${BASE}/api`, { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /crol-list\.org\/api\.html/);
});

test("checkbook proxy: PIN join returns contract XML", async () => {
  const xml = `<request><type_of_data>Contracts</type_of_data><records_from>1</records_from><max_records>1</max_records><search_criteria><criteria><name>status</name><type>value</type><value>registered</value></criteria><criteria><name>category</name><type>value</type><value>expense</value></criteria><criteria><name>pin</name><type>value</type><value>06820P8165KXLR002</value></criteria></search_criteria></request>`;
  const r = await fetch(`${BASE}/checkbook`, json({ xml }));
  assert.equal(r.status, 200);
  const t = await r.text();
  assert.match(t, /<result>success<\/result>/);
  assert.match(t, /prime_contract_id/);
});

test("subscribe validation fails closed before any send", async () => {
  const bad = await fetch(`${BASE}/subscribe`, json({ email: "not-an-email", lens: "money", filter: {} }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).reason, "bad-email");
  const lens = await fetch(`${BASE}/subscribe`, json({ email: "a@b.co", lens: "nonsense", filter: {} }));
  assert.equal(lens.status, 400);
  assert.equal((await lens.json()).reason, "bad-lens");
});

test("nl responds (real filter or honest degradation, never an error)", async () => {
  const r = await fetch(`${BASE}/nl`, json({ text: "construction contracts over $1M", lens: "money" }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.filter || j.degraded === true, "either a filter or degraded:true");
});
