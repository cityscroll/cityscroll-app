import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The scheduled first-class dataset refresh stalled for a week behind a failing
 * read-model rebuild: the official-colleagues capture walked fixed members, the
 * publisher reorganized committees out from under them, and every assertion in
 * the capture failed on the refreshed graph — so the refresh never reached its
 * publication step and every first-class artifact aged out until production
 * refused to publish them. The capture now selects its members from the graph
 * it is about to capture. This test runs that selection's reproduction without
 * a browser, against synthetic graphs and the committed repository data.
 */

const TOOL = new URL("../tools/capture_official_colleagues.py", import.meta.url).pathname;

test("the capture tool carries no fixed capture members", () => {
  const source = readFileSync(TOOL, "utf8");
  assert.match(source, /PREFERRED_SUBJECT = "7801"/, "the historical members remain stated preferences");
  assert.match(source, /def select_fixtures\(/, "fixture selection is derived, not hardcoded");
  // The constants the failing capture used to walk are gone as requirements:
  // nothing may index the rendered walk off module-level member ids.
  assert.doesNotMatch(source, /^SUBJECT = /m);
  assert.doesNotMatch(source, /^COLLEAGUE = /m);
  assert.doesNotMatch(source, /^LANDMARKS = /m);
  assert.doesNotMatch(source, /^AGING = /m);
  assert.doesNotMatch(source, /^ABSENT = /m);
});

test("fixture selection reproduces the reorganization failure and recovers from it", () => {
  const run = spawnSync("python3", [TOOL, "--self-test"], { encoding: "utf8" });
  assert.equal(run.status, 0, `self-test output:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /fixture selection self-test OK/);
  assert.match(run.stdout, /reorganized graph: subject 9001/);
});

test("the rebuild registry still binds the capture to the scheduled refresh", () => {
  const registry = JSON.parse(readFileSync(new URL("../ops/first-class-refresh/committed-read-models.json", import.meta.url), "utf8"));
  const step = registry.rebuild_sequence.find((entry) => entry.id === "official-colleagues-capture");
  assert.ok(step, "the official-colleagues capture remains a declared rebuild step");
  assert.deepEqual(step.command, ["tools/capture_official_colleagues.py"]);
});
