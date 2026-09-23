import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const productionReadPath = new URL("../docs/evidence/near-you-record-relevance/production-read.json", import.meta.url);
const manifest = JSON.parse(readFileSync(
  new URL("../docs/evidence/near-you-record-relevance/acceptance-manifest.json", import.meta.url),
));

test("record-relevance acceptance keeps live outcomes without a fixed event count", () => {
  assert.equal(manifest.live_outcomes?.require_fixed_event_count, false);
  assert.ok(Array.isArray(manifest.live_outcomes?.observations));
  assert.ok(manifest.assertions.some((row) => row.id === "two-viewport-inspection-journey"));
});

test("record-relevance production read-back checker is available", () => {
  const help = spawnSync(
    "python3",
    ["tools/capture_near_you_record_relevance_production_read.py", "--help"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--check/);

  if (!existsSync(productionReadPath)) return;
  const productionRead = JSON.parse(readFileSync(productionReadPath));
  assert.equal(productionRead.schema, "cityscroll.near_you_record_relevance_production_read.v1");
  assert.equal(productionRead.origin, "https://cityscroll.org");
  assert.equal(manifest.live_outcomes?.production_read?.result, "pass");
  const checked = spawnSync(
    "python3",
    ["tools/capture_near_you_record_relevance_production_read.py", "--check"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(checked.stdout, /production read-back passed/);
});

test("record-relevance capture tool rejects alternate CLI targets", () => {
  for (const option of ["--site", "--output"]) {
    const result = spawnSync(
      "python3",
      ["tools/capture_near_you_record_relevance_production_read.py", option, "alternate"],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unrecognized arguments/);
  }
});
