// The award-source registry is hand-synced across the static site (external_awards.js) and the
// Worker (worker/src/lib/external_award.mjs) — the two can't share one import across that boundary,
// the same dual-implementation convention as lib/prior_cycle.mjs / lib/lineage.mjs. This test fails
// the moment they diverge, so a coverage change made in one file but not the other can't ship.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AWARD_SOURCE_REGISTRY as CLIENT } from "../external_awards.js";
import { AWARD_SOURCE_REGISTRY as WORKER, aboSources, awardKvKey } from "../worker/src/lib/external_award.mjs";

test("client and worker registries are byte-for-byte equivalent", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(CLIENT)),
    JSON.parse(JSON.stringify(WORKER)),
    "external_awards.js and worker/src/lib/external_award.mjs registries drifted",
  );
});

test("every entry is a recognized kind with the fields that kind needs", () => {
  for (const [agency, e] of Object.entries(CLIENT)) {
    assert.ok(["abo", "checkbook-nycha", "absent"].includes(e.kind), `${agency}: bad kind ${e.kind}`);
    if (e.kind === "abo") {
      assert.match(e.dataset, /^[a-z0-9]{4}-[a-z0-9]{4}$/, `${agency}: bad Socrata dataset id`);
      assert.ok(e.authority && typeof e.authority === "string", `${agency}: abo entry needs an authority key`);
      assert.equal(e.precision, "fuzzy", `${agency}: abo joins are fuzzy`);
    }
    if (e.kind === "checkbook-nycha") assert.equal(e.precision, "exact");
  }
});

test("aboSources dedupes aliases to distinct dataset+authority pairs", () => {
  const sources = aboSources();
  const keys = sources.map((s) => `${s.dataset}:${s.authority}`);
  assert.equal(new Set(keys).size, keys.length, "aboSources returned a duplicate source");
  // NYC Health + Hospitals has two City Record spellings mapping to one ABO authority — one source.
  const hh = sources.filter((s) => s.authority === "New York City Health and Hospitals Corporation");
  assert.equal(hh.length, 1, "the H+H alias must not double the source pull");
  assert.equal(awardKvKey(sources[0]), `award:${sources[0].dataset}:${sources[0].authority}`);
});
