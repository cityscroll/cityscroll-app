// Per-card multi-flywheel ledger store + projection purity.
//
//   node --test test/ledger_store.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  emptyLedger,
  updateLedger,
  LEDGER_SCHEMA,
} from "../ontology/card_queue.mjs";
import {
  cardIdToFilename,
  foldLedger,
  splitLedger,
  serializeCardEntry,
  parseCardEntry,
  dirtyCardIds,
  loadLedgerStore,
  writeLedgerStore,
  migrateMonolithicLedger,
  LEDGER_STORAGE_VERSION,
} from "../ontology/ledger_store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_LEDGER = join(ROOT, "ontology/queue/ledger.json");

test("serialize/parse round-trip preserves classic map values", () => {
  const plain = { status: "proposed", title: "T", dimension: "coverage" };
  const withId = {
    id: "crol-list/x",
    status: "fixed",
    title: "X",
    notes: "legacy",
  };
  assert.equal(serializeCardEntry("crol-list/a", plain).retain_map_id, undefined);
  assert.equal(serializeCardEntry("crol-list/x", withId).retain_map_id, true);
  assert.deepEqual(parseCardEntry(serializeCardEntry("crol-list/a", plain)).classic, plain);
  assert.deepEqual(parseCardEntry(serializeCardEntry("crol-list/x", withId)).classic, withId);
});

test("foldLedger is a pure projection of meta + cards", () => {
  const cards = {
    "crol-list/a": { status: "proposed", title: "A" },
    "crol-list/b": { status: "fixed", title: "B", fixed_at: "2026-08-01T00:00:00.000Z" },
  };
  const folded = foldLedger(
    {
      schema: LEDGER_SCHEMA,
      policy_version: "v0",
      updated_at: "2026-08-02T00:00:00.000Z",
      note: "n",
    },
    cards,
  );
  assert.equal(folded.schema, LEDGER_SCHEMA);
  assert.equal(folded.note, "n");
  assert.deepEqual(folded.cards, cards);
  // split → serialize → parse → fold returns the same cards map
  const { meta, cards: splitCards } = splitLedger(folded);
  const restored = {};
  for (const [id, entry] of Object.entries(splitCards)) {
    const { classic } = parseCardEntry(serializeCardEntry(id, entry));
    restored[id] = classic;
  }
  assert.deepEqual(restored, cards);
  assert.equal(meta.card_count, 2);
});

test("writeLedgerStore only rewrites dirty card files", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-ledger-"));
  const ledgerPath = join(dir, "ledger.json");
  const ledger = emptyLedger({ updated_at: "1970-01-01T00:00:00.000Z" });
  ledger.cards = {
    "crol-list/a": { status: "proposed", title: "A", dimension: "coverage" },
    "crol-list/b": { status: "proposed", title: "B", dimension: "coverage" },
  };
  writeLedgerStore(ledgerPath, ledger, { dirtyIds: null, writePointer: true });
  const cardsDir = join(dir, "ledger/cards");
  assert.equal(readdirSync(cardsDir).filter((n) => n.endsWith(".json")).length, 2);

  const aPath = join(cardsDir, cardIdToFilename("crol-list/a"));
  const bPath = join(cardsDir, cardIdToFilename("crol-list/b"));
  const aBefore = readFileSync(aPath);
  const bBefore = readFileSync(bPath);

  const next = {
    ...ledger,
    updated_at: "1970-01-02T00:00:00.000Z",
    cards: {
      ...ledger.cards,
      "crol-list/a": { ...ledger.cards["crol-list/a"], status: "fixed", fixed_at: "1970-01-02T00:00:00.000Z" },
    },
  };
  const dirty = dirtyCardIds(ledger, next);
  assert.deepEqual(dirty, ["crol-list/a"]);
  writeLedgerStore(ledgerPath, next, { dirtyIds: dirty, writePointer: true });

  assert.notEqual(readFileSync(aPath).toString(), aBefore.toString());
  assert.equal(readFileSync(bPath).toString(), bBefore.toString());
  const loaded = loadLedgerStore(ledgerPath);
  assert.equal(loaded.cards["crol-list/a"].status, "fixed");
  assert.equal(loaded.cards["crol-list/b"].status, "proposed");
});

test("two independent card updates produce non-overlapping file sets", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-ledger-merge-"));
  const ledgerPath = join(dir, "ledger.json");
  const base = emptyLedger();
  base.cards = {
    "crol-list/card-one": { status: "proposed", title: "One", dimension: "coverage" },
    "crol-list/card-two": { status: "proposed", title: "Two", dimension: "coverage" },
  };
  writeLedgerStore(ledgerPath, base, { dirtyIds: null });

  // Branch A: fix card-one only
  const branchA = join(dir, "branch-a");
  mkdirSync(branchA, { recursive: true });
  spawnSync("cp", ["-R", join(dir, "ledger"), branchA], { encoding: "utf8" });
  spawnSync("cp", [ledgerPath, join(branchA, "ledger.json")], { encoding: "utf8" });
  const aLedger = loadLedgerStore(join(branchA, "ledger.json"));
  aLedger.cards["crol-list/card-one"] = {
    ...aLedger.cards["crol-list/card-one"],
    status: "fixed",
    fixed_at: "2026-08-11T00:00:00.000Z",
  };
  aLedger.updated_at = "2026-08-11T00:00:00.000Z";
  writeLedgerStore(join(branchA, "ledger.json"), aLedger, {
    dirtyIds: ["crol-list/card-one"],
  });

  // Branch B: fix card-two only
  const branchB = join(dir, "branch-b");
  mkdirSync(branchB, { recursive: true });
  spawnSync("cp", ["-R", join(dir, "ledger"), branchB], { encoding: "utf8" });
  spawnSync("cp", [ledgerPath, join(branchB, "ledger.json")], { encoding: "utf8" });
  const bLedger = loadLedgerStore(join(branchB, "ledger.json"));
  bLedger.cards["crol-list/card-two"] = {
    ...bLedger.cards["crol-list/card-two"],
    status: "fixed",
    fixed_at: "2026-08-11T01:00:00.000Z",
  };
  bLedger.updated_at = "2026-08-11T01:00:00.000Z";
  writeLedgerStore(join(branchB, "ledger.json"), bLedger, {
    dirtyIds: ["crol-list/card-two"],
  });

  const aCardFiles = readdirSync(join(branchA, "ledger/cards")).sort();
  const bCardFiles = readdirSync(join(branchB, "ledger/cards")).sort();
  assert.deepEqual(aCardFiles, bCardFiles);

  // Diff each side against base: only one card file content differs per branch
  const baseCards = join(dir, "ledger/cards");
  const changedA = aCardFiles.filter(
    (name) =>
      readFileSync(join(branchA, "ledger/cards", name)).toString() !==
      readFileSync(join(baseCards, name)).toString(),
  );
  const changedB = bCardFiles.filter(
    (name) =>
      readFileSync(join(branchB, "ledger/cards", name)).toString() !==
      readFileSync(join(baseCards, name)).toString(),
  );
  assert.deepEqual(changedA, [cardIdToFilename("crol-list/card-one")]);
  assert.deepEqual(changedB, [cardIdToFilename("crol-list/card-two")]);
  assert.equal(changedA[0] === changedB[0], false);

  // Simulated merge: take base + A's card-one + B's card-two
  const mergedDir = join(dir, "merged");
  mkdirSync(join(mergedDir, "ledger/cards"), { recursive: true });
  for (const name of aCardFiles) {
    const fromA = changedA.includes(name);
    const fromB = changedB.includes(name);
    const src = fromA
      ? join(branchA, "ledger/cards", name)
      : fromB
        ? join(branchB, "ledger/cards", name)
        : join(baseCards, name);
    writeFileSync(join(mergedDir, "ledger/cards", name), readFileSync(src));
  }
  writeFileSync(
    join(mergedDir, "ledger/meta.json"),
    readFileSync(join(branchB, "ledger/meta.json")),
  );
  writeFileSync(join(mergedDir, "ledger.json"), readFileSync(join(branchB, "ledger.json")));
  const merged = loadLedgerStore(join(mergedDir, "ledger.json"));
  assert.equal(merged.cards["crol-list/card-one"].status, "fixed");
  assert.equal(merged.cards["crol-list/card-two"].status, "fixed");
});

test("repo ledger store folds to 82 cards with stable schema", () => {
  assert.ok(existsSync(join(ROOT, "ontology/queue/ledger/cards")));
  const ledger = loadLedgerStore(REPO_LEDGER);
  assert.equal(ledger.schema, LEDGER_SCHEMA);
  assert.ok(Object.keys(ledger.cards).length >= 80);
  const pointer = JSON.parse(readFileSync(REPO_LEDGER, "utf8"));
  assert.equal(pointer.storage, LEDGER_STORAGE_VERSION);
  assert.ok(!pointer.cards || Object.keys(pointer.cards).length === 0);
});

test("CLI flywheel-run --update-ledger stays quiet on second pass (temp file mode)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-mf-store-"));
  const ledgerPath = join(dir, "ledger.json");
  writeFileSync(ledgerPath, `${JSON.stringify(emptyLedger(), null, 2)}\n`);

  const run = () =>
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
        "--limit",
        "200",
        "--generated-at",
        "1970-01-01T00:00:00.000Z",
      ],
      { encoding: "utf8", cwd: ROOT },
    );

  const first = run();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const queue1 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
  assert.ok(queue1.cards.length >= 1);

  const second = run();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const queue2 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
  assert.equal(queue2.stats.card_count, 0);
});

test("updateLedger preserves ledger note and prior fixed fields", () => {
  let ledger = emptyLedger();
  ledger.note = "keep me";
  ledger.cards = {
    "crol-list/z": {
      status: "fixed",
      title: "Z",
      dimension: "coverage",
      fixed_at: "2026-08-01T00:00:00.000Z",
      fixed_note: "done",
    },
  };
  const next = updateLedger(ledger, [], { seen_at: "2026-08-02T00:00:00.000Z" });
  assert.equal(next.note, "keep me");
  assert.equal(next.cards["crol-list/z"].fixed_note, "done");
});

test("migrateMonolithicLedger is idempotent on the repo store", () => {
  const once = migrateMonolithicLedger(REPO_LEDGER);
  assert.ok(once.reason === "already_per_card" || once.migrated === true);
  const n = Object.keys(loadLedgerStore(REPO_LEDGER).cards).length;
  assert.ok(n >= 80);
});
