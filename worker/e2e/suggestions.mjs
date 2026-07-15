// Live e2e for index.html's STATIC suggestion-chip fallback (NL_SUGGESTIONS_FALLBACK) — the
// subset shown when the worker is unreachable and the daily-validated set can't be fetched.
// Per w12-08's acceptance criteria, that fallback carries its own committed live check: it
// resolves each fallback candidate's text through the deployed /nl endpoint (same as a real
// chip click), builds the identical count query the daily cron uses, and fails if any of them
// returns fewer than MIN_SUGGESTION_RESULTS live rows today. Costs a few Haiku calls.
//
//   Run against prod:   npm run test:live
//   Run against local:  CROL_WORKER_URL=http://localhost:8787 npm run test:live
import { test } from "node:test";
import assert from "node:assert/strict";
import { SUGGESTION_POOL, FALLBACK_INDICES, MIN_SUGGESTION_RESULTS, suggestionCountParams } from "../src/lib/suggestions.mjs";

const BASE = (process.env.CROL_WORKER_URL || "https://crol-worker.crol-worker.workers.dev").replace(/\/+$/, "");
const todayISO = new Date().toISOString().slice(0, 10);

async function resolveFilter(lens, text) {
  const r = await fetch(`${BASE}/nl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lens, text }),
  });
  assert.equal(r.status, 200, `${lens}/"${text}"`);
  const j = await r.json();
  assert.ok(j.filter, `expected a filter for ${lens}/"${text}", got ${JSON.stringify(j)}`);
  return j.filter;
}

for (const [lens, indices] of Object.entries(FALLBACK_INDICES)) {
  for (const idx of indices) {
    const candidate = SUGGESTION_POOL.find((c) => c.lens === lens && c.idx === idx);
    test(`static fallback "${candidate.text}" (${lens}) resolves and returns >= ${MIN_SUGGESTION_RESULTS} live results`, async () => {
      const filter = await resolveFilter(lens, candidate.text);
      const q = suggestionCountParams(lens, filter, todayISO);
      assert.ok(q, `expected a count query for ${lens}/"${candidate.text}"`);
      const url = `${q.url}?${new URLSearchParams(q.params)}`;
      const r = await fetch(url);
      assert.equal(r.status, 200, url);
      const rows = await r.json();
      const n = Number(rows && rows[0] && rows[0].n) || 0;
      assert.ok(n >= MIN_SUGGESTION_RESULTS, `"${candidate.text}" returned ${n} live results (need >= ${MIN_SUGGESTION_RESULTS}): ${url}`);
    });
  }
}
