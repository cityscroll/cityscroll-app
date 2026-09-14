// Production-only canary for the canonical procurement route and its two exact
// identifier searches. It requires explicit opt-in so unit, time-travel, and
// other local test families never turn into an unbounded network read.

import assert from "node:assert/strict";
import test from "node:test";

const PROCUREMENT_ID = "procurement:contract:CT107120258801626";
const ROUTE = `/procurements/${encodeURIComponent(PROCUREMENT_ID)}`;
const BASE = (process.env.CITYSCROLL_PROCUREMENT_BASE_URL || "https://cityscroll.org").replace(/\/$/, "");
const API_BASE = (process.env.CITYSCROLL_PROCUREMENT_API_BASE_URL || "https://api.cityscroll.org").replace(/\/$/, "");

function matchingRecords(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) matchingRecords(item, output);
  } else if (value && typeof value === "object") {
    if (value.object_ref === PROCUREMENT_ID || value.procurement_id === PROCUREMENT_ID) {
      output.push(value);
    } else {
      for (const child of Object.values(value)) matchingRecords(child, output);
    }
  }
  return output;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  assert.equal(response.status, 200, url);
  return { response, payload: await response.json() };
}

if (process.env.LIVE_PROCUREMENT_CANARY !== "1") {
  test("production procurement canary skipped without explicit opt-in", () => {});
} else {
  test("production procurement route and exact identifier searches remain in parity", async () => {
    const page = await fetch(`${BASE}${ROUTE}`, { headers: { Accept: "text/html" } });
    assert.equal(page.status, 200);
    const html = await page.text();
    for (const href of [
      "/agencies/homeless-services/",
      "/vendors/BHRAGS%20HOME%20CARE/",
      "/search/?q=CT107120258801626",
      "/search/?q=07124E0044001",
      "/notices/20240829105",
      "https://a0333-passportpublic.nyc.gov/contracts.html",
      "https://www.checkbooknyc.com/smart_search/citywide?search_term=CT107120258801626",
    ]) assert.ok(html.includes(`href="${href}"`), href);
    for (const copy of ["2023-10-11", "2026-06-30", "2024-08-28", "2024-09-05", "Homeless Services", "BHRAGS HOME CARE CORP"]) {
      assert.ok(html.includes(copy), copy);
    }
    assert.doesNotMatch(html, /Lookup not run|NYS ABO|procurement-opportunity-window|procurement-opportunity-month/);

    for (const query of ["CT107120258801626", "07124E0044001"]) {
      const { payload } = await getJson(`${API_BASE}/search?q=${encodeURIComponent(query)}`);
      assert.equal(matchingRecords(payload).length, 1, query);
    }
  });
}
