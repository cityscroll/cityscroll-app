#!/usr/bin/env node
/**
 * Apply tools/merge_queue_policy.json to the repository ruleset that owns the
 * main merge queue. Requires `gh` auth with admin on the repo.
 *
 * Usage:
 *   node tools/apply_merge_queue_policy.mjs           # apply
 *   node tools/apply_merge_queue_policy.mjs --check   # compare only (exit 1 if drift)
 *   node tools/apply_merge_queue_policy.mjs --dry-run # print planned body
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const POLICY_PATH = path.join(ROOT, "tools", "merge_queue_policy.json");
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const dryRun = args.has("--dry-run");

function ghJson(argv) {
  const r = spawnSync("gh", argv, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`gh ${argv.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

function ghPut(argv, body) {
  const r = spawnSync("gh", argv, {
    encoding: "utf8",
    input: JSON.stringify(body),
  });
  if (r.status !== 0) {
    throw new Error(`gh ${argv.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
const repo = policy.repository;
const rulesetId = policy.ruleset_id;

const current = ghJson([
  "api",
  `repos/${repo}/rulesets/${rulesetId}`,
]);

const mqRule = (current.rules || []).find((r) => r.type === "merge_queue");
const scRule = (current.rules || []).find((r) => r.type === "required_status_checks");
if (!mqRule || !scRule) {
  throw new Error("ruleset missing merge_queue or required_status_checks rule");
}

const desiredMq = policy.merge_queue;
const desiredChecks = policy.required_status_checks;

function mqEqual(a, b) {
  return (
    a.merge_method === b.merge_method &&
    a.grouping_strategy === b.grouping_strategy &&
    a.max_entries_to_build === b.max_entries_to_build &&
    a.min_entries_to_merge === b.min_entries_to_merge &&
    a.max_entries_to_merge === b.max_entries_to_merge &&
    a.min_entries_to_merge_wait_minutes === b.min_entries_to_merge_wait_minutes &&
    a.check_response_timeout_minutes === b.check_response_timeout_minutes
  );
}

const currentChecks = (scRule.parameters.required_status_checks || []).map(
  (c) => c.context,
);
const checksEqual =
  currentChecks.length === desiredChecks.length &&
  desiredChecks.every((c) => currentChecks.includes(c));

const inSync = mqEqual(mqRule.parameters, desiredMq) && checksEqual;

if (checkOnly) {
  if (inSync) {
    console.log("merge queue policy: in sync with tools/merge_queue_policy.json");
    process.exit(0);
  }
  console.error("merge queue policy: DRIFT");
  console.error("  current merge_queue:", JSON.stringify(mqRule.parameters));
  console.error("  desired merge_queue:", JSON.stringify(desiredMq));
  console.error("  current checks:", currentChecks.join(" | "));
  console.error("  desired checks:", desiredChecks.join(" | "));
  process.exit(1);
}

const body = {
  name: current.name,
  target: current.target,
  enforcement: current.enforcement,
  conditions: current.conditions,
  bypass_actors: current.bypass_actors || [],
  rules: [
    {
      type: "merge_queue",
      parameters: { ...desiredMq },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy:
          scRule.parameters.strict_required_status_checks_policy ?? false,
        do_not_enforce_on_create:
          scRule.parameters.do_not_enforce_on_create ?? false,
        required_status_checks: desiredChecks.map((context) => ({ context })),
      },
    },
  ],
};

if (dryRun) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

if (inSync) {
  console.log("merge queue policy already applied; nothing to do");
  process.exit(0);
}

ghPut(
  [
    "api",
    "--method",
    "PUT",
    `repos/${repo}/rulesets/${rulesetId}`,
    "--input",
    "-",
  ],
  body,
);
console.log(
  `Applied merge queue policy: min_entries_to_merge_wait_minutes=${desiredMq.min_entries_to_merge_wait_minutes}`,
);
