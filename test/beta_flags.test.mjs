import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../beta_flags.js");

const {
  STORAGE_KEY,
  resolveFlag,
  syncStorage,
} = globalThis.CROLBetaFlags;
const registry = JSON.parse(readFileSync(new URL("../beta-flags.json", import.meta.url)));
const flags = registry.flags;
const today = "2026-07-29";

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("flags are off by default and unknown slugs do not activate anything", () => {
  assert.deepEqual(resolveFlag({ flags, today }), { slug: null, storage: "keep" });
  assert.deepEqual(
    resolveFlag({ search: "?beta=not-registered", flags, today }),
    { slug: null, storage: "clear" },
  );
});

test("?beta=<slug> opts in and persists locally", () => {
  const resolution = resolveFlag({ search: "?beta=channel-banner", flags, today });
  assert.deepEqual(resolution, { slug: "channel-banner", storage: "persist" });
  const storage = fakeStorage();
  syncStorage(storage, resolution);
  assert.equal(storage.getItem(STORAGE_KEY), "channel-banner");
  assert.deepEqual(
    resolveFlag({ stored: storage.getItem(STORAGE_KEY), flags, today }),
    { slug: "channel-banner", storage: "keep" },
  );
});

test("?beta=0 clears the persisted opt-in", () => {
  const storage = fakeStorage({ [STORAGE_KEY]: "channel-banner" });
  const resolution = resolveFlag({
    search: "?beta=0",
    stored: storage.getItem(STORAGE_KEY),
    flags,
    today,
  });
  syncStorage(storage, resolution);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(resolution.slug, null);
});

test("expired flags fail closed in the browser runtime", () => {
  assert.deepEqual(
    resolveFlag({ search: "?beta=channel-banner", flags, today: "2026-10-01" }),
    { slug: null, storage: "clear" },
  );
});

test("the active state creates a visible experimental banner with a clear link", () => {
  const source = readFileSync(new URL("../beta_flags.js", import.meta.url), "utf8");
  assert.match(source, /data-beta-flag-banner/);
  assert.match(source, /Experimental view:/);
  assert.match(source, /searchParams\.set\("beta", "0"\)/);
});

test("every public page loads the default-off flag runtime", () => {
  for (const page of [
    "index.html",
    "about.html",
    "api.html",
    "changelog.html",
    "data.html",
    "standards.html",
    "stats.html",
  ]) {
    const source = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    assert.match(source, /<script defer src="beta_flags\.js\?v=1\.0\.0"><\/script>/, page);
  }
});
