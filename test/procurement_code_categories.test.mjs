// NYC commodity categories: the City's L1-L3 labels are public; L5 (NIGP) descriptions are not.
//
//   node --test test/procurement_code_categories.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_COUNTS,
  NYC_COMMODITY_CATEGORIES_SCHEMA,
  PUBLIC_NYC_CATEGORY_CODE_FIELDS,
  RETAINED_SOURCE_DIGESTS,
  assertPublicNycCategoriesPayload,
  buildCommodityCategoryIndex,
  normalizeCommodityLabel,
  resolveCommodityCategory,
  validateCatalogActivation,
} from "../site/procurement_code_catalog.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CATEGORIES_PATH = join(ROOT, "site/data/procurement_codes/nyc-commodity-categories.json");
const STATUS_PATH = join(ROOT, "site/data/procurement_codes/nyc-commodity-status.json");
const MANIFEST_PATH = join(ROOT, "site/data/procurement_code_catalog_manifest.json");
const BUILDER = join(ROOT, "tools/build_procurement_code_catalog.py");

const text = readFileSync(CATEGORIES_PATH, "utf8");
const artifact = () => JSON.parse(text);

function python(source, files = {}) {
  const directory = mkdtempSync(join(tmpdir(), "nyc-categories-py-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(directory, name), body);
  try {
    return spawnSync("python3", ["-c", `import importlib.util, json, pathlib, sys
D = pathlib.Path(${JSON.stringify(directory)})
spec = importlib.util.spec_from_file_location("b", ${JSON.stringify(BUILDER)})
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
${source}`], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("categories artifact publishes 6 L1, 53 L2 and 404 L3 categories with ancestor chains", () => {
  const a = artifact();
  assert.equal(a.schema, NYC_COMMODITY_CATEGORIES_SCHEMA);
  assert.equal(a.source_sha256, RETAINED_SOURCE_DIGESTS["procurement-codes-nyc-commodity-directory"]);
  const byLevel = (level) => a.categories.filter((row) => row.level === level);
  assert.equal(byLevel(1).length, EXPECTED_COUNTS.nycCategoryL1);
  assert.equal(byLevel(2).length, EXPECTED_COUNTS.nycCategoryL2);
  assert.equal(byLevel(3).length, EXPECTED_COUNTS.nycCategoryL3);
  assert.equal(a.categories.length, 463);
  const key = (level, code) => `${level}:${code}`;
  const index = new Map(a.categories.map((row) => [key(row.level, row.code), row]));
  for (const row of a.categories) {
    assert.ok(row.label.length > 0);
    assert.equal(row.parents.length, row.level - 1, `${row.code} ancestor chain`);
    row.parents.forEach((parent, depth) => assert.ok(index.has(key(depth + 1, parent)), `${row.code} -> ${parent}`));
    if (row.level === 3) assert.deepEqual(index.get(key(2, row.parents[1])).parents, [row.parents[0]]);
  }
  assert.deepEqual(a.counts, {
    l1: 6, l2: 53, l3: 404, codes: 9038, codes_by_status: { inactive: 150, listed: 8888 },
  });
});

test("every L5 code resolves to a named L3 category through code/status/l1/l2/l3 only", () => {
  const a = artifact();
  const status = JSON.parse(readFileSync(STATUS_PATH, "utf8"));
  assert.equal(a.codes.length, EXPECTED_COUNTS.nycNumericRows);
  const pairs = (rows) => rows.map((row) => `${row.code}:${row.status}`).sort().join(",");
  assert.equal(pairs(a.codes), pairs(status.records), "same codes and statuses as the status artifact");
  assert.equal(a.version, status.version);
  const l3 = new Map(a.categories.filter((row) => row.level === 3).map((row) => [row.code, row]));
  const fields = [...PUBLIC_NYC_CATEGORY_CODE_FIELDS].sort().join(",");
  for (const row of a.codes) {
    assert.equal(Object.keys(row).sort().join(","), fields);
    const category = l3.get(row.l3);
    assert.ok(category, `${row.code} -> ${row.l3}`);
    assert.equal(category.parents.join(","), `${row.l1},${row.l2}`, row.code);
  }
  assertPublicNycCategoriesPayload(text);
});

test("manifest registers the categories artifact like the two existing catalogs", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const entry = validateCatalogActivation({ manifest, artifact: artifact(), scheme: "NYC_COMMODITY_CATEGORIES" });
  assert.equal(entry.path, "/data/procurement_codes/nyc-commodity-categories.json");
  assert.equal(entry.sha256, createHash("sha256").update(readFileSync(CATEGORIES_PATH)).digest("hex"));
  assert.equal(entry.source_sha256, RETAINED_SOURCE_DIGESTS["procurement-codes-nyc-commodity-directory"]);
  assert.equal(entry.source_url, artifact().source_url);
  assert.deepEqual(entry.counts, { l1: 6, l2: 53, l3: 404, codes: 9038 });
  assert.equal(entry.records, 463);
  assert.equal(entry.freshness.checked_at, artifact().checked_at);
  assert.deepEqual(manifest.catalogs.map((row) => row.scheme), ["NAICS", "NYC_COMMODITY", "NYC_COMMODITY_CATEGORIES"]);
});

test("the Worker bundles exactly the L3 projection of the public artifact", async () => {
  const { buildWorkerL3Index } = await import("../tools/build_procurement_code_manifest.mjs");
  const bundled = readFileSync(join(ROOT, "worker/src/data/nyc_commodity_l3_categories.json"), "utf8");
  assert.equal(bundled, buildWorkerL3Index(), "rebuild with node tools/build_procurement_code_manifest.mjs");
  const index = JSON.parse(bundled);
  assert.equal(index.categories.length, 404);
  assert.equal(index.categories_sha256, createHash("sha256").update(readFileSync(CATEGORIES_PATH)).digest("hex"));
  assert.ok(Buffer.byteLength(bundled) < 512 * 1024, "stays under the Worker startup per-file JSON budget");
  assert.equal(buildCommodityCategoryIndex(index).byLabel.size, 404);
});

test("failure: an L5 description in public output is refused (JS guard)", () => {
  const leaked = artifact();
  leaked.codes[0].label = "SAMPLE L5 DESCRIPTION";
  assert.throws(() => assertPublicNycCategoriesPayload(leaked), /forbidden field label/);
  const disguised = artifact();
  disguised.codes[0].note = "SAMPLE L5 DESCRIPTION";
  assert.throws(() => assertPublicNycCategoriesPayload(disguised), /not code\/status\/l1\/l2\/l3/);
  const asCategory = artifact();
  asCategory.categories.find((row) => row.level === 3).label = "SAMPLE L5 DESCRIPTION";
  const cityLabels = artifact().categories.map((row) => row.label);
  assert.throws(
    () => assertPublicNycCategoriesPayload(asCategory, {
      l5Descriptions: ["SAMPLE L5 DESCRIPTION"], categoryLabels: cityLabels,
    }),
    /contains an L5 description/,
  );
  const level5 = artifact();
  level5.categories.push({ code: "00500", label: "SAMPLE L5 DESCRIPTION", level: 5, parents: ["2", "21", "154"] });
  assert.throws(() => assertPublicNycCategoriesPayload(level5), /not an L1-L3 category/);
  // A description identical to a published City category label is the City's label, not a leak.
  const shared = artifact().categories.find((row) => row.level === 3).label;
  assert.equal(assertPublicNycCategoriesPayload(artifact(), { l5Descriptions: [shared] }), true);
});

test("failure: the builder refuses a payload carrying L5 description text", () => {
  const ok = python(`p = (D / "a.json").read_text()
b.assert_public_nyc_categories(p, ["SAMPLE L5 DESCRIPTION"], [r["label"] for r in json.loads(p)["categories"]])
print("clean")`, { "a.json": text });
  assert.equal(ok.status, 0, ok.stderr);
  const leaked = artifact();
  leaked.categories.find((row) => row.level === 3).label = "SAMPLE L5 DESCRIPTION";
  const refused = python(
    `b.assert_public_nyc_categories((D / "a.json").read_text(), ["SAMPLE L5 DESCRIPTION"], [r["label"] for r in json.loads((D / "orig.json").read_text())["categories"]])`,
    { "a.json": JSON.stringify(leaked), "orig.json": text },
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /leaked 1 L5 description/);
  const keyed = artifact();
  keyed.codes[0].description = "SAMPLE L5 DESCRIPTION";
  const refusedKey = python(`b.assert_public_nyc_categories((D / "a.json").read_text(), [], [])`, {
    "a.json": JSON.stringify(keyed),
  });
  assert.notEqual(refusedKey.status, 0);
  assert.match(refusedKey.stderr + refusedKey.stdout, /code row has fields/);
});

test("failure: a duplicate L3 label is refused by the index and by the builder", () => {
  const dup = artifact();
  const l3 = dup.categories.filter((row) => row.level === 3);
  l3[1].label = `  ${l3[0].label.toUpperCase()} `;
  assert.equal(normalizeCommodityLabel(l3[1].label), normalizeCommodityLabel(l3[0].label));
  assert.throws(() => buildCommodityCategoryIndex(dup), /duplicate NYC L3 category label/);
  const built = python(`
levels = {}
def add(level, code, label, parents):
    levels[(level, code)] = {"code": code, "label": label, "level": level, "parents": parents, "status": "listed"}
add(1, "1", "One", [])
add(2, "01", "Two", ["1"])
add(3, "001", "Repair Services", ["01"])
add(3, "002", "repair  services", ["01"])
b.NYC_CATEGORY_COUNTS = {1: 1, 2: 1, 3: 2}
b.build_nyc_categories(levels, {}, "v", "d", "t", {}, D / "out.json")`);
  assert.notEqual(built.status, 0);
  assert.match(built.stderr + built.stdout, /duplicate NYC L3 category label/);
});

test("failure: a workbook whose digest differs is refused before anything is written", () => {
  const directory = mkdtempSync(join(tmpdir(), "nyc-categories-digest-"));
  try {
    const input = join(directory, "directory.xlsx");
    writeFileSync(input, "PK not the retained workbook");
    const result = python(`b.build_nyc(pathlib.Path(${JSON.stringify(input)}), None, pathlib.Path(${JSON.stringify(join(directory, "status.json"))}))`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /does not match retained 6325fbf06b26/);
    assert.equal(spawnSync("ls", [directory], { encoding: "utf8" }).stdout.trim(), "directory.xlsx");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("label resolution is exact after normalization; nothing fuzzy, nothing guessed", () => {
  const index = buildCommodityCategoryIndex(artifact());
  assert.equal(index.byLabel.size, 404);
  const hit = resolveCommodityCategory("IT Consulting", index);
  assert.deepEqual(hit, {
    status: "matched", code: "351", label: "IT Consulting", level: 3, parents: ["5", "38"],
    catalog_version: artifact().version,
  });
  assert.equal(resolveCommodityCategory("  it   CONSULTING ", index).code, "351");
  assert.deepEqual(resolveCommodityCategory("IT Consultin", index), { status: "unmatched", raw_label: "IT Consultin" });
  assert.deepEqual(resolveCommodityCategory("CONSULTING SERVICES", index), {
    status: "unmatched", raw_label: "CONSULTING SERVICES",
  });
  assert.deepEqual(resolveCommodityCategory(null, index), { status: "no_label" });
  assert.deepEqual(resolveCommodityCategory("   ", index), { status: "no_label" });
});
