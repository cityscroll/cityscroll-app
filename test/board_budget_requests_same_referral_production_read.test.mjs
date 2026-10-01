import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READBACK = join(ROOT, "docs/evidence/board-budget-requests-same-referral/read-back.json");
const PRODUCTION = join(
  ROOT,
  "docs/evidence/board-budget-requests-same-referral/production-read.json",
);
const MANIFEST = join(
  ROOT,
  "docs/evidence/board-budget-requests-same-referral/capture-manifest.json",
);
const DELIVERY = join(
  ROOT,
  "docs/evidence/board-budget-requests-same-referral/delivery.json",
);
const CAPTURE_TOOL = join(
  ROOT,
  "tools/capture_board_budget_requests_same_referral_production_read.py",
);

const PAGE_EXTRACTED_FIELDS = [
  "referral_earlier",
  "referral_later",
  "sameness_text",
  "rank_text",
  "fiscal_year_text",
  "fiscal_year_attr",
  "tracking_code",
  "agency_scope_after_return",
  "board_path_after_return",
];

const TRACKING_CODE = "214202702C";
const SCOPE_FRAGMENT = "board-budget-requests-named-brooklyn-public-library";

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertCanonicalSortedJson(path) {
  const raw = readFileSync(path, "utf8");
  const sorted = `${JSON.stringify(sortKeysDeep(JSON.parse(raw)), null, 2)}\n`;
  assert.equal(raw, sorted, `${path} must be committed as sorted-key JSON`);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

function gitIsAncestor(ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return result.status === 0;
}

test("same-referral read-back records A1 page-extracted identical referrals", () => {
  assertCanonicalSortedJson(READBACK);
  assertCanonicalSortedJson(PRODUCTION);
  assertCanonicalSortedJson(MANIFEST);
  assertCanonicalSortedJson(DELIVERY);

  const receipt = loadJson(READBACK);
  const delivery = loadJson(DELIVERY);
  assert.equal(receipt.schema, "cityscroll.board_budget_requests_same_referral_production_read.v1");
  assert.equal(receipt.public_alias, "cc479983fe385");
  assert.equal(receipt.evidence_class, "deployed-production-read-back");
  assert.match(receipt.deployment.revision, /^[0-9a-f]{40}$/);
  assert.equal(delivery.schema, "cityscroll.capture_delivery.v1");
  assert.equal(delivery.public_alias, "cc479983fe385");
  assert.equal(delivery.landed_commit, "893c0c03dc77ede8d059d55633c5d9f6646d47c5");
  assert.equal(receipt.deployment.required_ancestor, delivery.landed_commit);
  assert.equal(receipt.deployment.required_ancestor_contained, true);
  assert.equal(receipt.deployment.capture_revision_ancestor_of_head, true);
  assert.ok(
    gitIsAncestor(delivery.landed_commit, receipt.deployment.revision),
    "served revision must contain the delivery",
  );
  assert.ok(
    gitIsAncestor(receipt.deployment.revision, "HEAD"),
    "capture revision must be an ancestor of HEAD",
  );
  assert.equal(
    receipt.producer.path,
    "docs/evidence/board-budget-requests-same-referral/read-back.json",
  );
  assert.deepEqual(receipt.producer.letters, ["A1"]);
  assert.deepEqual(receipt.capture.page_extracted_fields, PAGE_EXTRACTED_FIELDS);
  assert.equal(receipt.capture.diagnostic_publication_withheld, "20270217");

  const a1 = receipt.letters.A1;
  assert.equal(a1.clause, "identical_referrals_named_on_served_page");
  assert.ok(Array.isArray(a1.reads) && a1.reads.length >= 2);

  for (const row of a1.reads) {
    const values = row.served_values;
    assert.ok(values && typeof values === "object", `${row.name} must carry served_values`);
    assert.equal(row.tracking_code, TRACKING_CODE);
    assert.equal(values.tracking_code, TRACKING_CODE);
    assert.ok(values.referral_earlier, `${row.name} referral_earlier`);
    assert.ok(values.referral_later, `${row.name} referral_later`);
    assert.equal(values.referral_earlier, values.referral_later);
    assert.match(String(values.sameness_text || ""), /reads the same/i);
    assert.match(String(values.rank_text || ""), /Priority 02/);
    assert.match(String(values.rank_text || ""), /capital requests to this agency/);
    assert.match(String(values.fiscal_year_text || ""), /2027/);
    assert.equal(values.fiscal_year_attr, "2027");
    assert.equal(values.agency_scope_after_return, SCOPE_FRAGMENT);
    assert.match(String(values.board_path_after_return || ""), /brooklyn-cb-14/);
    assert.equal(values.filters_survived_detail_return, true);
    assert.equal(values.diagnostic_publication_served, false);
    assert.deepEqual(values.page_extracted_fields, PAGE_EXTRACTED_FIELDS);
    assert.equal(row.image_binaries_committed, false);
    assert.equal(row.screenshot_file, null);
    assert.equal("result" in values, false);
    assert.equal("pass" in values, false);
  }
});

test("same-referral production-read stays aligned with the A1 read-back", () => {
  const receipt = loadJson(READBACK);
  const production = loadJson(PRODUCTION);
  assert.equal(production.schema, receipt.schema);
  assert.equal(production.public_alias, "cc479983fe385");
  assert.deepEqual(production.producer.letters, ["A1"]);
  assert.equal(production.letters.A1.reads.length, receipt.letters.A1.reads.length);
  assert.equal(production.deployment.revision, receipt.deployment.revision);
});

test("capture-manifest includes A1 same-referral captures without image binaries", () => {
  const receipt = loadJson(READBACK);
  const manifest = loadJson(MANIFEST);
  assert.equal(manifest.schema, "cityscroll.render_capture_manifest.v1");
  assert.equal(manifest.public_alias, "cc479983fe385");
  assert.equal(manifest.image_binaries_committed, false);
  assert.deepEqual(manifest.producer.letters, ["A1"]);
  assert.equal(manifest.revision, receipt.deployment.revision);
  assert.deepEqual(manifest.page_extracted_fields, PAGE_EXTRACTED_FIELDS);
  const names = new Set((manifest.captures || []).map((row) => row.name));
  for (const row of receipt.letters.A1.reads) {
    assert.ok(names.has(row.name), `missing A1 capture ${row.name}`);
    assert.equal(row.served_values?.referral_earlier, row.served_values?.referral_later);
  }
});

test("generator --check agrees with the retained same-referral A1 read-back", () => {
  const result = spawnSync(
    "python3",
    ["tools/capture_board_budget_requests_same_referral_production_read.py", "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /check passed/);
});

test("A1 helpers refuse missing sameness and record page-extracted fields", () => {
  const source = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(source, /PAGE_EXTRACTED_FIELDS/);
  assert.match(source, /assert_identical_referrals/);
  assert.match(source, /--mutation-control/);
  assert.match(source, /sameness text absent/);
  assert.match(source, /referral text unreadable/);
  assert.match(source, /served referrals differ/);
  assert.match(source, /withheld diagnostic publication/);
  assert.match(source, /REMOVE_SAMENESS_JS/);
  // Positive control: the helper names which fields come from the page.
  for (const field of PAGE_EXTRACTED_FIELDS) {
    assert.match(source, new RegExp(field.replace(/\./g, "\\.")));
  }
});

test("mutation-control path is present and expects refusal on removed sameness text", () => {
  const source = readFileSync(CAPTURE_TOOL, "utf8");
  assert.match(source, /mutation-control refused as expected/);
  assert.match(source, /mutation-control unexpectedly succeeded/);
  assert.match(source, /mutate_sameness/);
});
