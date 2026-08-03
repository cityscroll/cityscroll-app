#!/usr/bin/env node
/**
 * Run the ontology-coherence census over fixture (default) or a JSON inventory.
 *
 *   node tools/audit_ontology_coherence.mjs
 *   node tools/audit_ontology_coherence.mjs --inventory path.json
 *   node tools/audit_ontology_coherence.mjs --json
 *
 * Exit 0 always for measurement; use --check to fail when any violation exists.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditOntologyCoherence,
  evaluateOntologyCoherence,
  COHERENCE_RULES,
} from "../ontology/dimensions/ontology_coherence.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const check = args.includes("--check");
const invIdx = args.indexOf("--inventory");
const invPath =
  invIdx >= 0
    ? args[invIdx + 1]
    : join(ROOT, "ontology/fixtures/dimensions/ontology_coherence_payloads.json");

if (!existsSync(invPath)) {
  console.error(`inventory not found: ${invPath}`);
  process.exit(2);
}

const inventory = JSON.parse(readFileSync(invPath, "utf8"));
const census = auditOntologyCoherence(inventory, { today: inventory.today || null });
const evalResult = evaluateOntologyCoherence({ ontology_coherence: inventory });

if (asJson) {
  console.log(
    JSON.stringify(
      {
        census: {
          schema: census.schema,
          today: census.today,
          checked: census.checked,
          violation_count: census.violation_count,
          by_rule: census.by_rule,
          land_class: census.land_class,
          violations: census.violations,
        },
        flywheel_cards: evalResult.cards.map((c) => ({
          id: c.id,
          title: c.title,
          hit_count: c.evidence?.hit_count,
        })),
        rules: COHERENCE_RULES.map((r) => r.id),
      },
      null,
      2,
    ),
  );
} else {
  console.log(`ontology-coherence census  today=${census.today || "—"}`);
  console.log(
    `  checked land=${census.checked.land} exam=${census.checked.exam} total=${census.checked.total}`,
  );
  console.log(`  violations=${census.violation_count}`);
  console.log(
    `  land_class past_deadline_current=${census.land_class.past_deadline_current} later_completed_while_current=${census.land_class.later_completed_while_current}`,
  );
  for (const [rule, n] of Object.entries(census.by_rule)) {
    if (n) console.log(`  rule ${rule}: ${n}`);
  }
  for (const v of census.violations.slice(0, 20)) {
    console.log(
      `  - ${v.rule_id} ${v.permalink || v.subject_ref} ${JSON.stringify(v.detail).slice(0, 120)}`,
    );
  }
  if (census.violations.length > 20) {
    console.log(`  … ${census.violations.length - 20} more`);
  }
  console.log(`  flywheel cards: ${evalResult.cards.length}`);
}

if (check && census.violation_count > 0) {
  process.exit(1);
}
