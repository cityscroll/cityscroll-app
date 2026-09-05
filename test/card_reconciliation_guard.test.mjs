import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CARD_RECONCILIATION_KIND,
  CARD_RECONCILIATION_RECEIPT_SCHEMA,
  ISSUE_CLASS,
  buildCardReconciliationReceipt,
  checkCommittedFixtures,
  evaluateCardReconciliation,
  writeCardReconciliationReceipt,
} from "../tools/card_reconciliation_guard.mjs";
import { reconcileCardProjection } from "../tools/release_surface_reconciliation.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const NOW = "2026-08-30T00:00:00.000Z";
const FIXTURE = "test/fixtures/card-reconciliation";

function fixture(relative) {
  return JSON.parse(readFileSync(new URL(`../${FIXTURE}/${relative}`, import.meta.url), "utf8"));
}

function fixtureText(relative) {
  return readFileSync(new URL(`../${FIXTURE}/${relative}`, import.meta.url), "utf8");
}

function digest(relative) {
  return createHash("sha256").update(fixtureText(relative)).digest("hex");
}

test("declared membership keeps disjoint card projections complete without requiring every card on every path", () => {
  const result = evaluateCardReconciliation({
    sourceCards: {
      schema: "cityscroll.card-inventory.v1",
      cards: [
        { id: "card-a", status: "implemented", fingerprint: "a.v1" },
        { id: "card-b", status: "implemented", fingerprint: "b.v1" },
      ],
    },
    projections: {
      schema: "cityscroll.card-projection-inventory.v1",
      membership: "declared",
      projections: [
        {
          id: "surface-a",
          path: "site/data/a.json",
          cards: [{ id: "card-a", status: "implemented", source_fingerprint: "a.v1" }],
        },
        {
          id: "surface-b",
          path: "site/data/b.json",
          cards: [{ id: "card-b", status: "implemented", source_fingerprint: "b.v1" }],
        },
      ],
    },
  });
  assert.equal(result.status, "PASS", result.findings.join("; "));
});

test("an omitted card fails with the card id and declared projection path", () => {
  const sourceCards = fixture("missing-card/source-cards.json");
  const projections = fixture("missing-card/projections.json");
  const before = JSON.stringify({ sourceCards, projections });
  const result = evaluateCardReconciliation({ sourceCards, projections });
  assert.equal(result.status, "FAIL");
  assert.ok(result.findings.includes("source card rel-05 is missing from projection waves.html"));
  assert.equal(result.evidence.class, ISSUE_CLASS.MISSING_SOURCE_CARD);
  assert.ok(result.evidence.issues.some((row) => (
    row.class === ISSUE_CLASS.MISSING_SOURCE_CARD
    && row.card_id === "rel-05"
    && row.projection === "waves.html"
  )));
  assert.equal(JSON.stringify({ sourceCards, projections }), before);
});

test("a stale projection fails with the card id and projection path while siblings stay represented", () => {
  const result = evaluateCardReconciliation({
    sourceCards: fixture("stale/source-cards.json"),
    projections: fixture("stale/projections.json"),
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.findings.includes("generated projection waves.html for card rel-03 is stale"));
  assert.deepEqual(result.evidence.projections["waves.html"].represented_card_ids, ["rel-03", "rel-05"]);
  assert.equal(result.evidence.class, ISSUE_CLASS.STALE_PROJECTION);
});

test("a missing-card fixture keeps unrelated evidence on the healthy sibling projection", () => {
  const result = evaluateCardReconciliation({
    sourceCards: fixture("missing-card/source-cards.json"),
    projections: fixture("missing-card/projections.json"),
  });
  const board = result.evidence.projections["waves.html"];
  const sibling = result.evidence.projections["data/evidence-plane.json"];
  assert.equal(result.status, "FAIL");
  assert.equal(board.status, "FAIL");
  assert.deepEqual(board.represented_card_ids, ["rel-03", "rel-07"]);
  assert.equal(sibling.status, "PASS");
  assert.deepEqual(sibling.represented_card_ids, ["rel-03", "rel-05", "rel-07"]);
  assert.equal(sibling.class, ISSUE_CLASS.COMPLETE);
});

test("complete reconciliation passes without rewriting status semantics", () => {
  const sourceCards = fixture("complete/source-cards.json");
  const projections = fixture("complete/projections.json");
  const before = JSON.stringify({ sourceCards, projections });
  const result = evaluateCardReconciliation({ sourceCards, projections });
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.findings, []);
  assert.equal(result.evidence.class, ISSUE_CLASS.COMPLETE);
  assert.equal(result.evidence.mutated_inputs, false);
  assert.equal(sourceCards.cards[0].status, "implemented");
  assert.equal(projections.projections[0].cards[0].status, "implemented");
  assert.equal(JSON.stringify({ sourceCards, projections }), before);
});

test("malformed projection inventory is distinct from a missing card", () => {
  const missing = evaluateCardReconciliation({
    sourceCards: fixture("missing-card/source-cards.json"),
    projections: fixture("missing-card/projections.json"),
  });
  const malformed = evaluateCardReconciliation({
    sourceCards: fixture("malformed/source-cards.json"),
    projections: fixture("malformed/projections.json"),
  });
  assert.equal(missing.evidence.class, ISSUE_CLASS.MISSING_SOURCE_CARD);
  assert.equal(malformed.status, "FAIL");
  assert.equal(malformed.evidence.class, ISSUE_CLASS.MALFORMED_RECEIPT);
  assert.ok(malformed.findings.includes("projection inventory is malformed"));
});

test("ambiguous duplicate identities fail closed", () => {
  const result = evaluateCardReconciliation({
    sourceCards: { cards: [{ id: "rel-03", updated_at: "2026-08-27T10:00:00Z" }, { id: "rel-03", updated_at: "2026-08-27T11:00:00Z" }] },
    generatedBoard: { cards: [{ id: "rel-03", source_updated_at: "2026-08-27T10:00:00Z" }] },
    projectionPath: "waves.html",
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.findings.includes("duplicate source card: rel-03"));
  assert.equal(result.evidence.class, ISSUE_CLASS.MALFORMED_RECEIPT);
});

test("status mismatch names the card and projection without selecting a new status", () => {
  const sourceCards = { cards: [{ id: "rel-03", status: "proposed", updated_at: "2026-08-27T10:00:00Z" }] };
  const generatedBoard = { cards: [{ id: "rel-03", status: "implemented", source_updated_at: "2026-08-27T10:00:00Z" }] };
  const before = JSON.stringify({ sourceCards, generatedBoard });
  const result = evaluateCardReconciliation({
    sourceCards,
    generatedBoard,
    projectionPath: "waves.html",
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.findings.includes("generated projection waves.html for card rel-03 is mismatched"));
  assert.equal(sourceCards.cards[0].status, "proposed");
  assert.equal(generatedBoard.cards[0].status, "implemented");
  assert.equal(JSON.stringify({ sourceCards, generatedBoard }), before);
});

test("the aggregate wrapper stays unknown when no inventories are supplied", () => {
  const result = reconcileCardProjection();
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.findings, ["source card inventory is missing"]);
});

test("CLI missing-card injection writes a receipt and returns nonzero", async () => {
  await withTempDir("card-reconciliation", async (directory) => {
    const output = join(directory, "receipt.json");
    const result = spawnSync(process.execPath, [
      "tools/check_card_reconciliation.mjs",
      "--source-cards", `${FIXTURE}/missing-card/source-cards.json`,
      "--projections", `${FIXTURE}/missing-card/projections.json`,
      "--output", output,
      "--observed-at", NOW,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    const receipt = JSON.parse(await readFile(output, "utf8"));
    assert.equal(receipt.schema, CARD_RECONCILIATION_RECEIPT_SCHEMA);
    assert.equal(receipt.kind, CARD_RECONCILIATION_KIND);
    assert.equal(receipt.status, "FAIL");
    assert.ok(receipt.findings.includes("source card rel-05 is missing from projection waves.html"));
    assert.equal(receipt.evidence.projections["data/evidence-plane.json"].status, "PASS");
  });
});

test("complete CLI run writes a passing receipt and leaves fixture bytes unchanged", async () => {
  const before = {
    source: digest("complete/source-cards.json"),
    projections: digest("complete/projections.json"),
  };
  await withTempDir("card-reconciliation-pass", async (directory) => {
    const output = join(directory, "receipt.json");
    const result = spawnSync(process.execPath, [
      "tools/check_card_reconciliation.mjs",
      "--source-cards", `${FIXTURE}/complete/source-cards.json`,
      "--projections", `${FIXTURE}/complete/projections.json`,
      "--output", output,
      "--observed-at", NOW,
      "--source-commit", "a".repeat(40),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(await readFile(output, "utf8"));
    assert.equal(receipt.status, "PASS");
    assert.equal(receipt.source_commit_sha, "a".repeat(40));
    assert.equal(digest("complete/source-cards.json"), before.source);
    assert.equal(digest("complete/projections.json"), before.projections);
  });
});

test("committed fixture --check proves the fail-loud contract without writing a tree receipt", () => {
  const before = [
    "complete/source-cards.json",
    "complete/projections.json",
    "missing-card/source-cards.json",
    "missing-card/projections.json",
    "stale/source-cards.json",
    "stale/projections.json",
    "malformed/source-cards.json",
    "malformed/projections.json",
  ].map((relative) => digest(relative));
  const contract = checkCommittedFixtures({ now: NOW });
  assert.equal(contract.status, "PASS", contract.findings.join("; "));
  const cli = spawnSync(process.execPath, [
    "tools/check_card_reconciliation.mjs",
    "--check",
    "--observed-at", NOW,
  ], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const after = [
    "complete/source-cards.json",
    "complete/projections.json",
    "missing-card/source-cards.json",
    "missing-card/projections.json",
    "stale/source-cards.json",
    "stale/projections.json",
    "malformed/source-cards.json",
    "malformed/projections.json",
  ].map((relative) => digest(relative));
  assert.deepEqual(after, before);
});

test("durable receipts retain exact mismatch findings", async () => {
  await withTempDir("card-reconciliation-receipt", async (directory) => {
    const path = join(directory, "receipt.json");
    const result = evaluateCardReconciliation({
      sourceCards: fixture("missing-card/source-cards.json"),
      projections: fixture("missing-card/projections.json"),
    });
    const receipt = buildCardReconciliationReceipt({ result, observedAt: NOW });
    writeCardReconciliationReceipt(receipt, path, { write: true });
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.schema, CARD_RECONCILIATION_RECEIPT_SCHEMA);
    assert.match(persisted.findings[0], /rel-05/);
    assert.match(persisted.findings[0], /waves\.html/);
  });
});
