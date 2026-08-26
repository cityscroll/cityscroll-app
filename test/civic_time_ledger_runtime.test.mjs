import assert from "node:assert/strict";
import test from "node:test";
import { mountAgencyCivicTimeLedger } from "../site/civic_time_ledger_runtime.mjs";

function restoreGlobal(name, hadValue, value) {
  if (hadValue) globalThis[name] = value;
  else delete globalThis[name];
}

test("Agency primary marker settles while relationships are still deferred", async () => {
  let resolveFetch;
  const deferredFetch = new Promise((resolve) => { resolveFetch = resolve; });
  const heading = { textContent: "Office of the Mayor" };
  const host = { textContent: "Loading public relationships…", dataset: {} };
  const main = {
    dataset: {
      civicObjectKind: "agency-constellation",
      civicObjectDeferredHref: "/agencies/office-of-the-mayor/relationships.json",
      civicObjectDeferredState: "loading",
      civicObjectSettled: "false",
    },
    querySelector(selector) {
      if (selector === ".agency-constellation-hero h1") return heading;
      if (selector === "[data-civic-object-deferred]") return host;
      return null;
    },
  };
  const root = {
    baseURI: "https://cityscroll.test/agencies/office-of-the-mayor/",
    querySelector(selector) {
      return selector.includes("data-civic-object-kind") ? main : null;
    },
    getElementById() { return null; },
  };
  const previous = Object.fromEntries(["document", "location", "fetch", "CROL_RUM_PRODUCTION"]
    .map((name) => [name, [Object.hasOwn(globalThis, name), globalThis[name]]]));
  globalThis.document = root;
  globalThis.location = { search: "" };
  globalThis.fetch = () => deferredFetch;
  globalThis.CROL_RUM_PRODUCTION = false;

  try {
    const result = mountAgencyCivicTimeLedger(root);
    assert.deepEqual(result, { deferred: true, asOf: null });
    assert.equal(main.dataset.civicObjectSettled, "true");
    assert.equal(main.dataset.civicObjectDeferredState, "loading");
    assert.equal(host.textContent, "Loading public relationships…");

    resolveFetch({ ok: false, status: 504 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(main.dataset.civicObjectSettled, "true");
    assert.equal(main.dataset.civicObjectDeferredState, "error");
    assert.equal(host.dataset.civicObjectDeferredState, "error");
    assert.equal(host.textContent, "Public relationships are temporarily unavailable.");
  } finally {
    for (const [name, [hadValue, value]] of Object.entries(previous)) {
      restoreGlobal(name, hadValue, value);
    }
  }
});
