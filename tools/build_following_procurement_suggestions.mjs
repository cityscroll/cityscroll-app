#!/usr/bin/env node

/* Materialize the complete results-backed starter registry. The procurement
 * browse rows are an input only; they must never become a Worker dependency. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import templates from "../site/data/watch_templates.json" with { type: "json" };
import moneyOpen from "../site/data/money_default_open.json" with { type: "json" };
import rulesOpen from "../site/data/rules_domain_observations.json" with { type: "json" };
import meetingsOpen from "../site/data/meetings_domain_observations.json" with { type: "json" };
import { mergeCanonicalProcurementBrowseRows } from "../site/contract_search_bridge.mjs";
import { buildResultsBackedWatchTemplateRegistry } from "../site/following_suggestions.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const INPUT = resolve(ROOT, "site/data/procurement_browse_rows.json");
const OUTPUT = resolve(ROOT, "site/data/following_procurement_suggestions.json");
import { readProcurementBrowsePopulation } from "./lib/procurement_browse_population_io.mjs";

const source = readProcurementBrowsePopulation(INPUT);
const sources = {
  money: {
    ...moneyOpen,
    notices: mergeCanonicalProcurementBrowseRows(moneyOpen.notices, source.rows),
  },
  rules: rulesOpen,
  meetings: meetingsOpen,
};
const registry = buildResultsBackedWatchTemplateRegistry(templates, sources);
const output = {
  schema: "cityscroll.following_suggestions.v1",
  ...registry,
  generated_at: source.generated_at || null,
  source_model_schema: source.source_model_schema || null,
};
const serialized = `${JSON.stringify(output)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(OUTPUT, "utf8") !== serialized) {
    console.error(`stale Following procurement suggestions: ${OUTPUT}`);
    process.exit(1);
  }
} else {
  writeFileSync(OUTPUT, serialized);
}
console.log(`following suggestions: ${serialized.length} bytes (${registry.templates.length} templates)`);
