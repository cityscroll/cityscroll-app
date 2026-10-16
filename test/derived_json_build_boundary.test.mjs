import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TEST_CLOCK_PIN_ENV, withPinnedClock } from "./helpers/test_clock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "warehouse/derived_json_build_manifest.json");

test("derived JSON manifest pins static delivery and a retained source snapshot", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.schema, "cityscroll.derived_json_build_manifest.v1");
  assert.equal(manifest.delivery.public_tree, "site/data");
  assert.equal(manifest.delivery.mode, "materialized-static");
  assert.equal(manifest.delivery.request_time_source_reads, false);
  assert.equal(manifest.ci_time_budget.seconds, 1200);
  assert.equal(manifest.ci_time_budget.mode, "cold-build");
  assert.ok(manifest.ci_time_budget.seconds >= 1062);
  assert.equal(manifest.ci_time_budget.scope, "derived-json-build-boundary");
  assert.match(manifest.source_snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.source_snapshot.required_receipts.length >= 4);
  assert.ok(manifest.generated_families.length >= 10);
  assert.equal(
    new Set(manifest.generated_families.map((family) => family.id)).size,
    manifest.generated_families.length,
  );
  for (const family of manifest.generated_families) {
    assert.ok(family.generator);
    assert.ok(family.source_paths.length);
    assert.ok(family.output_paths.length);
  }
});

test("generated families run in an order where every family's inputs are produced before it runs", () => {
  // The boundary regenerates families strictly in array order (tools/derived_json_build_boundary.mjs).
  // A family whose source_paths name another family's output_paths must be listed after that
  // family, or it will build from that family's stale prior output.
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const families = manifest.generated_families;
  const producedAt = new Map();
  families.forEach((family, index) => {
    for (const outputPath of family.output_paths) producedAt.set(outputPath, index);
  });
  families.forEach((family, index) => {
    for (const sourcePath of family.source_paths) {
      const producerIndex = producedAt.get(sourcePath);
      if (producerIndex === undefined) continue;
      assert.ok(
        producerIndex < index,
        `${family.id} (position ${index}) declares ${sourcePath} as a source, but that path is produced by `
          + `${families[producerIndex].id} at position ${producerIndex}, which runs later or the same run; `
          + `move ${family.id} after ${families[producerIndex].id} in generated_families`,
      );
    }
  });
});

test("keyword search boundary tracks the committed sharded output tree", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const family = manifest.generated_families.find(({ id }) => id === "keyword-search");
  assert.ok(family);
  assert.deepEqual(family.output_paths, ["worker/src/data/keyword_search_index_shards"]);
  assert.ok(existsSync(path.join(ROOT, family.output_paths[0])));
  assert.equal(existsSync(path.join(ROOT, "worker/src/data/keyword_search_index.json")), false);
  for (const producer of [
    "site/agency_search_producer.mjs",
    "site/board_search_producer.mjs",
    "site/committee_search_producer.mjs",
    "site/community_board_people_search_producer.mjs",
    "site/exam_search_producer.mjs",
    "site/land_search_producer.mjs",
    "site/meeting_search_producer.mjs",
    "site/parcel_search_producer.mjs",
    "site/people_search_producer.mjs",
    "site/procurement_search_producer.mjs",
    "site/vendor_search_producer.mjs",
  ]) assert.ok(family.source_paths.includes(producer), producer);
});

test("required PR CI catches a stale keyword read model before Worker deployment", () => {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /name: Committed keyword search read-model freshness[\s\S]*?node tools\/build_keyword_search_index\.mjs --check/);
});

test("familyCheckCurrent reports whether a generator --check already passes", async () => {
  const { familyCheckCurrent } = await import(path.join(ROOT, "tools/derived_json_build_boundary.mjs"));
  const dir = mkdtempSync(path.join(os.tmpdir(), "derived-json-check-current-"));
  try {
    writeFileSync(path.join(dir, "ok.mjs"), "process.exit(process.argv.includes('--check') ? 0 : 1);\n");
    writeFileSync(path.join(dir, "bad.mjs"), "process.exit(1);\n");
    assert.equal(familyCheckCurrent(dir, "ok.mjs"), true);
    assert.equal(familyCheckCurrent(dir, "bad.mjs"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only opt-in families may skip, and weak checks still rebuild on changed input or missing receipt", async () => {
  const {
    decideFamilyRebuildAction,
    familyMaySkipWhenCheckCurrent,
    runGeneratedFamilies,
  } = await import(path.join(ROOT, "tools/derived_json_build_boundary.mjs"));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const procurement = manifest.generated_families.find((family) => family.id === "procurement");
  const address = manifest.generated_families.find((family) => family.id === "address-geography-refresh");
  const board = manifest.generated_families.find((family) => family.id === "board-neighborhood-refresh");
  const land = manifest.generated_families.find((family) => family.id === "land-place-refresh");
  assert.equal(familyMaySkipWhenCheckCurrent(procurement), true);
  assert.equal(familyMaySkipWhenCheckCurrent(address), false);
  assert.equal(familyMaySkipWhenCheckCurrent(board), false);
  assert.equal(familyMaySkipWhenCheckCurrent(land), false);

  const dir = mkdtempSync(path.join(os.tmpdir(), "derived-json-skip-path-"));
  try {
    mkdirSync(path.join(dir, "out"), { recursive: true });
    writeFileSync(path.join(dir, "input.json"), '{"v":1}\n');
    // Strong check: compares an input digest file written at build time.
    writeFileSync(path.join(dir, "strong.mjs"), `
      import { readFileSync, writeFileSync, existsSync } from "node:fs";
      const input = readFileSync("input.json", "utf8");
      const receipt = "out/strong.receipt";
      const output = "out/strong.json";
      if (process.argv.includes("--check")) {
        if (!existsSync(receipt) || !existsSync(output)) process.exit(1);
        const body = JSON.parse(readFileSync(receipt, "utf8"));
        process.exit(body.input === input ? 0 : 1);
      }
      writeFileSync(output, JSON.stringify({ built: true, input }) + "\\n");
      writeFileSync(receipt, JSON.stringify({ input }) + "\\n");
    `);
    // Weak check: exit 0 even when the receipt is missing (address-geography shape).
    writeFileSync(path.join(dir, "weak.mjs"), `
      import { writeFileSync, existsSync } from "node:fs";
      const output = "out/weak.json";
      if (process.argv.includes("--check")) {
        console.log(existsSync(output) ? "ok weak" : "ok weak: no receipt yet (idle)");
        process.exit(0);
      }
      writeFileSync(output, JSON.stringify({ built: true }) + "\\n");
    `);

    const strongFamily = {
      id: "strong",
      generator: "strong.mjs",
      skip_when_check_current: true,
      source_paths: ["input.json"],
      output_paths: ["out/strong.json"],
    };
    const weakFamily = {
      id: "weak",
      generator: "weak.mjs",
      source_paths: ["input.json"],
      output_paths: ["out/weak.json"],
    };

    // Missing receipt: strong must build; weak check passes but is not skip-eligible → build.
    assert.equal(decideFamilyRebuildAction(strongFamily, dir), "build");
    assert.equal(decideFamilyRebuildAction(weakFamily, dir), "build");
    let results = runGeneratedFamilies(dir, [strongFamily, weakFamily]);
    assert.equal(results.find((row) => row.id === "strong").skipped, false);
    assert.equal(results.find((row) => row.id === "weak").skipped, false);
    assert.ok(existsSync(path.join(dir, "out/strong.json")));
    assert.ok(existsSync(path.join(dir, "out/weak.json")));

    // Current inputs: strong may skip; weak still rebuilds.
    results = runGeneratedFamilies(dir, [strongFamily, weakFamily]);
    assert.equal(results.find((row) => row.id === "strong").skipped, true);
    assert.equal(results.find((row) => row.id === "weak").skipped, false);

    // Changed input: strong must rebuild even though it is skip-eligible.
    writeFileSync(path.join(dir, "input.json"), '{"v":2}\n');
    assert.equal(decideFamilyRebuildAction(strongFamily, dir), "build");
    assert.equal(decideFamilyRebuildAction(weakFamily, dir), "build");
    results = runGeneratedFamilies(dir, [strongFamily, weakFamily]);
    assert.equal(results.find((row) => row.id === "strong").skipped, false);
    assert.equal(results.find((row) => row.id === "weak").skipped, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the retained source snapshot validation fails closed before generation", async () => {
  const pinned = "2026-09-14T00:00:00.000Z";
  await withPinnedClock(pinned, () => {
    const nodeOptions = [process.env.NODE_OPTIONS, `--import=${path.join(ROOT, "test/helpers/test_clock_preload.mjs")}`]
      .filter(Boolean)
      .join(" ");
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "tools/derived_json_build_boundary.mjs"),
      "--source-dir",
      ROOT,
      "--validate-only",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: nodeOptions, [TEST_CLOCK_PIN_ENV]: pinned },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Derived JSON build boundary valid/);
  });
});

test("payload integrity can inspect the materialized artifact directory", () => {
  const artifact = mkdtempSync(path.join(os.tmpdir(), "cityscroll-pages-"));
  try {
    mkdirSync(path.join(artifact, "data"));
    writeFileSync(path.join(artifact, "index.html"), "<!doctype html><title>CityScroll</title>\n");
    writeFileSync(path.join(artifact, "data", "example.json"), "{}\n");
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "tools/check_public_payload_integrity.mjs"),
      "--site-dir",
      artifact,
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 payload trees/);
  } finally {
    rmSync(artifact, { recursive: true, force: true });
  }
});
