/**
 * Local preflight must fail the same card-profile declared-coverage gap CI fails.
 *
 * verify: node --test test/preflight_card_profile_coverage.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  declaredCoverageFailureMessage,
  declaredCoverageGaps
} from "../tools/card_profile_closure.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8");

test("preflight site-node runs derive --check when site/ changed, not on the fast path unconditionally", () => {
  const preflight = read("tools/preflight-required-checks.sh");
  const hook = read("tools/git-hooks/pre-push");
  const familyStart = preflight.indexOf("family_site_node()");
  const familyEnd = preflight.indexOf("family_contract()");
  assert.ok(familyStart >= 0 && familyEnd > familyStart, "site-node family block is missing");
  const family = preflight.slice(familyStart, familyEnd);

  assert.match(preflight, /preflight_site_paths_changed\(\)/);
  assert.match(hook, /git diff --name-only "\$range".*grep -qE '\^site\/'/s);
  assert.match(family, /if preflight_site_paths_changed; then/);
  assert.match(family, /node tools\/derive_card_profile\.mjs --check/);
  assert.match(family, /Card-profile declared coverage/);
  assert.doesNotMatch(
    preflight.slice(0, familyStart),
    /node tools\/derive_card_profile\.mjs --check/,
    "the card-profile check must live in the site-node family, not before it"
  );
});

test("derive --check prints the same regenerate instruction CI's card_profile test uses", () => {
  const deriver = read("tools/derive_card_profile.mjs");
  assert.match(deriver, /declaredCoverageFailureMessage/);
  assert.match(deriver, /built\.declared\.filter/);
});

test("a fixture site module missing from the committed patterns fails with the regenerate instruction, then passes once covered", () => {
  const config = {
    always_include_paths: [],
    include_trees: ["site"],
    exclude_trees: ["site/data"]
  };
  const tracked = ["site/existing.mjs", "site/new_module.mjs", "site/data/heavy.json"];
  const before = ["/site/existing.mjs"];
  const missing = declaredCoverageGaps(tracked, before, config);
  assert.deepEqual(missing, ["site/new_module.mjs"]);
  assert.equal(
    declaredCoverageFailureMessage(missing),
    "1 tracked path(s) inside the declared coverage are not covered by the committed patterns, regenerate with: node tools/derive_card_profile.mjs — starting with site/new_module.mjs"
  );

  const after = ["/site/existing.mjs", "/site/new_module.mjs"];
  assert.deepEqual(declaredCoverageGaps(tracked, after, config), []);
});

test("this checkout's derive --check still passes", () => {
  const result = spawnSync(process.execPath, ["tools/derive_card_profile.mjs", "--check"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
