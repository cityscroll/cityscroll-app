#!/usr/bin/env node
// Derive the evaluated-agency fixture from live evaluation run receipts.
//
// Live evaluation runs against the deployed research service recorded which
// organizations a reader's questions named and how the four organization read
// surfaces answered. The committed test asserts against those organizations, so
// the set has to come from the runs rather than from a list retyped in the test:
// when the evaluation set changes, this regenerates the fixture and the test
// moves with it.
//
// The receipts live outside this repository and are not published here. Pass
// them explicitly:
//
//   node tools/build_evaluated_agency_fixture.mjs <receipt.json> [more.json ...]
//   node tools/build_evaluated_agency_fixture.mjs --check <receipt.json> ...

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = "test/fixtures/agency_entity_publication/evaluated_agencies.json";
const CROSSWALK = "worker/src/data/agency_crosswalk.json";

/** The four read surfaces a reader uses to ask about an organization. */
export const EVALUATED_CAPABILITIES = Object.freeze([
  "get_entity_dossier",
  "get_entity_relationships",
  "browse_organizations",
  "get_person_or_organization",
]);

const ENTITY_ID_PATTERN = /agency:id:[a-z0-9][a-z0-9-]*/g;

function collect(receipt) {
  const text = JSON.stringify(receipt);
  const entityIds = [...new Set(text.match(ENTITY_ID_PATTERN) || [])].sort();
  const observed = {};
  for (const task of Array.isArray(receipt?.tasks) ? receipt.tasks : []) {
    for (const call of Array.isArray(task?.gateway_calls) ? task.gateway_calls : []) {
      if (!EVALUATED_CAPABILITIES.includes(call?.capability)) continue;
      const seen = observed[call.capability] || new Set();
      seen.add(String(call.availability || "unknown"));
      observed[call.capability] = seen;
    }
  }
  return {
    entityIds,
    observed: Object.fromEntries(Object.entries(observed)
      .map(([capability, values]) => [capability, [...values].sort()])),
  };
}

function mergeObserved(runs) {
  const merged = {};
  for (const capability of EVALUATED_CAPABILITIES) {
    const values = new Set();
    for (const run of runs) for (const value of run.observed[capability] || []) values.add(value);
    if (values.size) merged[capability] = [...values].sort();
  }
  return merged;
}

async function main() {
  const check = process.argv.includes("--check");
  const receiptPaths = process.argv.slice(2).filter((argument) => argument !== "--check");
  if (!receiptPaths.length) throw new Error("pass at least one evaluation run receipt path");

  const crosswalk = JSON.parse(await readFile(path.join(ROOT, CROSSWALK), "utf8"));
  const runs = [];
  for (const receiptPath of receiptPaths) {
    runs.push(collect(JSON.parse(await readFile(receiptPath, "utf8"))));
  }
  const entityIds = [...new Set(runs.flatMap((run) => run.entityIds))].sort();
  if (!entityIds.length) throw new Error("no organization identifiers appear in these receipts");

  const agencies = entityIds.map((entityId) => {
    const agencyId = entityId.replace(/^agency:id:/, "");
    const entry = crosswalk?.entries?.[agencyId];
    if (!entry?.canonical_name) throw new Error(`no identity crosswalk row for ${entityId}`);
    return { entity_id: entityId, agency_id: agencyId, name: entry.canonical_name };
  });

  // A control identifier that no crosswalk row claims, so the honest-absence
  // assertion has something genuinely outside the published set to ask about.
  const uncovered = "agency:id:not-a-published-agency";
  if (crosswalk?.entries?.[uncovered.replace(/^agency:id:/, "")]) {
    throw new Error("the uncovered control identifier now names a published agency");
  }

  const fixture = {
    schema: "cityscroll.evaluated_agency_fixture.v1",
    note: "Organizations named by questions in live evaluation runs of the deployed research service, with the availabilities those runs recorded for the four organization read surfaces. Regenerate with tools/build_evaluated_agency_fixture.mjs when the evaluation set changes.",
    evaluated_capabilities: [...EVALUATED_CAPABILITIES],
    run_count: runs.length,
    agencies,
    uncovered_entity_id: uncovered,
    observed_before_publication: mergeObserved(runs),
  };
  const serialized = `${JSON.stringify(fixture, null, 2)}\n`;

  if (check) {
    if (await readFile(path.join(ROOT, FIXTURE), "utf8") !== serialized) {
      throw new Error("stale evaluated-agency fixture");
    }
    console.log(`evaluated-agency fixture ok agencies=${agencies.length}`);
    return;
  }
  await writeFile(path.join(ROOT, FIXTURE), serialized);
  console.log(JSON.stringify({ fixture: FIXTURE, agencies: agencies.map((agency) => agency.entity_id) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
