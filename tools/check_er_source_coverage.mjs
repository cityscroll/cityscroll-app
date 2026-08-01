#!/usr/bin/env node
// Honesty gate for entity-resolution source observation coverage.
//
// Adapter readiness (flag + fixture + schema) is not production coverage.
// dual_write.after must reflect live source_records row counts: a stream with
// 0 rows must not report "complete".

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  emitCoverageHonestyCards,
  validateSourceCoverageMatrix,
} from "../entity_resolution/evaluation/source_coverage_honesty.mjs";

function fail(message) {
  console.error(`ER source coverage FAILED: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {
    matrix: null,
    emitBugs: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--matrix") args.matrix = argv[++i];
    else if (arg === "--emit-bugs") args.emitBugs = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else {
      fail(`unknown argument: ${arg}`);
      return args;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage:
  node tools/check_er_source_coverage.mjs --matrix <path> [--emit-bugs] [--json]

Validates the ER source coverage inventory against live row-count honesty rules.
A dual_write.after of "complete" with live_observation.row_count === 0 fails.
Optional --emit-bugs prints multi-flywheel-shaped cards for empty/stale/partial streams.`);
  process.exit(0);
}

if (!args.matrix) {
  fail("provide --matrix <path>");
} else {
  const matrixPath = resolve(args.matrix);
  if (!existsSync(matrixPath)) {
    fail(`matrix does not exist: ${matrixPath}`);
  } else {
    const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
    const rows = Array.isArray(matrix.sources) ? matrix.sources : [];

    // Filesystem checks the pure validator does not own.
    for (const row of rows) {
      const importerPath = row.importer?.split("#", 1)[0];
      if (importerPath && !existsSync(resolve(importerPath))) {
        fail(`${row.id}: importer does not exist: ${importerPath}`);
      }
      if (row.fixture && !existsSync(resolve(row.fixture))) {
        fail(`${row.id}: fixture does not exist: ${row.fixture}`);
      }
      if (row.observation_schema && !existsSync(resolve(row.observation_schema))) {
        fail(`${row.id}: observation schema does not exist`);
      }
      if (row.replay_test && !existsSync(resolve(row.replay_test))) {
        fail(`${row.id}: replay test does not exist`);
      }
    }

    const result = validateSourceCoverageMatrix(matrix);
    for (const error of result.errors) fail(error);
    for (const warning of result.warnings) {
      console.warn(`ER source coverage WARN: ${warning}`);
    }

    if (!process.exitCode) {
      const m = result.measurement;
      const after = m.after;
      const by = m.by_status;
      console.log(
        `ER source coverage OK — live ${after.covered}/${after.total} complete `
        + `(rate ${after.rate}); by_status complete=${by.complete} partial=${by.partial} `
        + `stale=${by.stale} empty-declared-live=${by["empty-declared-live"]} gap=${by.gap}; `
        + `adapter_ready ${m.adapter_ready.after}/${m.adapter_ready.total}`,
      );
    }

    if (args.emitBugs) {
      const cards = emitCoverageHonestyCards(matrix);
      if (args.json) {
        console.log(JSON.stringify({ cards, count: cards.length }, null, 2));
      } else {
        console.log(`Coverage honesty cards: ${cards.length}`);
        for (const card of cards) {
          console.log(`- [${card.evidence?.kind}] ${card.id}: ${card.title}`);
        }
      }
    } else if (args.json && !process.exitCode) {
      console.log(JSON.stringify({
        ok: true,
        measurement: result.measurement,
        honesty_cards: emitCoverageHonestyCards(matrix).map((c) => c.id),
      }, null, 2));
    }
  }
}
