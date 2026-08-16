#!/usr/bin/env node

import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dependencyCruiserConfig from "../.dependency-cruiser.mjs";
import { buildFacts } from "./build_architecture_facts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".venv", ".venv-playwright"]);
const MODEL_PATH = join(ROOT, "architecture", "workspace.dsl");

function walkFiles(root, current = root, files = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, files);
    else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      files.push(relative(root, full).split("\\").join("/"));
    }
  }
  return files.sort();
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function importsFrom(source) {
  const clean = stripComments(source);
  const imports = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) imports.add(match[1]);
  }
  return [...imports].sort();
}

function resolveInternalImport(from, specifier, root) {
  if (!specifier.startsWith(".")) return null;
  const base = normalize(join(dirname(from), specifier)).split("\\").join("/");
  const candidates = [
    base,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.cjs`,
    `${base}/index.mjs`,
    `${base}/index.js`,
  ];
  for (const candidate of candidates) {
    if (existsSync(join(root, candidate))) return candidate;
  }
  return base;
}

function buildImportGraph(root = ROOT) {
  const files = walkFiles(root);
  const edges = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    for (const specifier of importsFrom(source)) {
      const target = resolveInternalImport(file, specifier, root);
      if (target) edges.push({ from: file, to: target });
    }
  }
  return edges;
}

function ruleMatches(rulePart, value) {
  if (!rulePart) return true;
  if (rulePart.path) return new RegExp(rulePart.path).test(value);
  if (rulePart.pathNot) return !new RegExp(rulePart.pathNot).test(value);
  return false;
}

export function evaluateDependencyRules(edges, rules = dependencyCruiserConfig.forbidden) {
  const violations = [];
  for (const edge of edges) {
    for (const rule of rules) {
      if (!ruleMatches(rule.from, edge.from) || !ruleMatches(rule.to, edge.to)) continue;
      violations.push({
        rule: rule.name,
        severity: rule.severity || "error",
        comment: rule.comment || "",
        source: edge.from,
        target: edge.to,
      });
    }
  }
  return violations;
}

export function parseC4Model(source) {
  const elements = [];
  const relationships = [];
  for (const [index, line] of source.split("\n").entries()) {
    const element = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(person|softwareSystem|container)\s+"([^"]+)"(?:\s+"([^"]+)")?/);
    if (element) {
      elements.push({ id: element[1], type: element[2], name: element[3], description: element[4] || "", line: index + 1 });
    }
    const relationship = line.match(/^\s*([A-Za-z_][\w]*)\s*->\s*([A-Za-z_][\w]*)\s+"([^"]+)"/);
    if (relationship) {
      relationships.push({ from: relationship[1], to: relationship[2], description: relationship[3], line: index + 1 });
    }
  }
  return { elements, relationships };
}

function hasPath(facts, prefix) {
  return (facts.source_paths || []).some((path) => path === prefix || path.startsWith(`${prefix}/`));
}

function productionBindings(facts) {
  return facts.bindings?.environments?.production || {};
}

function factContainerEvidence(facts) {
  const bindings = productionBindings(facts);
  const queues = bindings.queues || {};
  return {
    browser_site: hasPath(facts, "site"),
    worker_api: hasPath(facts, "worker") && Boolean(facts.routes && facts.bindings && facts.crons),
    warehouse_factory: hasPath(facts, "warehouse") && Boolean(facts.warehouse?.engines?.length),
    materialization_tools: hasPath(facts, "tools"),
    entity_resolution: Boolean(facts.entity_resolution?.package?.exists) && facts.entity_resolution.module_count > 0,
    ontology_registry: facts.ontology?.registry?.schema === "cityscroll.ontology.registry.v0",
    d1_notices: Array.isArray(bindings.d1_databases) && bindings.d1_databases.some((item) => item.binding === "DB"),
    kv_nl_meter: Array.isArray(bindings.kv_namespaces) && bindings.kv_namespaces.some((item) => item.binding === "NL_METER"),
    kv_alert_state: Array.isArray(bindings.kv_namespaces) && bindings.kv_namespaces.some((item) => item.binding === "ALERT_STATE"),
    kv_subs: Array.isArray(bindings.kv_namespaces) && bindings.kv_namespaces.some((item) => item.binding === "SUBS"),
    kv_feedback: Array.isArray(bindings.kv_namespaces) && bindings.kv_namespaces.some((item) => item.binding === "FEEDBACK"),
    digest_queue: Array.isArray(queues.producers) && queues.producers.some((item) => item.binding === "DIGEST_QUEUE") &&
      Array.isArray(queues.consumers) && queues.consumers.some((item) => item.queue === "crol-digests"),
    analytics_engine: Array.isArray(bindings.analytics_engine_datasets) && bindings.analytics_engine_datasets.some((item) => item.binding === "USAGE_ANALYTICS"),
    r2_source_vault: Array.isArray(bindings.r2_buckets) && bindings.r2_buckets.length > 0,
  };
}

function sourceRootSet(facts) {
  return new Set((facts.source_paths || []).map((path) => path.split("/")[0]));
}

export function checkDeclaredModelDrift({ facts, modelText }) {
  const model = parseC4Model(modelText);
  const containers = model.elements.filter((element) => element.type === "container");
  const declared = new Set(containers.map((container) => container.id));
  const inactive = new Set(containers
    .filter((container) => /inactive|disabled|planned/i.test(`${container.name} ${container.description}`))
    .map((container) => container.id));
  const evidence = factContainerEvidence(facts);
  const observed = new Set(Object.entries(evidence).filter(([, present]) => present).map(([id]) => id));
  const knownRoots = new Set(["entity_resolution", "ontology", "site", "tools", "warehouse", "worker"]);
  const additions = [...sourceRootSet(facts)]
    .filter((root) => root !== "test" && !knownRoots.has(root))
    .map((root) => `source-root:${root}`);
  additions.push(...[...observed].filter((id) => !declared.has(id)));
  const removals = containers
    .filter((container) => !inactive.has(container.id) && !observed.has(container.id))
    .map((container) => container.id);
  const contradictions = [];
  for (const id of inactive) {
    if (observed.has(id)) contradictions.push(`${id}: model marks this container inactive but generated facts show an active binding`);
  }
  if (declared.has("worker_api") && !facts.routes?.config) {
    contradictions.push("worker_api: C4 declares a Worker runtime but generated facts have no route configuration");
  }
  if (declared.has("entity_resolution") && facts.entity_resolution?.package?.exists !== true) {
    contradictions.push("entity_resolution: C4 declares the package but generated facts mark its package absent");
  }
  return {
    additions: [...new Set(additions)].sort(),
    removals: [...new Set(removals)].sort(),
    contradictions: [...new Set(contradictions)].sort(),
    model,
    observed: [...observed].sort(),
  };
}

function formatViolations(violations) {
  return violations.map((violation) =>
    `architecture fitness violation: rule=${violation.rule} severity=${violation.severity} source=${violation.source} target=${violation.target}`,
  );
}

function formatDrift(report) {
  const lines = [];
  for (const category of ["additions", "removals", "contradictions"]) {
    if (report[category].length) {
      lines.push(`declared-model drift ${category}:`);
      lines.push(...report[category].map((item) => `  - ${item}`));
    }
  }
  return lines;
}

export function runArchitectureFitness({ root = ROOT, facts = buildFacts(), modelPath = MODEL_PATH } = {}) {
  const edges = buildImportGraph(root);
  const violations = evaluateDependencyRules(edges);
  const errors = violations.filter((violation) => violation.severity === "error");
  const warnings = violations.filter((violation) => violation.severity !== "error");
  if (warnings.length) console.warn(formatViolations(warnings).join("\n"));
  if (errors.length) throw new Error(formatViolations(errors).join("\n"));

  if (!existsSync(modelPath)) {
    throw new Error(`declared-model drift input missing: model=${modelPath}`);
  }
  const report = checkDeclaredModelDrift({
    facts,
    modelText: readFileSync(modelPath, "utf8"),
  });
  const drift = formatDrift(report);
  if (drift.length) throw new Error(drift.join("\n"));
  console.log(`architecture fitness ok: ${edges.length} import edges; declared model has ${report.model.elements.length} elements`);
  return { edges, violations, report };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runArchitectureFitness();
