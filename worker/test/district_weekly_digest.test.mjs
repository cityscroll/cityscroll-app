import test from "node:test";
import assert from "node:assert/strict";

import { sanitize } from "../src/lib/filter.mjs";
import { compileSub } from "../src/lib/compile.mjs";
import { describeFilter } from "../src/lib/confirm_email.mjs";
import { subDigestDecision, subDigestHtml } from "../src/alerts.mjs";
import { handleSubscribe } from "../src/subscribe.mjs";
import { handleConfirm } from "../src/confirm.mjs";
import { dedupeFreshByContent } from "../src/lib/digest.mjs";

class MockKV {
  constructor() { this.store = new Map(); }
  async get(key) { return this.store.get(key) ?? null; }
  async put(key, value) { this.store.set(key, value); }
  async list() { return { keys: [...this.store.keys()].map((name) => ({ name })) }; }
}

const rows = [
  {
    district_item_id: "award:20260801001",
    district_section: "awards",
    district_kind: "award",
    request_id: "20260801001",
    short_title: "Street reconstruction award",
    agency_name: "Design and Construction",
    contract_amount: 2500000,
  },
  {
    district_item_id: "land:2026K0001:2026-08-01",
    district_section: "land",
    district_kind: "rezone",
    project_id: "2026K0001",
    project_name: "Example Avenue Rezoning",
    borough: "Brooklyn",
    public_status: "In Public Review",
  },
];

test("district watch sanitizes to exactly one council district", () => {
  assert.deepEqual(sanitize("district", { councilDistrict: 33, keywords: ["ignored"] }), {
    councilDistrict: "33",
  });
  assert.equal(sanitize("district", { councilDistrict: 0 }).councilDistrict, null);
  assert.equal(sanitize("district", { councilDistrict: 52 }).councilDistrict, null);
});

test("district compiler replays the same materialized list used by preview", () => {
  const q = compileSub({ lens: "district", filter: { councilDistrict: "33" } }, "2026-08-04");
  assert.equal(q.kind, "district");
  assert.equal(q.idField, "district_item_id");
  assert.match(q.url, /district_weekly_digests\.json$/);
  const payload = { by_council_district: { 33: { total: rows.length, items: rows } } };
  assert.deepEqual(q.transformRows(payload), rows);
  assert.equal(describeFilter("district", { councilDistrict: "33" }), "Council District 33 weekly digest");
});

test("one district preset confirmation creates exactly one weekly watch record", async () => {
  const env = {
    TOKEN_SECRET: "your-secret-key-here",
    RESEND_API_KEY: "test",
    SUBS: new MockKV(),
    CONFIRM_BASE: "https://api.cityscroll.org",
  };
  let confirmationHtml = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes("api.resend.com")) throw new Error(`unexpected fetch ${url}`);
    confirmationHtml = JSON.parse(options.body).html;
    return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
  };
  try {
    const response = await handleSubscribe(new Request("https://api.cityscroll.org/subscribe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://cityscroll.org",
        "CF-Connecting-IP": "198.51.100.33",
      },
      body: JSON.stringify({
        email: "example@example.com",
        lens: "district",
        filter: { councilDistrict: "33", ignored: "drop-me" },
        freq: "weekly",
      }),
    }), env);
    assert.equal(response.status, 200);
    assert.equal([...env.SUBS.store.keys()].filter((key) => key.startsWith("sub:")).length, 0);
    const confirmUrl = confirmationHtml.match(/href="(https:\/\/api\.cityscroll\.org\/confirm\?token=[^"]+)"/)?.[1];
    assert.ok(confirmUrl);
    const confirmed = await handleConfirm(new Request(confirmUrl), env);
    assert.equal(confirmed.status, 200);
    const records = [...env.SUBS.store.entries()].filter(([key]) => key.startsWith("sub:"));
    assert.equal(records.length, 1);
    const record = JSON.parse(records[0][1]);
    assert.equal(record.lens, "district");
    assert.equal(record.freq, "weekly");
    assert.deepEqual(record.filter, { councilDistrict: "33" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("district digest uses positive action bands and omits empty sections", () => {
  const html = subDigestHtml(
    "Council District 33 weekly digest",
    "district",
    rows,
    "https://api.cityscroll.org/unsubscribe?token=x",
    "2026-07-28",
  );
  assert.match(html, /Review new contract awards/);
  assert.match(html, /Track land use actions/);
  assert.doesNotMatch(html, /Attend upcoming hearings/);
  assert.doesNotMatch(html, /Review property dispositions/);
  assert.doesNotMatch(html, /no hearings|Nothing new for/i);
  assert.equal((html.match(/district-item/g) || []).length, rows.length);
});

test("district weekly watches stay silent when every section is empty", () => {
  assert.equal(subDigestDecision({ lens: "district", freshCount: 0, freq: "weekly" }).action, "none");
  assert.equal(subDigestDecision({ lens: "district", freshCount: 2, freq: "weekly" }).action, "match");
});

test("district item ids preserve distinct rows during content deduplication", () => {
  const landRows = [
    { district_item_id: "land:one", project_name: "One" },
    { district_item_id: "land:two", project_name: "Two" },
  ];
  assert.equal(dedupeFreshByContent(landRows).length, 2);
});
