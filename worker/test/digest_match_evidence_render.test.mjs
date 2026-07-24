// End-to-end characterization of the emailed digest's match-evidence rendering (matchEvidence()
// in lib/digest.mjs is unit-tested in digest.test.mjs; this proves it's actually wired into the
// sent HTML). Real observed failure: a subscriber's "education" keyword alert once surfaced
// "NOS - Equity Index Investment Management Products" (an Office of the Comptroller
// pension-fund notice) with nothing in the sent email explaining the match — the hit was in
// the description (naming the Board of Education Retirement System), which the digest never
// rendered at all before this fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAlerts } from "../src/alerts.mjs";
import { matchEvidence } from "../src/lib/digest.mjs";

function kv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v) => { map[k] = v; },
    list: async (options = {}) => {
      const prefix = options.prefix || "";
      const keys = Object.keys(map).filter((k) => k.startsWith(prefix)).map((k) => ({ name: k }));
      return { keys, list_complete: true };
    },
  };
}

const comptrollerRow = {
  request_id: "20260701099",
  agency_name: "Office of the Comptroller",
  short_title: "NOS - Equity Index Investment Management Products",
  additional_description_1:
    "The New York City Office of the Comptroller, Bureau of Asset Management, is soliciting " +
    "proposals on behalf of the Boards of Trustees of the New York City Employees' Retirement " +
    "System, Teachers' Retirement System, and the Board of Education Retirement System for " +
    "equity index investment management products.",
  pin: "826202SOL0001P",
  due_date: "2099-01-01T00:00:00.000",
  start_date: "2026-07-01",
};

async function runOneMoneySub(filter) {
  const sentEmails = [];
  const today = new Date().toISOString().slice(0, 10);
  const subKey = "sub:edu-test";
  const subsStore = {
    [subKey]: JSON.stringify({
      key: subKey, email: "test@example.com", freq: "daily", channel: "email",
      lens: "money", filter, createdAt: today,
    }),
  };
  const env = {
    ALERT_STATE: kv({}),
    SUBS: kv(subsStore),
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "re-1234",
    TOKEN_SECRET: "secret-key",
    CONFIRM_BASE: "https://api.crol-list.org",
    MAX_PER_RUN: "25",
    MAX_SENDS_PER_DAY: "50",
    HEARTBEAT_DAYS: "14",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("api.resend.com/emails")) {
      sentEmails.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: "resend-id" }) };
    }
    return { ok: true, json: async () => [comptrollerRow] }; // mock SODA
  };
  try {
    await runAlerts(env, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sentEmails;
}

test("before: the title alone gives no reason 'education' would match this notice", () => {
  assert.equal(comptrollerRow.short_title.toLowerCase().includes("education"), false);
});

test("after: a keyword match buried in the description renders a <mark>-highlighted snippet, not silence", async () => {
  const sentEmails = await runOneMoneySub({ keywords: ["education"] });
  assert.equal(sentEmails.length, 1);
  const html = sentEmails[0].html;
  assert.match(html, /Equity Index Investment Management Products/);
  assert.match(html, /Matched: /, "the 'why this matched' line is present");
  assert.match(html, /<mark[^>]*>Education<\/mark>/, "the exact-case hit is highlighted, not a lowercased rewrite");
  assert.match(html, /Board of <mark[^>]*>Education<\/mark> Retirement System/, "the snippet gives real context, not just the bare word");
});

test("a keyword that's in the title highlights the title itself, with no separate snippet line", async () => {
  const sentEmails = await runOneMoneySub({ keywords: ["equity"] });
  assert.equal(sentEmails.length, 1);
  const html = sentEmails[0].html;
  assert.match(html, /<mark[^>]*>Equity<\/mark> Index Investment Management Products/);
  assert.doesNotMatch(html, /Matched: /, "no redundant evidence line when the title itself already shows the hit");
});

test("an amount-only watch (no keywords) renders the notice with no evidence chrome at all — unchanged behavior", async () => {
  const sentEmails = await runOneMoneySub({ minAmount: 1 });
  assert.equal(sentEmails.length, 1);
  const html = sentEmails[0].html;
  assert.doesNotMatch(html, /<mark/);
  assert.doesNotMatch(html, /Matched: /);
});

// w12-12: before, a digest item's link carried nothing about the watch that surfaced it — a
// click from this exact education-watch email landed on the plain notice view, with the
// school-text evidence (the <mark>-highlighted snippet asserted above) visible only in the
// email itself, gone the moment the reader followed the link to the site. After, the link
// carries the watch's own {lens, filter} so the site can reconstruct the same evidence on
// arrival — this is the card's anchor fixture, run end-to-end through the real send path.
test("the education watch's notice link carries its own filter as a ?w= param, decodable back to {lens, filter}", async () => {
  const sentEmails = await runOneMoneySub({ keywords: ["education"] });
  const html = sentEmails[0].html;
  const m = html.match(/href="(https:\/\/api\.crol-list\.org\/r\/rfp\/20260701099\?w=[^"]+)"/);
  assert.ok(m, "no ?w= link found in the sent digest HTML");
  const url = new URL(m[1].replace(/&amp;/g, "&"));
  const w = url.searchParams.get("w");
  assert.deepEqual(JSON.parse(w), { lens: "money", filter: { keywords: ["education"] } });
});

test("a multi-filter watch (keywords + agency + amount) carries every field in its ?w= param", async () => {
  // minAmount set with no explicit noticeType implies the Award branch (compileSub's
  // pre-existing amount-presence heuristic — see AGENTS.md's "Alerts NL query" section), so
  // this watch's link kind is "award", not "rfp" — months (a Solicitation-only due-date
  // bound) never applies to it, same as the live query it mirrors.
  const sentEmails = await runOneMoneySub({
    keywords: ["education"], agency: "Office of the Comptroller", minAmount: 100000,
  });
  const html = sentEmails[0].html;
  const m = html.match(/href="(https:\/\/api\.crol-list\.org\/r\/award\/20260701099\?w=[^"]+)"/);
  assert.ok(m, "no ?w= link found in the sent digest HTML");
  const w = new URL(m[1].replace(/&amp;/g, "&")).searchParams.get("w");
  assert.deepEqual(JSON.parse(w), {
    lens: "money",
    filter: { keywords: ["education"], agency: "Office of the Comptroller", minAmount: 100000 },
  });
});

test("an amount-only watch (no keywords) still carries its filter — minAmount alone is real signal", async () => {
  const sentEmails = await runOneMoneySub({ minAmount: 1000000 });
  const html = sentEmails[0].html;
  const m = html.match(/href="(https:\/\/api\.crol-list\.org\/r\/award\/20260701099\?w=[^"]+)"/);
  assert.ok(m);
  const w = new URL(m[1].replace(/&amp;/g, "&")).searchParams.get("w");
  assert.deepEqual(JSON.parse(w), { lens: "money", filter: { minAmount: 1000000 } });
});


// 2026-07-23 (James, via a live digest email): City Record descriptions arrive
// with embedded HTML — the Matched: excerpt rendered raw tags. matchEvidence
// must strip markup BEFORE locating and slicing.
test("matchEvidence strips embedded HTML from descriptions before snipping", () => {
  const desc = "<p><span><span style='color:rgba(0, 0, 0, 1)'>Design Build Services for Upstate Roadway Reconstruction &amp; Improvements Project</span></span></p>";
  const ev = matchEvidence("Design Build 1", desc, ["reconstruction"]);
  assert.ok(ev, "term in description must still match");
  assert.equal(ev.field, "description");
  const joined = `${ev.before}${ev.hit}${ev.after}`;
  assert.doesNotMatch(joined, /[<>]/, `excerpt must contain no tags, got: ${joined}`);
  assert.doesNotMatch(joined, /span|style=|rgba/, "no markup vocabulary in the excerpt");
  assert.match(joined, /Design Build Services for Upstate Roadway Reconstruction & Improvements/, "entities decoded, prose preserved");
});
