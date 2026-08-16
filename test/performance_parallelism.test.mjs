import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

function writeJson(target, value) {
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function fixtureSet(root) {
  const shardsDir = path.join(root, "shards");
  mkdirSync(shardsDir);
  const budgets = {
    version: 1,
    statistics: { quantile: 0.95, warmupSamples: 1, samples: 20 },
    viewports: { mobile: { width: 390, height: 844 } },
    fixtures: { "home.cold": { viewports: ["mobile"], ttfbMs: 100 } },
  };
  const budgetsPath = path.join(root, "budgets.json");
  writeJson(budgetsPath, budgets);

  for (let shard = 0; shard < 4; shard += 1) {
    const indexes = Array.from({ length: 20 }, (_, index) => index)
      .filter((index) => index % 4 === shard);
    writeJson(path.join(shardsDir, `shard-${shard}.json`), {
      version: 1,
      statistics: { quantile: 0.95, warmupSamples: 1, samples: 20 },
      shard: { index: shard, count: 4, sampleIndexes: indexes },
      runs: [{
        fixture: "home.cold",
        viewport: "mobile",
        samples: indexes.map((index) => ({
          index,
          sample: { ttfbMs: index + 2 },
          wireFiles: null,
        })),
        unexpected: [],
      }],
      timing: {
        started_epoch: 100 + shard,
        finished_epoch: 120 + shard,
        duration_seconds: 20,
      },
    });
  }

  const serialResultsPath = path.join(root, "serial-results.json");
  writeJson(serialResultsPath, {
    version: 1,
    statistics: { quantile: 0.95, warmupSamples: 1, samples: 20 },
    runs: [{
      fixture: "home.cold",
      viewport: "mobile",
      status: "PASS",
      budget: budgets.fixtures["home.cold"],
      p95: { ttfbMs: 19.05 },
      samples: Array.from({ length: 20 }, (_, index) => ({ ttfbMs: index + 1 })),
      failures: [],
    }],
    status: "PASS",
    failures: [],
  });
  const serialTimingPath = path.join(root, "serial-timing.json");
  writeJson(serialTimingPath, {
    started_epoch: 0,
    finished_epoch: 80,
    duration_seconds: 80,
  });
  return { budgetsPath, serialResultsPath, serialTimingPath, shardsDir };
}

function aggregate(root, inputs) {
  const resultsPath = path.join(root, "results.json");
  const pilotPath = path.join(root, "pilot.json");
  execFileSync("python3", [
    "test/performance/aggregate.py",
    "--budgets", inputs.budgetsPath,
    "--shards-dir", inputs.shardsDir,
    "--serial-results", inputs.serialResultsPath,
    "--serial-timing", inputs.serialTimingPath,
    "--output", resultsPath,
    "--pilot-output", pilotPath,
  ], { cwd: ROOT, stdio: "pipe" });
  return {
    results: JSON.parse(readFileSync(resultsPath, "utf8")),
    pilot: JSON.parse(readFileSync(pilotPath, "utf8")),
  };
}

test("performance workflow fans out raw samples and retains a non-required aggregate", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /performance-shard:\n[\s\S]*?shard: \[0, 1, 2, 3\]/);
  assert.match(workflow, /--samples 20[\s\S]*?--shard-index "\$\{\{ matrix\.shard \}\}"[\s\S]*?--shard-count 4/);
  assert.match(workflow, /performance:\n[\s\S]*?test\/performance\/aggregate\.py/);
  assert.match(workflow, /performance-serial:\n[\s\S]*?--samples 20/);
  assert.match(workflow, /--pilot-output test\/performance\/artifacts\/pilot\.json/);
  assert.match(workflow, /browser-pr-site:\n[\s\S]*?outputs\.perf == 'true'/);

  const policy = JSON.parse(read("tools/merge_queue_policy.json"));
  assert.ok(!policy.required_status_checks.includes("Performance budgets (20-sample p95)"));
  const budgets = JSON.parse(read("performance-budgets.json"));
  assert.equal(budgets.statistics.samples, 20);
});

test("one reducer calculates p95 from exactly 20 ordered raw samples", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "performance-parallelism-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outputs = aggregate(root, fixtureSet(root));

  assert.deepEqual(
    Object.keys(outputs.results).sort(),
    ["failures", "runs", "statistics", "status", "version"],
  );
  assert.deepEqual(
    Object.keys(outputs.results.runs[0]).sort(),
    ["budget", "failures", "fixture", "p95", "samples", "status", "viewport"],
  );
  assert.equal(outputs.results.statistics.samples, 20);
  assert.equal(outputs.results.runs[0].samples.length, 20);
  assert.deepEqual(
    outputs.results.runs[0].samples.map((sample) => sample.ttfbMs),
    Array.from({ length: 20 }, (_, index) => index + 2),
  );
  assert.equal(outputs.results.runs[0].p95.ttfbMs, 20.05);
  assert.equal(outputs.pilot.wall_spans.before_serial_seconds, 80);
  assert.equal(outputs.pilot.wall_spans.after_parallel_seconds, 23);
  assert.equal(outputs.pilot.contention.state, "observed");
});

test("the reducer rejects an incomplete deterministic partition", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "performance-parallelism-gap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputs = fixtureSet(root);
  const shardPath = path.join(inputs.shardsDir, "shard-3.json");
  const shard = JSON.parse(readFileSync(shardPath, "utf8"));
  shard.runs[0].samples.pop();
  writeJson(shardPath, shard);

  const result = spawnSync("python3", [
    "test/performance/aggregate.py",
    "--budgets", inputs.budgetsPath,
    "--shards-dir", inputs.shardsDir,
    "--serial-results", inputs.serialResultsPath,
    "--serial-timing", inputs.serialTimingPath,
    "--output", path.join(root, "results.json"),
    "--pilot-output", path.join(root, "pilot.json"),
  ], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not contain exactly 20 unique raw samples/);
});
