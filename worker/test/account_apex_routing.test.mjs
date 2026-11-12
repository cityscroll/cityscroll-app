// The sign-in and confirmation pages live on the canonical site host
// (cityscroll.org), reached through the Worker's apex/mirror branch. A request
// there must be served by the account page handler, not fall through to the
// Pages mirror — otherwise the sign-in form never appears even with the route
// and flag in place.
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.mjs";

const ctx = { waitUntil() {}, passThroughOnException() {} };

test("apex host serves the account sign-in shell from the Worker, not the Pages mirror", async () => {
  const res = await worker.fetch(
    new Request("https://cityscroll.org/account"),
    { CITYSCROLL_ACCOUNTS_ENABLED: "true" },
    ctx,
  );
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Sign in to CityScroll/);
  // The managed widget only appears on the Worker-rendered shell; the Pages
  // homepage mirror would never contain it.
  assert.match(html, /challenges\.cloudflare\.com/);
});

test("apex host serves the one-time confirmation shell from the Worker", async () => {
  const res = await worker.fetch(
    new Request("https://cityscroll.org/account/confirm"),
    { CITYSCROLL_ACCOUNTS_ENABLED: "true" },
    ctx,
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Finish signing in/);
});

test("apex account pages are inert (404) while the flow is disabled", async () => {
  for (const p of ["/account", "/account/confirm"]) {
    const res = await worker.fetch(
      new Request(`https://cityscroll.org${p}`),
      { CITYSCROLL_ACCOUNTS_ENABLED: "false" },
      ctx,
    );
    assert.equal(res.status, 404, p);
  }
});
