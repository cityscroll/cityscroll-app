// Multi-dimension flywheel orchestrator + idempotent queue.
//
//   node --test test/multi_flywheel.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  loadDefaultInputs,
  runMultiFlywheel,
  planLessonFileUpdate,
} from "../ontology/flywheel_run.mjs";
import {
  reconcileQueue,
  emptyLedger,
  updateLedger,
  applyVerifyToLedger,
  QUEUE_SCHEMA,
  LEDGER_SCHEMA,
} from "../ontology/card_queue.mjs";
import {
  extractRecurringLessons,
  mergeLessonsIntoMarkdown,
  defaultLessonsHeader,
} from "../ontology/engineering_lessons.mjs";
import { makeDimensionCard } from "../ontology/dimensions/shared.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("runMultiFlywheel emits ranked multi-dimension queue with verify+demo_win", () => {
  const inputs = loadDefaultInputs(ROOT, { mode: "fixture" });
  const { queue, raw_card_count, dimensions_run } = runMultiFlywheel({
    inputs,
    generated_at: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(queue.schema, QUEUE_SCHEMA);
  assert.equal(dimensions_run.length, 7);
  assert.ok(raw_card_count >= queue.stats.card_count);
  assert.ok(queue.stats.card_count >= 1);
  assert.ok(queue.content_hash);

  const dims = new Set(queue.cards.map((c) => c.dimension));
  assert.ok(dims.has("data-integrity"), "expected data-integrity cards");
  assert.ok(dims.has("readability"), "expected readability cards");
  assert.ok(dims.has("coverage") || dims.has("ontology-enrichment"), "expected coverage or enrichment");

  for (const card of queue.cards) {
    assert.ok(card.id.startsWith("crol-list/mf-"));
    assert.ok(card.verify && card.verify.length > 0, card.id);
    assert.ok(card.demo_win && card.demo_win.length > 0, card.id);
    assert.ok(Number.isInteger(card.rank) && card.rank >= 1);
    assert.equal(card.emitted_by, "multi_flywheel");
  }
  // Ranks are dense 1..n
  assert.deepEqual(
    queue.cards.map((c) => c.rank),
    queue.cards.map((_, i) => i + 1),
  );
});

test("reconcileQueue is idempotent: open and fixed cards are not re-emitted", () => {
  const card = makeDimensionCard({
    dimension: "data-integrity",
    slug: "always-null-demo-feature",
    title: "Demo always-null feature",
    rank_score: 80,
    evidence: { kind: "always-null" },
    verify: "true",
    demo_win: "Demo shows a real value.",
    lesson_class: "always-null-imputed-feature",
  });

  const first = reconcileQueue([card], emptyLedger());
  assert.equal(first.cards.length, 1);
  assert.equal(first.cards[0].reconcile, "new");

  let ledger = updateLedger(emptyLedger(), first.cards, {
    seen_at: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(ledger.schema, LEDGER_SCHEMA);
  assert.equal(ledger.cards[card.id].status, "proposed");

  const second = reconcileQueue([card], ledger);
  assert.equal(second.cards.length, 0, "already-open card must not re-emit");
  assert.ok(second.skipped.some((s) => s.id === card.id));

  // Mark fixed with passing verify → still quiet
  const verified = applyVerifyToLedger(ledger, { [card.id]: true }, {
    seen_at: "1970-01-02T00:00:00.000Z",
  });
  ledger = verified.ledger;
  assert.equal(ledger.cards[card.id].status, "fixed");
  const third = reconcileQueue([card], ledger, {
    verify_results: { [card.id]: true },
  });
  assert.equal(third.cards.length, 0);

  // Regression: verify fails after fixed → re-emit
  const reg = reconcileQueue([card], ledger, {
    verify_results: { [card.id]: false },
  });
  assert.equal(reg.cards.length, 1);
  assert.equal(reg.cards[0].reconcile, "regression");
  assert.ok(reg.regressions.includes(card.id));
});

test("dedupe collapses duplicate ids preferring higher rank_score", () => {
  const a = makeDimensionCard({
    dimension: "coverage",
    slug: "not-ingested-demo",
    title: "Low score",
    rank_score: 10,
    evidence: {},
    verify: "true",
    demo_win: "Covered.",
  });
  const b = { ...a, rank_score: 99, title: "High score" };
  const result = reconcileQueue([a, b], emptyLedger());
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].rank_score, 99);
  assert.equal(result.cards[0].title, "High score");
});

test("extractRecurringLessons and merge are idempotent by class token", () => {
  const cards = [
    makeDimensionCard({
      dimension: "data-integrity",
      slug: "a1",
      title: "A1",
      rank_score: 1,
      evidence: {},
      verify: "true",
      demo_win: "win",
      lesson_class: "always-null-imputed-feature",
    }),
    makeDimensionCard({
      dimension: "data-integrity",
      slug: "a2",
      title: "A2",
      rank_score: 1,
      evidence: {},
      verify: "true",
      demo_win: "win",
      lesson_class: "always-null-imputed-feature",
    }),
    makeDimensionCard({
      dimension: "readability",
      slug: "r1",
      title: "R1",
      rank_score: 1,
      evidence: {},
      verify: "true",
      demo_win: "win",
      lesson_class: "unusable-joined-view",
    }),
  ];
  const lessons = extractRecurringLessons(cards, 2);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].lesson_class, "always-null-imputed-feature");
  assert.equal(lessons[0].count, 2);

  const first = mergeLessonsIntoMarkdown(defaultLessonsHeader(), lessons, {
    date: "2026-08-01",
  });
  assert.deepEqual(first.appended, ["always-null-imputed-feature"]);
  const second = mergeLessonsIntoMarkdown(first.text, lessons, {
    date: "2026-08-01",
  });
  assert.deepEqual(second.appended, []);
  assert.deepEqual(second.skipped, ["always-null-imputed-feature"]);

  const plan = planLessonFileUpdate(null, lessons, { date: "2026-08-01" });
  assert.ok(plan.text.includes("always-null-imputed-feature"));
});

test("CLI flywheel-run emits queue.json and stays quiet on second ledger pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-mf-"));
  const ledgerPath = join(dir, "ledger.json");
  writeFileSync(ledgerPath, `${JSON.stringify(emptyLedger(), null, 2)}\n`);

  const run = (extra = []) =>
    spawnSync(
      process.execPath,
      [
        join(ROOT, "tools/flywheel-run.mjs"),
        "--fixture",
        "--emit",
        dir,
        "--ledger",
        ledgerPath,
        "--update-ledger",
        // High enough that one pass ledgers every candidate (cap must not
        // leave a tail that reappears on the next idempotent run).
        "--limit",
        "200",
        "--generated-at",
        "1970-01-01T00:00:00.000Z",
        ...extra,
      ],
      { encoding: "utf8", cwd: ROOT },
    );

  const first = run();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.ok(existsSync(join(dir, "queue.json")));
  assert.ok(existsSync(join(dir, "cards.jsonl")));
  assert.ok(existsSync(join(dir, "receipt.json")));
  const queue1 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
  assert.equal(queue1.schema, QUEUE_SCHEMA);
  assert.ok(queue1.cards.length >= 1);
  const n1 = queue1.stats.card_count;

  const second = run();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const queue2 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
  // After ledger update, re-run should emit zero (all already proposed/open)
  assert.equal(queue2.stats.card_count, 0, "second run must not re-emit open cards");
  assert.ok(queue2.stats.skipped >= n1);
});
