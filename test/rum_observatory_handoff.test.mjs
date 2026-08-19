import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  checkDocumentationLinks,
  loadHandoffProcedures,
  runHandoffCheck,
  runProcedure,
} from "../tools/rum_observatory_handoff.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const inventory = loadHandoffProcedures({ root: ROOT });

test("handoff procedures cover registry extension, operations, and deferred governance", () => {
  assert.equal(inventory.schema, "cityscroll.rum.observatory_handoff.v1");
  assert.deepEqual(inventory.procedures.map((entry) => entry.id), [
    "new-instrumentation",
    "query-troubleshooting",
    "desk-contract",
    "privacy-audit",
    "rollback",
    "deferred-governance",
  ]);
  for (const entry of inventory.procedures) {
    assert.equal(existsSync(join(ROOT, entry.fixture)), true, entry.fixture);
  }
});

test("documentation links in the handoff resolve, with the rum-14 protocol optional", () => {
  const docPath = join(ROOT, inventory.handoff_doc);
  const markdown = readFileSync(docPath, "utf8");
  const optional = inventory.operator_protocol?.optional
    ? [inventory.operator_protocol.path]
    : [];
  assert.deepEqual(checkDocumentationLinks(markdown, docPath, {
    root: ROOT,
    optionalPaths: optional,
  }), []);
  for (const heading of inventory.procedures.map((entry) => `## ${entry.heading}`)) {
    assert.match(markdown, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(markdown, /forbidden_key/);
  assert.match(markdown, /RUM_INGEST_ENABLED/);
  assert.match(markdown, /production_enabled/);
  assert.match(markdown, /90-day/);
  assert.doesNotMatch(markdown, /PR-fail-on-percentile would now/);
});

test("every fixture-backed procedure passes against committed commands", async () => {
  for (const entry of inventory.procedures) {
    const errors = await runProcedure(entry.id, { root: ROOT });
    assert.deepEqual(errors, [], entry.id);
  }
});

test("the combined link checker and procedure runner is green", async () => {
  assert.deepEqual(await runHandoffCheck({ root: ROOT }), []);
});
