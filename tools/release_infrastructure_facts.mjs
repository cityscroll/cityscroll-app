#!/usr/bin/env node

/**
 * Derive the release and runtime-infrastructure facts this repository actually
 * configures, and check the owned reference document against them.
 *
 * Every fact here comes from a committed configuration file — the Worker deploy
 * workflow (YAML), the Wrangler configuration (TOML), and the provider-neutral
 * build contract (JSON). Nothing is read from prose, and nothing is inferred
 * about a provider dashboard: a setting that lives only in a Cloudflare account
 * is reported as unverified, never as observed.
 *
 * Usage:
 *   node tools/release_infrastructure_facts.mjs            # print the derived facts
 *   node tools/release_infrastructure_facts.mjs --check    # also verify the owned reference
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const WORKER_DEPLOY_WORKFLOW = ".github/workflows/deploy-worker.yml";
export const PAGES_DEPLOY_WORKFLOW = ".github/workflows/deploy-cloudflare-pages.yml";
export const WRANGLER_CONFIG = "worker/wrangler.toml";
export const RELEASE_CONTRACT = "docs/release/cloudflare-native-builds.json";
export const RELEASE_REFERENCE = "docs/release/cloudflare-native-builds.md";

/** Documents that must route to the owned reference rather than restate it. */
export const ROUTED_SUMMARIES = [
  "ARCHITECTURE.md",
  "docs/architecture.md",
  "worker/README.md",
];

const BINDING_SECTIONS = new Map([
  ["d1_databases", "D1 database"],
  ["kv_namespaces", "KV namespace"],
  ["r2_buckets", "R2 bucket"],
  ["analytics_engine_datasets", "Analytics Engine dataset"],
  ["queues.producers", "Queue producer"],
  ["queues.consumers", "Queue consumer"],
]);

function readText(rootDir, path) {
  return readFileSync(resolve(rootDir, path), "utf8");
}

function numberedLines(text) {
  return text.split("\n").map((raw, index) => ({ raw, line: index + 1 }));
}

/**
 * Split a TOML line into its declaration text and whether the declaration is
 * commented out. A commented declaration is a statement of intent, never a
 * configured resource.
 */
function tomlDeclaration(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("#")) return { text: trimmed, commented: false };
  return { text: trimmed.replace(/^#+\s?/, "").trim(), commented: true };
}

function scalar(text) {
  const match = text.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
  if (!match) return null;
  const raw = match[2];
  const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return { key: match[1], value };
}

/**
 * Parse the Wrangler configuration into cron triggers, plain vars, and one row
 * per binding declaration with an explicit configured/commented-out state.
 */
export function parseWranglerConfig(text) {
  const crons = [];
  const vars = {};
  const bindings = [];
  let section = null;
  let sectionCommented = false;
  let sectionLine = 0;
  let inCrons = false;
  let pending = null;

  const flushPending = () => {
    if (!pending) return;
    bindings.push(pending);
    pending = null;
  };

  for (const { raw, line } of numberedLines(text)) {
    const { text: declaration, commented } = tomlDeclaration(raw);
    if (!declaration) continue;
    const table = declaration.match(/^\[+([^\]]+)\]+$/);
    if (table) {
      flushPending();
      section = table[1];
      sectionCommented = commented;
      sectionLine = line;
      inCrons = false;
      if (BINDING_SECTIONS.has(section)) {
        pending = {
          section,
          kind: BINDING_SECTIONS.get(section),
          binding: null,
          resource: null,
          state: commented ? "commented_out" : "configured",
          line: sectionLine,
        };
      }
      continue;
    }
    if (section === "triggers") {
      if (declaration.startsWith("crons")) inCrons = true;
      if (inCrons) {
        for (const match of declaration.matchAll(/"([^"]+)"/g)) {
          crons.push({ schedule: match[1], line });
        }
        if (declaration.includes("]")) inCrons = false;
      }
      continue;
    }
    const field = scalar(declaration);
    if (!field) continue;
    if (section === "vars" && !commented) {
      vars[field.key] = field.value;
      continue;
    }
    if (!pending || pending.section !== section) continue;
    if (field.key === "binding") {
      pending.binding = field.value;
      if (commented && !sectionCommented) pending.state = "commented_out";
    }
    if (["database_name", "dataset", "queue", "bucket_name", "id"].includes(field.key)) {
      pending.resource = pending.resource ?? field.value;
    }
  }
  flushPending();

  return { crons, vars, bindings };
}

/**
 * A binding counts as active only when its declaration is configured (not
 * commented out) and no `<NAME>_ENABLED` var turns it off.
 */
export function classifyBindings({ bindings, vars }) {
  return bindings.map((binding) => {
    const gateKey = binding.binding ? `${binding.binding}_ENABLED` : null;
    const gate = gateKey && Object.hasOwn(vars, gateKey)
      ? { key: gateKey, value: vars[gateKey] }
      : null;
    const gateDisables = gate ? gate.value !== "true" : false;
    return {
      ...binding,
      // A queue consumer is a subscription rather than a named binding, so it is
      // identified by its section and queue instead of a binding name.
      name: binding.binding ?? `${binding.section}:${binding.resource}`,
      gate,
      active: binding.state === "configured" && !gateDisables,
    };
  });
}

/** Extract the `on:` mapping of a workflow without a YAML dependency. */
function workflowTriggerBlock(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start < 0) return [];
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

/**
 * Classify a workflow's triggers. `automatic_on_push` and `manual_dispatch` are
 * independent: a workflow with both is automatic AND manually re-runnable, and
 * is never a manual-only fallback.
 */
export function parseWorkflowTriggers(text) {
  const block = workflowTriggerBlock(text);
  const events = [];
  let current = null;
  let inBranches = false;
  let inPaths = false;
  for (const line of block) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const event = trimmed.match(/^([a-z_]+):\s*$/);
    if (event && indent <= 2) {
      current = { event: event[1], branches: [], paths: [] };
      events.push(current);
      inBranches = false;
      inPaths = false;
      continue;
    }
    if (!current) continue;
    const inline = trimmed.match(/^branches:\s*\[([^\]]*)\]\s*$/);
    if (inline) {
      current.branches.push(...inline[1].split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
      inBranches = false;
      inPaths = false;
      continue;
    }
    if (/^branches:\s*$/.test(trimmed)) {
      inBranches = true;
      inPaths = false;
      continue;
    }
    if (/^paths:\s*$/.test(trimmed)) {
      inPaths = true;
      inBranches = false;
      continue;
    }
    const item = trimmed.match(/^-\s*["']?([^"'\s][^"']*?)["']?\s*$/);
    if (item && inBranches) {
      current.branches.push(item[1]);
      continue;
    }
    if (item && inPaths) {
      current.paths.push(item[1]);
      continue;
    }
    if (!item && /:/.test(trimmed) && indent <= 4) {
      inBranches = false;
      inPaths = false;
    }
  }
  const push = events.find((entry) => entry.event === "push") || null;
  const dispatch = events.find((entry) => entry.event === "workflow_dispatch") || null;
  const schedule = events.find((entry) => entry.event === "schedule") || null;
  const classifications = [];
  if (push && push.branches.includes("main")) classifications.push("automatic_on_push");
  if (dispatch) classifications.push("manual_dispatch");
  if (schedule) classifications.push("scheduled");
  return {
    events: events.map((entry) => entry.event),
    classifications,
    manual_only: classifications.length === 1 && classifications[0] === "manual_dispatch",
    push_branches: push ? push.branches : [],
    push_paths: push ? push.paths : [],
    has_workflow_dispatch: Boolean(dispatch),
  };
}

export function buildReleaseInfrastructureFacts({ rootDir = ROOT } = {}) {
  const workerWorkflow = parseWorkflowTriggers(readText(rootDir, WORKER_DEPLOY_WORKFLOW));
  const pagesWorkflow = parseWorkflowTriggers(readText(rootDir, PAGES_DEPLOY_WORKFLOW));
  const wrangler = parseWranglerConfig(readText(rootDir, WRANGLER_CONFIG));
  const bindings = classifyBindings(wrangler);
  const contract = JSON.parse(readText(rootDir, RELEASE_CONTRACT));
  return {
    schema: "cityscroll.release-infrastructure-facts.v1",
    pipelines: {
      "cloudflare-pages": { workflow: PAGES_DEPLOY_WORKFLOW, ...pagesWorkflow },
      "cloudflare-worker": { workflow: WORKER_DEPLOY_WORKFLOW, ...workerWorkflow },
    },
    crons: wrangler.crons,
    bindings,
    vars: wrangler.vars,
    contract,
    externally_observed: {
      // Nothing in this repository can read a provider dashboard. Every setting
      // below is declared here and unverified until a read-only configuration or
      // deployment receipt is committed.
      worker_native_builds_connection: contract.worker?.native_builds_connection ?? null,
      pages_native_git_integration: contract.pages?.native_git_integration_required === false
        ? "not_required"
        : "declared",
    },
  };
}

function tableRows(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return null;
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows;
}

const PIPELINE_HEADING = "Release pipelines";
const CRON_HEADING = "Configured Worker cron triggers";
const BINDING_HEADING = "Configured Worker bindings";

export function verifyReleaseInfrastructureDocumentation({ rootDir = ROOT } = {}) {
  const facts = buildReleaseInfrastructureFacts({ rootDir });
  const reference = readText(rootDir, RELEASE_REFERENCE);
  const findings = [];

  const worker = facts.pipelines["cloudflare-worker"];
  if (!worker.classifications.includes("automatic_on_push")) {
    findings.push(`${WORKER_DEPLOY_WORKFLOW} no longer deploys on a main push`);
  }
  if (!worker.has_workflow_dispatch) {
    findings.push(`${WORKER_DEPLOY_WORKFLOW} no longer keeps a manual trigger`);
  }
  if (worker.manual_only) {
    findings.push(`${WORKER_DEPLOY_WORKFLOW} is classified manual-only, which the committed triggers contradict`);
  }
  if (facts.contract.worker?.manual_fallback_workflow) {
    findings.push(`${RELEASE_CONTRACT} still classifies the Worker workflow as a manual fallback`);
  }
  if (facts.contract.worker?.automatic_deploy_workflow !== WORKER_DEPLOY_WORKFLOW) {
    findings.push(`${RELEASE_CONTRACT} must name ${WORKER_DEPLOY_WORKFLOW} as the automatic Worker deploy workflow`);
  }
  if (facts.contract.worker?.native_builds_connection !== "unverified") {
    findings.push(`${RELEASE_CONTRACT} must record the native Workers Builds connection as unverified until a receipt proves it`);
  }
  const retiredClaims = /manual,? non-required fallback|Workers Builds (?:remains|is) the canonical|manual-only (?:fallback|workflow|classification)/i;
  if (retiredClaims.test(reference)) {
    findings.push(`${RELEASE_REFERENCE} still carries a retired manual-fallback or canonical-Workers-Builds claim`);
  }

  const pipelineRows = tableRows(reference, PIPELINE_HEADING);
  if (!pipelineRows) {
    findings.push(`${RELEASE_REFERENCE} is missing the "${PIPELINE_HEADING}" table`);
  } else {
    for (const boundary of facts.contract.required_production_boundaries ?? []) {
      const pipeline = facts.pipelines[boundary.id];
      const row = pipelineRows.find((cells) => cells[0].includes(`\`${boundary.pipeline}\``));
      if (!pipeline) {
        findings.push(`${RELEASE_CONTRACT} declares boundary ${boundary.id} with no derived workflow`);
        continue;
      }
      if (!row) {
        findings.push(`${RELEASE_REFERENCE} has no release-pipeline row for ${boundary.pipeline}`);
        continue;
      }
      const automatic = row[1] ?? "";
      const manual = row[2] ?? "";
      if (pipeline.classifications.includes("automatic_on_push")) {
        if (!/`push`/.test(automatic) || !/`main`/.test(automatic)) {
          findings.push(`${RELEASE_REFERENCE} does not classify ${boundary.pipeline} as deploying on a \`main\` push`);
        }
      } else if (!/^none\b/i.test(automatic.trim())) {
        findings.push(`${RELEASE_REFERENCE} claims an automatic trigger for ${boundary.pipeline} that the workflow does not configure`);
      }
      if (pipeline.has_workflow_dispatch) {
        if (!/`workflow_dispatch`/.test(manual)) {
          findings.push(`${RELEASE_REFERENCE} does not record the \`workflow_dispatch\` trigger for ${boundary.pipeline}`);
        }
      } else if (!/^none\b/i.test(manual.trim())) {
        findings.push(`${RELEASE_REFERENCE} claims a manual trigger for ${boundary.pipeline} that the workflow does not configure`);
      }
    }
  }

  const cronRows = tableRows(reference, CRON_HEADING);
  if (!cronRows) {
    findings.push(`${RELEASE_REFERENCE} is missing the "${CRON_HEADING}" table`);
  } else {
    const documented = cronRows.map((cells) => (cells[0].match(/`([^`]+)`/) || [])[1]).filter(Boolean);
    const configured = facts.crons.map((entry) => entry.schedule);
    if (documented.join("|") !== configured.join("|")) {
      findings.push(`${RELEASE_REFERENCE} documents crons [${documented.join(", ")}] but ${WRANGLER_CONFIG} configures [${configured.join(", ")}]`);
    }
    for (const cells of cronRows) {
      if (!cells[1]) findings.push(`${RELEASE_REFERENCE} cron row ${cells[0]} has no responsibility`);
    }
  }

  const bindingRows = tableRows(reference, BINDING_HEADING);
  if (!bindingRows) {
    findings.push(`${RELEASE_REFERENCE} is missing the "${BINDING_HEADING}" table`);
  } else {
    const documented = new Map();
    for (const cells of bindingRows) {
      const name = (cells[0].match(/`([^`]+)`/) || [])[1];
      if (!name) continue;
      documented.set(name, /^active\b/i.test(cells[2] || ""));
    }
    for (const binding of facts.bindings) {
      if (!documented.has(binding.name)) {
        findings.push(`${RELEASE_REFERENCE} does not list binding ${binding.name}`);
        continue;
      }
      if (documented.get(binding.name) !== binding.active) {
        findings.push(`${RELEASE_REFERENCE} states ${binding.name} is ${documented.get(binding.name) ? "active" : "inactive"} but ${WRANGLER_CONFIG} makes it ${binding.active ? "active" : "inactive"}`);
      }
    }
    for (const name of documented.keys()) {
      if (!facts.bindings.some((binding) => binding.name === name)) {
        findings.push(`${RELEASE_REFERENCE} lists binding ${name}, which ${WRANGLER_CONFIG} does not declare`);
      }
    }
  }

  for (const path of ROUTED_SUMMARIES) {
    if (!readText(rootDir, path).includes(RELEASE_REFERENCE)) {
      findings.push(`${path} does not route its release and infrastructure summary to ${RELEASE_REFERENCE}`);
    }
  }

  return {
    schema: "cityscroll.release-infrastructure-reconciliation.v1",
    status: findings.length ? "FAIL" : "PASS",
    findings,
    facts,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.includes("--check");
  const report = check
    ? verifyReleaseInfrastructureDocumentation()
    : { schema: "cityscroll.release-infrastructure-facts.v1", facts: buildReleaseInfrastructureFacts() };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (check && report.status !== "PASS") process.exitCode = 1;
}
