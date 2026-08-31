#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const CARD_RECONCILIATION_RECEIPT_SCHEMA = "cityscroll.card-reconciliation-receipt.v1";
export const CARD_RECONCILIATION_KIND = "card-reconciliation";
export const DEFAULT_PROJECTION_PATH = "generated-board";
export const DEFAULT_CARD_RECONCILIATION_RECEIPT = ".artifacts/card-reconciliation-receipt.json";
export const COMMITTED_FIXTURE_DIR = "test/fixtures/card-reconciliation";

export const ISSUE_CLASS = Object.freeze({
  MISSING_SOURCE_CARD: "missing_source_card",
  STALE_PROJECTION: "stale_projection",
  MISMATCHED_PROJECTION: "mismatched_projection",
  MALFORMED_RECEIPT: "malformed_receipt",
  COMPLETE: "complete",
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function valueFrom(row, fields) {
  for (const field of fields) {
    if (row && typeof row[field] === "string" && row[field].trim()) return row[field].trim();
  }
  return null;
}

function rowsFrom(value, fields) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const field of fields) if (Array.isArray(value[field])) return value[field];
  return null;
}

function rowId(row) {
  return valueFrom(row, ["id", "card_id", "source_id", "key", "slug"]);
}

function sourceFingerprint(row) {
  return valueFrom(row, ["fingerprint", "content_hash", "sha256", "source_hash", "updated_at"]);
}

function projectionFingerprint(row) {
  return valueFrom(row, ["source_fingerprint", "source_hash", "fingerprint", "source_updated_at", "updated_at"]);
}

function explicitStatus(row) {
  return valueFrom(row, ["status"]);
}

function snapshot(value) {
  return JSON.stringify(value);
}

function projectionLabel(projection) {
  return projection.path || projection.id || DEFAULT_PROJECTION_PATH;
}

function issue(className, cardId, projection, message) {
  return {
    class: className,
    card_id: cardId || null,
    projection: projection || null,
    message,
  };
}

function indexRows(rows, missingIdFinding, duplicateFinding) {
  const findings = [];
  const issues = [];
  const byId = new Map();
  for (const row of rows) {
    const id = rowId(row);
    if (!id) {
      findings.push(missingIdFinding);
      issues.push(issue(ISSUE_CLASS.MALFORMED_RECEIPT, null, null, missingIdFinding));
      continue;
    }
    if (byId.has(id)) {
      const message = duplicateFinding(id);
      findings.push(message);
      issues.push(issue(ISSUE_CLASS.MALFORMED_RECEIPT, id, null, message));
      continue;
    }
    byId.set(id, row);
  }
  return { byId, findings, issues };
}

function inventoryMembership(projections) {
  const value = valueFrom(projections, ["membership", "card_membership"]);
  if (value === "declared") return "declared";
  return "complete";
}

function declaredProjections({ generatedBoard, projections, projectionPath } = {}) {
  if (projections !== undefined && projections !== null) {
    const rows = rowsFrom(projections, ["projections", "boards", "entries"]);
    if (!rows) return { error: "projection inventory is malformed" };
    return {
      membership: inventoryMembership(projections),
      projections: rows.map((row, index) => {
        const path = valueFrom(row, ["path", "projection_path", "id", "name"]) || `projection-${index + 1}`;
        const id = valueFrom(row, ["id", "name"]) || path;
        const cards = rowsFrom(row, ["cards", "entries", "items"]);
        return { id, path, cards, raw: row };
      }),
    };
  }
  if (generatedBoard !== undefined && generatedBoard !== null) {
    const cards = rowsFrom(generatedBoard, ["cards", "entries", "items"]);
    const path = projectionPath || valueFrom(generatedBoard, ["path", "projection_path"]) || DEFAULT_PROJECTION_PATH;
    const id = valueFrom(generatedBoard, ["id", "name"]) || path;
    return { projections: [{ id, path, cards, raw: generatedBoard }] };
  }
  return { error: "generated projection inventory is missing" };
}

function compareProjection({ sourceById, projection, sourceIssues, membership = "complete" }) {
  const path = projectionLabel(projection);
  const findings = [];
  const issues = [];
  if (!Array.isArray(projection.cards)) {
    const message = `projection ${path} receipt is malformed`;
    findings.push(message);
    issues.push(issue(ISSUE_CLASS.MALFORMED_RECEIPT, null, path, message));
    return {
      id: projection.id,
      path,
      status: "FAIL",
      class: ISSUE_CLASS.MALFORMED_RECEIPT,
      represented_card_ids: [],
      findings,
      issues,
    };
  }

  const indexed = indexRows(
    projection.cards,
    `projection ${path} entry is missing an id`,
    (id) => `duplicate projection entry for card ${id} in ${path}`,
  );
  findings.push(...indexed.findings);
  issues.push(...indexed.issues.map((row) => ({ ...row, projection: path })));

  const represented = [];
  for (const [id, source] of sourceById) {
    const projected = indexed.byId.get(id);
    if (!projected) {
      if (membership === "declared") continue;
      const message = `source card ${id} is missing from projection ${path}`;
      findings.push(message);
      issues.push(issue(ISSUE_CLASS.MISSING_SOURCE_CARD, id, path, message));
      continue;
    }
    represented.push(id);
    const expected = sourceFingerprint(source);
    const actual = projectionFingerprint(projected);
    if (expected && actual && expected !== actual) {
      const message = `generated projection ${path} for card ${id} is stale`;
      findings.push(message);
      issues.push(issue(ISSUE_CLASS.STALE_PROJECTION, id, path, message));
    } else if (expected && !actual) {
      const message = `generated projection ${path} for card ${id} has no source receipt`;
      findings.push(message);
      issues.push(issue(ISSUE_CLASS.STALE_PROJECTION, id, path, message));
    }
    const sourceStatus = explicitStatus(source);
    const projectedStatus = explicitStatus(projected);
    if (sourceStatus && projectedStatus && sourceStatus !== projectedStatus) {
      const message = `generated projection ${path} for card ${id} is mismatched`;
      findings.push(message);
      issues.push(issue(ISSUE_CLASS.MISMATCHED_PROJECTION, id, path, message));
    }
  }
  for (const id of indexed.byId.keys()) {
    if (!sourceById.has(id)) {
      const message = `projection ${path} has no source card: ${id}`;
      findings.push(message);
      issues.push(issue(ISSUE_CLASS.MALFORMED_RECEIPT, id, path, message));
    }
  }

  const uniqueFindings = unique(findings);
  const uniqueIssues = issues.length ? issues : sourceIssues;
  const malformed = uniqueIssues.some((row) => row.class === ISSUE_CLASS.MALFORMED_RECEIPT);
  return {
    id: projection.id,
    path,
    status: uniqueFindings.length ? "FAIL" : "PASS",
    class: uniqueFindings.length
      ? (malformed ? ISSUE_CLASS.MALFORMED_RECEIPT : uniqueIssues[0]?.class || ISSUE_CLASS.MISSING_SOURCE_CARD)
      : ISSUE_CLASS.COMPLETE,
    represented_card_ids: represented,
    findings: uniqueFindings,
    issues: uniqueIssues,
  };
}

export function evaluateCardReconciliation({
  sourceCards,
  generatedBoard,
  projections,
  projectionPath,
} = {}) {
  const before = snapshot({ sourceCards, generatedBoard, projections });
  const findings = [];
  const issues = [];
  const sourceRows = rowsFrom(sourceCards, ["cards", "entries", "items"]);
  if (sourceCards === undefined || sourceCards === null) {
    findings.push("source card inventory is missing");
    issues.push(issue(ISSUE_CLASS.MALFORMED_RECEIPT, null, null, "source card inventory is missing"));
  } else if (!sourceRows) {
    findings.push("source card inventory is malformed");
    issues.push(issue(ISSUE_CLASS.MALFORMED_RECEIPT, null, null, "source card inventory is malformed"));
  }

  const declared = declaredProjections({ generatedBoard, projections, projectionPath });
  if (declared.error) {
    findings.push(declared.error);
    issues.push(issue(ISSUE_CLASS.MALFORMED_RECEIPT, null, null, declared.error));
  }

  let sourceById = new Map();
  if (sourceRows) {
    const indexed = indexRows(
      sourceRows,
      "source card is missing an id",
      (id) => `duplicate source card: ${id}`,
    );
    sourceById = indexed.byId;
    findings.push(...indexed.findings);
    issues.push(...indexed.issues);
  }

  const projectionResults = [];
  const membership = declared.membership || "complete";
  if (Array.isArray(declared.projections)) {
    const seenPaths = new Set();
    for (const projection of declared.projections) {
      const path = projectionLabel(projection);
      if (seenPaths.has(path)) {
        const message = `duplicate declared projection: ${path}`;
        findings.push(message);
        issues.push(issue(ISSUE_CLASS.MALFORMED_RECEIPT, null, path, message));
        continue;
      }
      seenPaths.add(path);
      const result = compareProjection({
        sourceById,
        projection,
        sourceIssues: [],
        membership,
      });
      projectionResults.push(result);
      findings.push(...result.findings);
      issues.push(...result.issues);
    }
    if (membership === "declared" && sourceById.size) {
      const represented = new Set(projectionResults.flatMap((row) => row.represented_card_ids));
      for (const id of sourceById.keys()) {
        if (!represented.has(id)) {
          const message = `source card ${id} is missing from all declared projections`;
          findings.push(message);
          issues.push(issue(ISSUE_CLASS.MISSING_SOURCE_CARD, id, null, message));
        }
      }
    }
  }

  const uniqueFindings = unique(findings);
  const uniqueIssues = issues.filter((row, index, list) => (
    list.findIndex((candidate) => candidate.message === row.message && candidate.card_id === row.card_id && candidate.projection === row.projection) === index
  ));
  const malformed = uniqueIssues.some((row) => row.class === ISSUE_CLASS.MALFORMED_RECEIPT);
  const status = uniqueFindings.length ? "FAIL" : "PASS";
  const resultClass = !uniqueFindings.length
    ? ISSUE_CLASS.COMPLETE
    : (malformed ? ISSUE_CLASS.MALFORMED_RECEIPT : uniqueIssues[0]?.class || ISSUE_CLASS.MISSING_SOURCE_CARD);

  const result = {
    status,
    reason: uniqueFindings[0] || "source cards and generated projections matched",
    findings: uniqueFindings,
    evidence: {
      class: resultClass,
      source_card_count: sourceRows ? sourceRows.length : 0,
      generated_board_count: projectionResults[0]?.represented_card_ids.length
        ?? (Array.isArray(declared.projections?.[0]?.cards) ? declared.projections[0].cards.length : 0),
      projection_count: projectionResults.length,
      projections: Object.fromEntries(projectionResults.map((row) => [row.path, {
        id: row.id,
        path: row.path,
        status: row.status,
        class: row.class,
        represented_card_ids: row.represented_card_ids,
        findings: row.findings,
      }])),
      issues: uniqueIssues,
      mutated_inputs: snapshot({ sourceCards, generatedBoard, projections }) !== before,
    },
  };
  if (result.evidence.mutated_inputs) {
    result.status = "FAIL";
    result.findings = unique(["card reconciliation mutated source or projection inventories", ...result.findings]);
    result.reason = result.findings[0];
  }
  return result;
}

export function buildCardReconciliationReceipt({
  result,
  sourceCommitSha = null,
  observedAt = "2026-08-30T00:00:00.000Z",
} = {}) {
  const evaluation = result || evaluateCardReconciliation();
  return {
    schema: CARD_RECONCILIATION_RECEIPT_SCHEMA,
    kind: CARD_RECONCILIATION_KIND,
    version: 1,
    status: evaluation.status,
    source_commit_sha: sourceCommitSha || null,
    observed_at: observedAt,
    findings: evaluation.findings,
    reason: evaluation.reason,
    evidence: evaluation.evidence,
  };
}

export function writeCardReconciliationReceipt(receipt, receiptPath, { write = false } = {}) {
  const path = resolve(receiptPath);
  if (write) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }
  return receipt;
}

export function loadJson(path) {
  try {
    return { value: JSON.parse(readFileSync(resolve(path), "utf8")), error: null };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { value: null, error: `receipt is missing: ${path}` };
    }
    return { value: null, error: `receipt is malformed: ${path}` };
  }
}

export function evaluateCardReconciliationFromPaths({
  sourceCardsPath,
  projectionsPath,
  generatedBoardPath,
  projectionPath,
} = {}) {
  const findings = [];
  const source = sourceCardsPath ? loadJson(sourceCardsPath) : { value: undefined, error: "source card inventory is missing" };
  if (source.error) findings.push(source.error.startsWith("receipt is missing") ? "source card inventory is missing" : "source card inventory is malformed");
  const projectionFile = projectionsPath || generatedBoardPath;
  const projection = projectionFile
    ? loadJson(projectionFile)
    : { value: undefined, error: "generated projection inventory is missing" };
  if (projection.error) {
    findings.push(projection.error.startsWith("receipt is missing") ? "generated projection inventory is missing" : "projection inventory is malformed");
  }
  if (findings.length && (source.value === null || projection.value === null)) {
    return {
      status: "FAIL",
      reason: findings[0],
      findings,
      evidence: {
        class: ISSUE_CLASS.MALFORMED_RECEIPT,
        source_card_count: 0,
        generated_board_count: 0,
        projection_count: 0,
        projections: {},
        issues: findings.map((message) => issue(ISSUE_CLASS.MALFORMED_RECEIPT, null, null, message)),
        mutated_inputs: false,
      },
    };
  }
  return evaluateCardReconciliation({
    sourceCards: source.value,
    projections: projectionsPath ? projection.value : undefined,
    generatedBoard: generatedBoardPath && !projectionsPath ? projection.value : undefined,
    projectionPath: projectionPath || (generatedBoardPath ? generatedBoardPath.replaceAll("\\", "/") : undefined),
  });
}

export function checkCommittedFixtures({ rootDir = process.cwd(), now = "2026-08-30T00:00:00.000Z" } = {}) {
  const root = resolve(rootDir);
  const fixtures = resolve(root, COMMITTED_FIXTURE_DIR);
  const completeSource = resolve(fixtures, "complete/source-cards.json");
  const completeProjections = resolve(fixtures, "complete/projections.json");
  const missingSource = resolve(fixtures, "missing-card/source-cards.json");
  const missingProjections = resolve(fixtures, "missing-card/projections.json");
  const staleSource = resolve(fixtures, "stale/source-cards.json");
  const staleProjections = resolve(fixtures, "stale/projections.json");
  const malformedSource = resolve(fixtures, "malformed/source-cards.json");
  const malformedProjections = resolve(fixtures, "malformed/projections.json");

  const before = [
    completeSource, completeProjections, missingSource, missingProjections,
    staleSource, staleProjections, malformedSource, malformedProjections,
  ].map((path) => `${path}\n${readFileSync(path, "utf8")}`).join("\n");

  const complete = evaluateCardReconciliationFromPaths({
    sourceCardsPath: completeSource,
    projectionsPath: completeProjections,
  });
  const missing = evaluateCardReconciliationFromPaths({
    sourceCardsPath: missingSource,
    projectionsPath: missingProjections,
  });
  const stale = evaluateCardReconciliationFromPaths({
    sourceCardsPath: staleSource,
    projectionsPath: staleProjections,
  });
  const malformed = evaluateCardReconciliationFromPaths({
    sourceCardsPath: malformedSource,
    projectionsPath: malformedProjections,
  });

  const findings = [];
  if (complete.status !== "PASS") findings.push("complete card reconciliation fixture did not pass");
  if (complete.evidence?.mutated_inputs) findings.push("complete card reconciliation mutated fixture inventories");
  if (missing.status !== "FAIL") findings.push("missing-card fixture did not fail");
  if (!missing.findings.includes("source card rel-05 is missing from projection waves.html")) {
    findings.push("missing-card fixture did not name card rel-05 and projection waves.html");
  }
  const sibling = missing.evidence?.projections?.["data/evidence-plane.json"];
  if (sibling?.status !== "PASS" || !sibling.represented_card_ids.includes("rel-05")) {
    findings.push("missing-card fixture did not preserve the healthy sibling projection");
  }
  if (stale.status !== "FAIL") findings.push("stale projection fixture did not fail");
  if (!stale.findings.includes("generated projection waves.html for card rel-03 is stale")) {
    findings.push("stale projection fixture did not name card rel-03 and projection waves.html");
  }
  if (malformed.status !== "FAIL") findings.push("malformed projection fixture did not fail");
  if (malformed.evidence?.class !== ISSUE_CLASS.MALFORMED_RECEIPT) {
    findings.push("malformed projection fixture did not classify as a malformed receipt");
  }

  const after = [
    completeSource, completeProjections, missingSource, missingProjections,
    staleSource, staleProjections, malformedSource, malformedProjections,
  ].map((path) => `${path}\n${readFileSync(path, "utf8")}`).join("\n");
  if (before !== after) findings.push("card reconciliation --check mutated committed fixtures");

  return {
    status: findings.length ? "FAIL" : "PASS",
    findings,
    reason: findings[0] || "committed card-reconciliation fixtures matched the fail-loud contract",
    observed_at: now,
    fixtures: {
      complete: complete.status,
      missing_card: missing.status,
      stale: stale.status,
      malformed: malformed.status,
    },
  };
}
