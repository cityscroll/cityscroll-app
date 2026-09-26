/**
 * Shared hermetic ACTIVE-generation bootstrap contract.
 *
 * Guards generation-publishing refresh modules against bypassing the shared
 * cold-checkout path that keeps committed ACTIVE bytes stable when refresh
 * receipts are gitignored (CI + time-travel suites).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOOTSTRAP_COMMITTED_REASON,
  BOOTSTRAP_IDLE_NO_ACTIVE_REASON,
  BOOTSTRAP_UNCHANGED_MESSAGE,
  buildBootstrapUnchangedReceipt,
  shouldBootstrapCommittedRefresh,
  tryBootstrapCommittedRefresh,
} from "../site/generation_refresh_bootstrap.mjs";
import {
  installClockShift,
  TEST_CLOCK_ENV,
} from "./helpers/test_clock.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE_DIR = path.join(ROOT, "site");
const SHARED_HELPER = "generation_refresh_bootstrap.mjs";
const SHARED_IMPORT_RE = /from\s+["']\.\/generation_refresh_bootstrap\.mjs["']/;
const SHARED_CALL_RE = /\btryBootstrapCommittedRefresh\s*\(/;

/** Refresh families that publish ACTIVE generations and must use the shared bootstrap. */
const REQUIRED_GENERATION_REFRESH_MODULES = Object.freeze([
  "site/board_neighborhood_refresh.mjs",
  "site/land_place_refresh.mjs",
  "site/address_geography_refresh.mjs",
]);

function readSiteModule(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function looksLikeGenerationRefreshPublisher(source, basename) {
  if (basename === SHARED_HELPER) return false;
  const hasActive = /\bACTIVE_POINTER\b|"ACTIVE"|'ACTIVE'/.test(source);
  const hasReceipt = /refresh[_-]receipt|REFRESH_RECEIPT/.test(source);
  const hasBootstrapFlag = /\bbootstrapCommitted\b/.test(source);
  const hasMissingPrevious = /missing_previous_hashes|missing_previous/.test(source);
  return (hasActive && (hasReceipt || hasBootstrapFlag || hasMissingPrevious))
    || (hasBootstrapFlag && hasReceipt);
}

function discoverGenerationRefreshPublishers() {
  const found = new Set(REQUIRED_GENERATION_REFRESH_MODULES);
  for (const name of readdirSync(SITE_DIR)) {
    if (!name.endsWith(".mjs")) continue;
    if (!/refresh|backfill|generation/.test(name)) continue;
    const relative = `site/${name}`;
    const source = readSiteModule(relative);
    if (looksLikeGenerationRefreshPublisher(source, name)) {
      found.add(relative);
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

test("shouldBootstrapCommittedRefresh seeds only on cold committed checkouts", () => {
  assert.equal(shouldBootstrapCommittedRefresh({
    prior: null,
    activeBefore: "gen-a",
    bootstrapCommitted: true,
    activeMatches: true,
  }), true);

  assert.equal(shouldBootstrapCommittedRefresh({
    prior: { status: "unchanged" },
    activeBefore: "gen-a",
    activeMatches: true,
  }), false);

  assert.equal(shouldBootstrapCommittedRefresh({
    prior: null,
    activeBefore: "gen-a",
    force: true,
    activeMatches: true,
  }), false);

  assert.equal(shouldBootstrapCommittedRefresh({
    prior: null,
    activeBefore: "gen-a",
    injectFailure: "timeout",
    activeMatches: true,
  }), false);

  assert.equal(shouldBootstrapCommittedRefresh({
    prior: null,
    activeBefore: "gen-a",
    bootstrapCommitted: false,
    activeMatches: true,
  }), false);

  assert.equal(shouldBootstrapCommittedRefresh({
    prior: null,
    activeBefore: "gen-a",
    activeMatches: false,
  }), false);

  // Address-geography style: idle cold start with no ACTIVE yet.
  assert.equal(shouldBootstrapCommittedRefresh({
    prior: null,
    activeBefore: null,
    activeMatches: null,
  }), true);
});

test("buildBootstrapUnchangedReceipt records bootstrap_committed_inputs without work", () => {
  const receipt = buildBootstrapUnchangedReceipt({
    receiptSchema: "cityscroll.test_receipt.v1",
    planSchema: "cityscroll.test_plan.v1",
    now: "2026-09-26T12:00:00.000Z",
    activeBefore: "gen-a",
    planFields: { changed_inputs: Object.freeze([]) },
    receiptFields: { input_hashes: { aggregate: "abc" }, failed_at: null },
  });
  assert.equal(receipt.status, "unchanged");
  assert.equal(receipt.plan.work_required, false);
  assert.deepEqual([...receipt.plan.reasons], [BOOTSTRAP_COMMITTED_REASON]);
  assert.equal(receipt.active_generation, "gen-a");
  assert.equal(receipt.message, BOOTSTRAP_UNCHANGED_MESSAGE);
  assert.equal(receipt.input_hashes.aggregate, "abc");

  const idle = buildBootstrapUnchangedReceipt({
    receiptSchema: "cityscroll.test_receipt.v1",
    planSchema: "cityscroll.test_plan.v1",
    now: "2026-09-26T12:00:00.000Z",
    activeBefore: null,
  });
  assert.deepEqual([...idle.plan.reasons], [BOOTSTRAP_IDLE_NO_ACTIVE_REASON]);
});

test("tryBootstrapCommittedRefresh persists receipt and returns unchanged under a shifted clock", () => {
  const restore = installClockShift(45);
  try {
    const shiftedNow = new Date().toISOString();
    assert.match(shiftedNow.slice(0, 4), /^20(2[6-9]|[3-9]\d)$/);
    const saved = [];
    const result = tryBootstrapCommittedRefresh({
      prior: null,
      activeBefore: "gen-stable",
      bootstrapCommitted: true,
      activeMatches: true,
      saveReceipt: (receipt) => saved.push(receipt),
      receiptSchema: "cityscroll.test_receipt.v1",
      planSchema: "cityscroll.test_plan.v1",
      now: shiftedNow,
      receiptFields: { input_hashes: { aggregate: "same" } },
      resultFields: { index: { generation: { id: "gen-stable" } } },
    });
    assert.ok(result);
    assert.equal(result.status, "unchanged");
    assert.equal(result.active_generation, "gen-stable");
    assert.equal(result.index.generation.id, "gen-stable");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].started_at, shiftedNow);
    assert.deepEqual([...saved[0].plan.reasons], [BOOTSTRAP_COMMITTED_REASON]);
    // Positive control: bootstrap does not invent a new generation id from the
    // shifted clock; callers keep the committed ACTIVE identity.
    assert.equal(result.receipt.active_generation, "gen-stable");
  } finally {
    restore();
  }
});

test("every generation-publishing refresh module uses the shared bootstrap helper", () => {
  const publishers = discoverGenerationRefreshPublishers();
  assert.ok(
    publishers.length >= REQUIRED_GENERATION_REFRESH_MODULES.length,
    `expected at least the required publishers, got ${publishers.join(",")}`,
  );

  for (const relative of publishers) {
    const source = readSiteModule(relative);
    assert.match(
      source,
      SHARED_IMPORT_RE,
      `${relative} must import ${SHARED_HELPER} so cold ACTIVE checkouts stay hermetic under time-travel`,
    );
    assert.match(
      source,
      SHARED_CALL_RE,
      `${relative} must call tryBootstrapCommittedRefresh (do not reintroduce a local bootstrap variant)`,
    );
    // Inline duplicate of the cold-checkout gate is the failure mode this meta
    // change removes; keep the decision in the shared helper.
    assert.equal(
      /bootstrap_committed_inputs/.test(source) && !SHARED_CALL_RE.test(source),
      false,
    );
  }

  for (const required of REQUIRED_GENERATION_REFRESH_MODULES) {
    assert.ok(
      publishers.includes(required),
      `required publisher missing from discovery: ${required}`,
    );
  }
});

test("time-travel workflow still shifts Date.now for site-node families", () => {
  const workflow = readFileSync(
    path.join(ROOT, ".github/workflows/time-travel.yml"),
    "utf8",
  );
  assert.match(workflow, /CITYSCROLL_TEST_TIME_SHIFT_DAYS/);
  assert.match(workflow, /test_clock_preload\.mjs/);
  assert.match(workflow, /site-node/);
  // Suites stay meaningful: the workflow must keep running shifted unit tests.
  assert.doesNotMatch(workflow, /skip.*time-travel|continue-on-error:\s*true/i);
  assert.equal(TEST_CLOCK_ENV, "CITYSCROLL_TEST_TIME_SHIFT_DAYS");
});
