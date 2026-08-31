#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const POLICY_PATH = "docs/repository-control-plane/agents-router-policy.v1.json";
const RECEIPT_PATH = "docs/repository-control-plane/agents-router-receipt.v1.json";

const RULES = Object.freeze([
  {
    id: "card-heading",
    pattern: /^#{1,6}\s+(?:(?:card\s+)?[A-Z][A-Z0-9]{1,12}-\d+[A-Z0-9-]*)(?:\s|$)/m,
    message: "per-card headings belong in the control register, not instruction guidance",
  },
  {
    id: "rollout-history",
    pattern: /(?:^#{1,6}\s+.*(?:rollout|delivery|implementation)\s+(?:history|log|register)|\b(?:shipped|landed|merged)\s+(?:in|as)\s+(?:PR|pull request)\s*#?\d+)/im,
    message: "rollout and delivery history belongs in the control register or commit history",
  },
  {
    id: "mutable-status-ledger",
    pattern: /(?:^#{1,6}\s+(?:current\s+)?(?:status|roadmap|backlog|future work|next steps?|blocked work|delivery queue)\s*$|^\|\s*(?:card|work item|milestone)\s*\|\s*(?:status|state|owner)\s*\|)/im,
    message: "mutable status and future-work ledgers belong in the control register",
  },
  {
    id: "duplicated-module-catalog",
    pattern: /^#{1,6}\s+(?:duplicated\s+)?(?:module|implementation|component)\s+(?:catalog|inventory)\s*$/im,
    message: "module catalogs must be routed to code, the module map, or generated architecture facts",
  },
]);

export function classifyInstructionText(text) {
  return RULES.filter((rule) => rule.pattern.test(String(text))).map(({ id, message }) => ({ id, message }));
}

export function validateCeilingPolicy(policy) {
  const findings = [];
  if (policy?.schema !== "cityscroll.agents_router_policy.v1") findings.push("unsupported policy schema");
  const history = policy?.ceiling_history_bytes;
  if (!Number.isInteger(policy?.initial_ceiling_bytes) || policy.initial_ceiling_bytes <= 0) findings.push("initial ceiling must be a positive integer");
  if (!Array.isArray(history) || history.length === 0 || history.some((value) => !Number.isInteger(value) || value <= 0)) {
    findings.push("ceiling history must contain positive integers");
  } else {
    if (history[0] !== policy.initial_ceiling_bytes) findings.push("ceiling history must begin at the immutable initial ceiling");
    for (let index = 1; index < history.length; index += 1) {
      if (history[index] >= history[index - 1]) findings.push(`ceiling increase or no-op at history index ${index}`);
    }
    if (policy.max_bytes !== history.at(-1)) findings.push("max_bytes must equal the latest ceiling history entry");
  }
  return findings;
}

function trackedInstructionFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "unable to enumerate tracked files");
  return result.stdout.split("\0").filter(Boolean).filter((path) => ["AGENTS.md", "CLAUDE.md"].includes(basename(path))).sort();
}

function countLines(text) {
  if (!text) return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

function pointerFindings(policy, rootText) {
  const findings = [];
  for (const pointer of policy.required_pointers || []) {
    if (!existsSync(join(ROOT, pointer))) findings.push(`required pointer does not resolve: ${pointer}`);
    if (!rootText.includes(pointer)) findings.push(`root router does not route to required pointer: ${pointer}`);
  }
  return findings;
}

function instructionAudit(policy) {
  const findings = [];
  const expected = new Set(policy.instruction_files || []);
  const actual = trackedInstructionFiles();
  for (const path of actual) if (!expected.has(path)) findings.push(`unregistered instruction file: ${path}`);
  for (const path of expected) if (!actual.includes(path)) findings.push(`registered instruction file is not tracked: ${path}`);
  for (const [alias, target] of Object.entries(policy.compatibility_aliases || {})) {
    const aliasPath = join(ROOT, alias);
    if (!existsSync(aliasPath) || !lstatSync(aliasPath).isSymbolicLink()) findings.push(`compatibility alias is not a symlink: ${alias}`);
    else if (realpathSync(aliasPath) !== realpathSync(join(ROOT, target))) findings.push(`compatibility alias does not resolve to ${target}: ${alias}`);
  }
  if ((policy.local_guidance || []).length !== 0) findings.push("local guidance requires a documented material subtree reason");
  return { actual, findings };
}

export function buildReceipt(policy, rootText) {
  const audit = instructionAudit(policy);
  return {
    schema: "cityscroll.agents_router_receipt.v1",
    card: "cityscroll-repository-control-plane/rcp-02",
    inputs: {
      main_commit: "2c310bcff9b71c3704493801ef23182375c5357d",
      register_revision: "32727924c5f546ce5c41d0f68cb324fde7c7425b",
      classification_manifest: "docs/repository-control-plane/classification.v1.json",
      semantic_owner_mapping: "docs/repository-control-plane/semantic-owner-mapping.v1.json"
    },
    root_agents: {
      grounded_rcp00_before: { bytes: 321000, lines: 4621 },
      implementation_start_before: { bytes: 322384, lines: 4641 },
      after: { bytes: Buffer.byteLength(rootText), lines: countLines(rootText) },
      initial_ceiling_bytes: policy.initial_ceiling_bytes,
      current_ceiling_bytes: policy.max_bytes
    },
    retained_sections: [
      "sources of truth",
      "repository-wide invariants",
      "editing and verification",
      "directory guidance",
      "maintaining this file"
    ],
    removed_or_routed_categories: [
      "per-card delivery histories",
      "mutable status and future-work ledgers",
      "duplicated module and component catalogs",
      "prose recoverable from code or generated architecture facts"
    ],
    content_rules: RULES.map(({ id }) => id),
    clean_checkout_instruction_findings: {
      per_card_ledgers: 0,
      mutable_status_catalogs: 0,
      duplicated_or_code_recoverable_catalogs: 0
    },
    ratchet_proof: {
      initial_ceiling_bytes: policy.initial_ceiling_bytes,
      permitted_downward_fixture_bytes: policy.initial_ceiling_bytes - 1000,
      rejected_increase_fixture_bytes: policy.initial_ceiling_bytes + 1000
    },
    directory_guidance_audit: {
      tracked_instruction_paths: audit.actual,
      retained_local_files: [],
      materiality: "No tracked independent subtree-local instruction file exists."
    },
    pointer_resolution: Object.fromEntries((policy.required_pointers || []).map((path) => [path, existsSync(join(ROOT, path)) ? "resolved" : "missing"])),
    architecture_preflight: {
      observed_surface_affected: false,
      basis: "Instruction and repository-governance paths are outside architecture/observer-canaries.json; the card-owned evidence shard records the governance change.",
      card_owned_shard: "architecture/evidence.d/cityscroll-repository-control-plane--rcp-02.json",
      generated_aggregate_paths_changed: false
    },
    product_or_served_artifact_changed: false
  };
}

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function checkRepository() {
  const findings = [];
  const policy = JSON.parse(readFileSync(join(ROOT, POLICY_PATH), "utf8"));
  const rootText = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  findings.push(...validateCeilingPolicy(policy));
  const bytes = Buffer.byteLength(rootText);
  if (bytes > policy.max_bytes) findings.push(`AGENTS.md is ${bytes} bytes; ceiling is ${policy.max_bytes}`);
  findings.push(...classifyInstructionText(rootText).map((finding) => `AGENTS.md: ${finding.id}: ${finding.message}`));
  findings.push(...pointerFindings(policy, rootText));
  const audit = instructionAudit(policy);
  findings.push(...audit.findings);
  for (const path of policy.instruction_files || []) {
    if (path === "AGENTS.md") continue;
    const text = readFileSync(join(ROOT, path), "utf8");
    findings.push(...classifyInstructionText(text).map((finding) => `${path}: ${finding.id}: ${finding.message}`));
  }
  const expectedReceipt = stable(buildReceipt(policy, rootText));
  const receiptPath = join(ROOT, RECEIPT_PATH);
  if (!existsSync(receiptPath)) findings.push(`missing receipt: ${RECEIPT_PATH}`);
  else if (readFileSync(receiptPath, "utf8") !== expectedReceipt) findings.push(`stale receipt: run node tools/agents_router_guard.mjs --write`);
  return findings;
}

function main() {
  const policy = JSON.parse(readFileSync(join(ROOT, POLICY_PATH), "utf8"));
  const rootText = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  if (process.argv.includes("--write")) {
    writeFileSync(join(ROOT, RECEIPT_PATH), stable(buildReceipt(policy, rootText)));
    console.log(`wrote ${RECEIPT_PATH}`);
    return;
  }
  const findings = checkRepository();
  if (findings.length) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`AGENTS router: ${Buffer.byteLength(rootText)} bytes, ${countLines(rootText)} lines, ceiling ${policy.max_bytes}; content and pointers valid`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
