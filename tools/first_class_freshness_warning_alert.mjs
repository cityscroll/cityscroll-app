#!/usr/bin/env node
// Names every first-class artifact that has passed its declared warning age
// but has not yet reached its hard maximum, so the owner alert rail can raise
// something before that maximum breaks a production deploy.
//
// The scheduled first-class refresh already retries daily, and a broken
// refresh loop already gets its own issue from tools/first_class_refresh_health.mjs.
// Neither of those is this: a healthy refresh loop can still leave one
// artifact degraded — a slow publisher, a paused acquisition, a dataset that
// simply was not due yet on the day its warning window opened — and until
// this file existed the first thing anyone saw about that was a failed Pages
// deploy once the hard maximum broke it. This reuses the same delivery rail
// served-artifact-freshness.yml already uses (tools/deliver_ops_alert.mjs),
// so the alert reaches the same place, just for a different, earlier cause.
//
// Usage:
//   node tools/first_class_freshness_warning_alert.mjs --write-findings

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = "site/data/first_class_freshness_report.json";
const CONTRACTS_PATH = "site/data/source_contracts.json";
export const WARNING_AGE_FINDINGS_PATH = ".artifacts/first-class-freshness-warning-findings.txt";

/**
 * Recomputed from age against the artifact's own declared warning_age_hours,
 * not read off freshness_state: "degraded" also covers a failed acquisition
 * or a degraded source-health status this run, which already raise their own
 * findings. This is specifically "has this artifact been aging past its
 * warning window", independent of why it might also be degraded today.
 */
export function warningAgeFindings(report, registry) {
  const byId = new Map((registry?.first_class_artifacts || []).map((artifact) => [artifact.id, artifact]));
  return (report?.surfaces || [])
    .filter((surface) => !["stale", "unavailable"].includes(surface.freshness_state))
    .map((surface) => ({ surface, artifact: byId.get(surface.id) }))
    .filter(({ artifact }) => artifact)
    .filter(({ surface, artifact }) => surface.age_hours != null && surface.age_hours > Number(artifact.warning_age_hours))
    .map(({ surface, artifact }) => (
      `${surface.public_artifact_path}: age ${Math.round(surface.age_hours)}h has passed its ${artifact.warning_age_hours}h warning age ` +
      `(hard maximum ${artifact.hard_maximum_age_hours}h; vintage ${surface.source_vintage || "unknown"})`
    ))
    .sort();
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function main(argv) {
  const report = readJson(join(ROOT, REPORT_PATH));
  const registry = readJson(join(ROOT, CONTRACTS_PATH));
  if (!report) throw new Error(`missing ${REPORT_PATH}; run the freshness report before checking for warning-age findings`);
  if (!registry) throw new Error(`missing ${CONTRACTS_PATH}`);
  const findings = warningAgeFindings(report, registry);
  if (argv.includes("--write-findings")) {
    const output = join(ROOT, WARNING_AGE_FINDINGS_PATH);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, findings.length ? `${findings.join("\n")}\n` : "");
    console.log(`wrote ${WARNING_AGE_FINDINGS_PATH}: ${findings.length} finding(s)`);
  } else {
    for (const finding of findings) console.log(finding);
    console.log(`${findings.length} finding(s)`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
