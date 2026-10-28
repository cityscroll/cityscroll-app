import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MILLISECONDS_PER_DAY,
  TEST_CLOCK_ENV,
  withPinnedClock,
} from "./helpers/test_clock.mjs";

const PRELOAD = fileURLToPath(new URL("./helpers/test_clock_preload.mjs", import.meta.url));
const PREFLIGHT = readFileSync(new URL("../tools/preflight-required-checks.sh", import.meta.url), "utf8");
const WORKFLOW = readFileSync(new URL("../.github/workflows/time-travel.yml", import.meta.url), "utf8");

function timeTravelMatrixEntries(source) {
  const matrix = source.match(/\n      matrix:\n([\s\S]*?)\n    env:/)?.[1];
  assert.ok(matrix, "time-travel matrix is present");
  const entries = matrix.matchAll(
    /^\s+- shift: (1|45)\n\s+family: (site-node|worker)\n\s+shard: (\d+)\n\s+shard_count: (\d+)\n\s+shard_suffix: "([^"]*)"/gm,
  );
  return [...entries].map((match) => ({
    shift: Number(match[1]),
    family: match[2],
    shard: Number(match[3]),
    shardCount: Number(match[4]),
    shardSuffix: match[5],
  }));
}

function expandGithubMatrix({ axes, include }) {
  const axisEntries = Object.entries(axes);
  if (axisEntries.length === 0) return include.map((entry) => ({ ...entry }));

  const base = axisEntries.reduce(
    (combinations, [name, values]) => combinations.flatMap((combination) =>
      values.map((value) => ({ ...combination, [name]: value }))),
    [{}],
  );
  const expanded = base.map((combination) => ({ ...combination }));
  for (const entry of include) {
    const compatible = expanded.filter((combination) => axisEntries.every(([name]) =>
      !Object.hasOwn(entry, name) || combination[name] === entry[name]));
    if (compatible.length > 0) {
      for (const combination of compatible) Object.assign(combination, entry);
    } else {
      expanded.push({ ...entry });
    }
  }
  return expanded;
}

function testFilesForFamily(family) {
  const directory = family === "site-node" ? new URL("../test/", import.meta.url) : new URL("../worker/test/", import.meta.url);
  const prefix = family === "site-node" ? "test/" : "worker/test/";
  return readdirSync(directory)
    .filter((file) => file.endsWith(".test.mjs"))
    .sort()
    .map((file) => `${prefix}${file}`);
}

function workflowJobBlocks(source) {
  const blocks = new Map();
  let current;
  for (const line of source.split("\n")) {
    const match = line.match(/^  ([a-z0-9-]+):$/);
    if (match) {
      current = [];
      blocks.set(match[1], current);
    } else if (current) {
      current.push(line);
    }
  }
  return blocks;
}

test("withPinnedClock pins the process clock, preserves explicit dates, and restores the scope", async () => {
  const previousDate = globalThis.Date;
  const pinned = "2026-09-14T00:00:00.000Z";
  await withPinnedClock(pinned, () => {
    const currentDate = globalThis["Date"];
    assert.equal(currentDate["now"](), Date.parse(pinned));
    assert.equal(new globalThis["Date"]().toISOString(), pinned);
    assert.equal(new Date("2000-01-01T00:00:00.000Z").toISOString(), "2000-01-01T00:00:00.000Z");
  });
  assert.equal(globalThis.Date, previousDate);
});

test("withPinnedClock restores the prior Date after an async failure", async () => {
  const previousDate = globalThis.Date;
  await assert.rejects(
    withPinnedClock("2026-09-14T00:00:00.000Z", async () => {
      await Promise.resolve();
      throw new Error("fixture failure");
    }),
    /fixture failure/,
  );
  assert.equal(globalThis.Date, previousDate);
});

test("the preload shifts the process clock by the requested whole number of days", () => {
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;
  delete cleanEnv[TEST_CLOCK_ENV];
  const run = (env) => spawnSync(process.execPath, ["--input-type=module", "-e", "console.log(globalThis[\"Date\"][\"now\"]())"], {
    encoding: "utf8",
    env,
  });
  const baseline = Number(run(cleanEnv).stdout.trim());
  const shifted = Number(run({
    ...cleanEnv,
    [TEST_CLOCK_ENV]: "45",
    NODE_OPTIONS: `--import=${PRELOAD}`,
  }).stdout.trim());
  assert.ok(Number.isFinite(baseline) && Number.isFinite(shifted));
  const delta = shifted - baseline;
  assert.ok(delta >= 45 * MILLISECONDS_PER_DAY, `clock shifted by only ${delta}ms`);
  assert.ok(delta < 45 * MILLISECONDS_PER_DAY + 10_000, `clock shifted by too much: ${delta}ms`);
});

test("the local runner and CI workflow use the shared preload with bounded concurrency", () => {
  assert.match(PREFLIGHT, /run_node_test\(\)/);
  assert.match(PREFLIGHT, /CITYSCROLL_TEST_TIME_SHIFT_DAYS/);
  assert.match(PREFLIGHT, /--test-concurrency=\"\$NODE_TEST_CONCURRENCY\"/);
  assert.match(WORKFLOW, /CITYSCROLL_TEST_TIME_SHIFT_DAYS: \$\{\{ matrix\.shift \}\}/);
  assert.match(WORKFLOW, /shift: \[1, 45\]/);
  assert.match(WORKFLOW, /family: \[site-node, worker, combined\]/);
  assert.equal((WORKFLOW.match(/--test-concurrency=2/g) || []).length, 3);
  assert.match(WORKFLOW, /test_clock_preload\.mjs/);
  assert.match(WORKFLOW, /intentionally non-required/);
  assert.match(WORKFLOW, /Refuse tracked working-tree residue/);
  assert.match(WORKFLOW, /tools\/assert_tracked_working_tree_clean\.mjs/);
});

test("time-travel matrix expands to twelve shards with complete per-shift coverage", () => {
  const entries = timeTravelMatrixEntries(WORKFLOW);
  const expanded = expandGithubMatrix({ axes: {}, include: entries });
  const tuple = (entry) => `${entry.shift}:${entry.family}:${entry.shard}`;
  const tuples = expanded.map(tuple);
  assert.equal(expanded.length, 12);
  assert.equal(new Set(tuples).size, 12);
  assert.deepEqual(
    [...new Set(expanded.map((entry) => entry.shift))].sort((a, b) => a - b),
    [1, 45],
  );
  assert.deepEqual(
    [...new Set(expanded.map((entry) => `${entry.family}:${entry.shardCount}`))].sort(),
    ["site-node:4", "worker:2"],
  );

  const allFiles = [...testFilesForFamily("site-node"), ...testFilesForFamily("worker")];
  for (const shift of [1, 45]) {
    const selected = [];
    for (const entry of expanded.filter((candidate) => candidate.shift === shift)) {
      const files = testFilesForFamily(entry.family);
      files.forEach((file, index) => {
        if (index % entry.shardCount === entry.shard - 1) selected.push(file);
      });
    }
    assert.equal(selected.length, allFiles.length, `shift ${shift} runs every test file`);
    assert.equal(new Set(selected).size, selected.length, `shift ${shift} has no duplicate test files`);
    assert.deepEqual([...selected].sort(), [...allFiles].sort(), `shift ${shift} file union is complete`);
  }

  const buggyInclude = entries
    .filter((entry) => entry.shift === 1)
    .map(({ shift, ...entry }) => entry);
  const buggyExpansion = expandGithubMatrix({ axes: { shift: [1, 45] }, include: buggyInclude });
  assert.deepEqual(buggyExpansion.map(tuple), ["1:worker:2", "45:worker:2"]);

  const jobs = workflowJobBlocks(WORKFLOW);
  const requiredAggregates = new Map([
    ["time-travel-combined-plus-1d", "Time-travel (combined, +1d)"],
    ["time-travel-combined-plus-45d", "Time-travel (combined, +45d)"],
  ]);
  const emittedNames = [...jobs.values()]
    .flatMap((lines) => lines.filter((line) => line.match(/^    name: /)))
    .map((line) => line.replace(/^    name: ["]?/, "").replace(/["]?$/, ""));
  for (const [jobId, requiredName] of requiredAggregates) {
    const block = jobs.get(jobId)?.join("\n");
    assert.ok(block, `${jobId} aggregate job is present`);
    assert.ok(emittedNames.includes(requiredName), `${requiredName} check name is emitted`);
    assert.match(block, /if: \$\{\{ always\(\) \}\}/);
    assert.match(block, /needs:\n(?:\s+- [^\n]+\n)*\s+- time-travel\n/);
    assert.match(block, /\s+- time-travel-matrix-contract\n/);
    assert.match(block, /needs\.time-travel\.result != 'success'/);
    assert.match(block, /needs\.time-travel-matrix-contract\.result != 'success'/);
  }
});
