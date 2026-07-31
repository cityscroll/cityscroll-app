// Characterization: token_v0 blocker + candidate_recall wiring (er-05).
//
//   node --test test/entity_resolution_blocker.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  applyTokenV0,
  isCandidatePair,
  sharedBlockKeys,
  significantTokens,
  blockKeysForSide,
  BLOCKER_ID,
} from "../entity_resolution/eval/blockers/token_v0.mjs";
import {
  loadGold,
  computeMetrics,
  runBlocker,
  pickBlockExamples,
} from "../entity_resolution/eval/run_metrics.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOLD = join(ROOT, "entity_resolution/eval/gold_v0.jsonl");
const HARNESS = join(ROOT, "entity_resolution/eval/run_metrics.mjs");

test("blocker id is token_v0", () => {
  assert.equal(BLOCKER_ID, "token_v0");
});

test("significantTokens drops stopwords and short noise", () => {
  const toks = significantTokens("THE DEPARTMENT OF HEALTH AND MENTAL HYGIENE");
  assert.ok(toks.includes("HEALTH"));
  assert.ok(toks.includes("MENTAL"));
  assert.ok(toks.includes("HYGIENE"));
  assert.ok(!toks.includes("THE"));
  assert.ok(!toks.includes("OF"));
  assert.ok(!toks.includes("DEPARTMENT"));
});

test("HNTB truncation pair shares HNTB token (blocked-in)", () => {
  const left = {
    display_name: "HNTB New York Engineering and Architecture, P.C.",
    attrs: { pin: "84124P0003001" },
  };
  const right = {
    display_name: "HNTB",
    attrs: { pin: "84124P0003001" },
  };
  assert.equal(isCandidatePair(left, right, "vendor"), true);
  const shared = sharedBlockKeys(left, right, "vendor");
  assert.ok(shared.some((k) => k === "tok:HNTB" || k === "pin:84124P0003001"));
});

test("title vs PIN procurement pair is blocked-out (no shared keys)", () => {
  const left = { display_name: "Catering Services" };
  const right = { display_name: "PIN 26AE017201R0X00", native_key: "26AE017201R0X00" };
  assert.equal(isCandidatePair(left, right, "procurement"), false);
  assert.deepEqual(sharedBlockKeys(left, right, "procurement"), []);
});

test("Camba legal-suffix variants share stem key", () => {
  const left = { display_name: "Camba Inc." };
  const right = { display_name: "CAMBA  INC" };
  assert.equal(isCandidatePair(left, right, "vendor"), true);
  const keys = sharedBlockKeys(left, right, "vendor");
  assert.ok(keys.includes("stem:CAMBA") || keys.includes("tok:CAMBA"));
});

test("applyTokenV0 on gold yields candidate_recall in [0,1]", () => {
  const text = readFileSync(GOLD, "utf8");
  const { cases } = loadGold(text);
  const { candidateIds, details } = applyTokenV0(cases);
  assert.ok(details.length === cases.length);
  const metrics = computeMetrics(cases, null, candidateIds);
  assert.equal(typeof metrics.candidate_recall, "number");
  assert.ok(metrics.candidate_recall >= 0 && metrics.candidate_recall <= 1);
  // Scorer metrics stay null without predictions.
  assert.equal(metrics.precision, null);
  assert.equal(metrics.recall, null);
});

test("pickBlockExamples documents blocked-in and blocked-out true matches", () => {
  const text = readFileSync(GOLD, "utf8");
  const { cases } = loadGold(text);
  const { details } = applyTokenV0(cases);
  const ex = pickBlockExamples(details, 3);
  assert.ok(ex.blocked_in.length >= 1, "expect at least one blocked-in same pair");
  for (const d of ex.blocked_in) {
    assert.equal(d.label, "same");
    assert.equal(d.blocked_in, true);
    assert.ok(d.shared_keys.length >= 1);
  }
  // blocked_out may be empty if recall is 1.0; if present, must be gold same.
  for (const d of ex.blocked_out) {
    assert.equal(d.label, "same");
    assert.equal(d.blocked_in, false);
  }
});

test("runBlocker dispatches token_v0 and ignores none", () => {
  const cases = [
    {
      id: "t1",
      label: "same",
      entity_type: "vendor",
      left: { display_name: "Acme Construction LLC" },
      right: { display_name: "ACME CONSTRUCTION, INC." },
    },
  ];
  assert.equal(runBlocker("none", cases), null);
  assert.equal(runBlocker(null, cases), null);
  const r = runBlocker("token_v0", cases);
  assert.ok(r.candidateIds.has("t1"));
});

test("CLI --blocker token_v0 prints candidate_recall in [0,1] and block examples", () => {
  const r = spawnSync(
    process.execPath,
    [HARNESS, "--gold", GOLD, "--blocker", "token_v0"],
    { encoding: "utf8", cwd: ROOT },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const m = r.stdout.match(/^candidate_recall=([0-9.]+|null)$/m);
  assert.ok(m, `candidate_recall line missing:\n${r.stdout}`);
  assert.notEqual(m[1], "null");
  const cr = Number(m[1]);
  assert.ok(cr >= 0 && cr <= 1, `candidate_recall ${cr} not in [0,1]`);
  assert.match(r.stdout, /blocked_in\t/);
  assert.match(r.stdout, /blocker=token_v0/);
  // No production side effects: harness is offline.
  assert.doesNotMatch(r.stdout, /auto.?link|D1|production/i);
});

test("CLI dry-run without blocker keeps candidate_recall null", () => {
  const r = spawnSync(
    process.execPath,
    [HARNESS, "--gold", GOLD, "--dry-run"],
    { encoding: "utf8", cwd: ROOT },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /^candidate_recall=null$/m);
});

test("blockKeysForSide is pure and does not invent production links", () => {
  const keys = blockKeysForSide(
    { display_name: "Sinergia Inc", attrs: { pin: "abc-123" } },
    "vendor",
  );
  assert.ok(keys.has("stem:SINERGIA") || keys.has("tok:SINERGIA"));
  assert.ok(keys.has("pin:ABC123"));
});
