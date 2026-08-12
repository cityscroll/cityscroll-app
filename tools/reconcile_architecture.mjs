#!/usr/bin/env node

/**
 * Reconcile generated architecture evidence with the human-owned C4 model.
 *
 * This tool is deliberately a proposal generator. It can identify a state
 * mismatch, but it cannot know why a design changed. Every proposed semantic
 * change therefore carries a null rationale and the literal status
 * "rationale required" for human adjudication.
 */
import { buildFacts } from "./build_architecture_facts.mjs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FACTS_PATH = join(ROOT, "architecture", "generated", "facts.json");
const MODEL_PATH = join(ROOT, "architecture", "workspace.dsl");
const ADR_DIR = join(ROOT, "docs", "adr");
const RECEIPT_PATH = join(ROOT, "architecture", "generated", "reconciliation.json");

const RESOURCE_TARGETS = [
  { modelId: "d1_notices", section: "d1_databases", binding: "DB" },
  { modelId: "kv_nl_meter", section: "kv_namespaces", binding: "NL_METER" },
  { modelId: "kv_alert_state", section: "kv_namespaces", binding: "ALERT_STATE" },
  { modelId: "kv_subs", section: "kv_namespaces", binding: "SUBS" },
  { modelId: "kv_feedback", section: "kv_namespaces", binding: "FEEDBACK" },
  { modelId: "digest_queue", section: "queues.producers", binding: "DIGEST_QUEUE" },
  { modelId: "analytics_engine", section: "analytics_engine_datasets", binding: "USAGE_ANALYTICS" },
  { modelId: "r2_source_vault", section: "r2_buckets", binding: "SOURCE_VAULT" },
];

const DOMAIN_TARGETS = [
  {
    modelId: "worker_api",
    name: "Worker runtime",
    observed: (facts) => Boolean(
      facts.routes?.config?.length ||
      facts.routes?.dispatch?.length ||
      facts.crons?.schedules?.length ||
      facts.bindings?.environments,
    ),
  },
  {
    modelId: "warehouse_factory",
    name: "Warehouse factory",
    observed: (facts) => Boolean(
      facts.warehouse?.engines?.length || facts.warehouse?.adapters?.length,
    ),
  },
  {
    modelId: "entity_resolution",
    name: "Entity resolution",
    observed: (facts) => facts.entity_resolution?.package?.exists === true,
  },
  {
    modelId: "ontology_registry",
    name: "Civic Graph ontology",
    observed: (facts) => Boolean(facts.ontology?.registry?.schema),
  },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function quotedStrings(line) {
  return [...line.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) =>
    match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
}

function parseWorkspace(contents) {
  const elements = [];
  const relationships = [];
  const rationaleRequired = [];

  for (const [index, raw] of contents.split("\n").entries()) {
    const line = index + 1;
    const declaration = raw.match(/^\s*([A-Za-z_$][\w$]*)\s*=\s*(person|softwareSystem|container)\s+(.+)$/);
    if (declaration) {
      const strings = quotedStrings(declaration[3]);
      elements.push({
        id: declaration[1],
        type: declaration[2],
        name: strings[0] ?? null,
        description: strings[1] ?? null,
        technology: strings[2] ?? null,
        source: { path: "architecture/workspace.dsl", line },
      });
    }

    const relationship = raw.match(/^\s*([A-Za-z_$][\w$]*)\s*->\s*([A-Za-z_$][\w$]*)\s+"((?:\\.|[^"\\])*)"/);
    if (relationship) {
      relationships.push({
        source: relationship[1],
        target: relationship[2],
        description: relationship[3].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
        source_ref: { path: "architecture/workspace.dsl", line },
      });
    }

    if (/rationale required/i.test(raw)) {
      rationaleRequired.push({
        source: { path: "architecture/workspace.dsl", line },
        text: raw.trim(),
      });
    }
  }

  return { elements, relationships, rationaleRequired };
}

function markdownField(contents, field) {
  const tablePattern = new RegExp(`^\\s*\\|?\\s*${field}\\s*\\|\\s*(.*?)\\s*\\|?\\s*$`, "i");
  const boldPattern = new RegExp(`^\\s*\\*\\*${field}:\\*\\*\\s*(.*?)\\s*$`, "i");
  for (const raw of contents.split("\n")) {
    const match = raw.match(tablePattern) || raw.match(boldPattern);
    if (match) {
      const value = match[1].trim().replace(/\*\*/g, "");
      return value === "" || value === "—" || value === "-" ? null : value;
    }
  }
  return null;
}

function parseAdr(path, contents) {
  return {
    path,
    status: markdownField(contents, "Status"),
    supersedes: markdownField(contents, "Supersedes"),
  };
}

function loadAdrs(directory = ADR_DIR, root = ROOT) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const absolute = join(directory, name);
      return parseAdr(relative(root, absolute).split("\\").join("/"), readFileSync(absolute, "utf8"));
    });
}

function normalizeForComparison(value, key = null) {
  if (Array.isArray(value)) return value.map((item) => normalizeForComparison(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([entryKey]) => entryKey !== "source" && entryKey !== "source_ref")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entryKey, entryValue]) => [entryKey, normalizeForComparison(entryValue, entryKey)]));
  }
  if (key === "generated_at" || key === "commit") return undefined;
  return value;
}

function normalizeFactsForArtifact(value, path = "") {
  if (Array.isArray(value)) return value.map((item) => normalizeFactsForArtifact(item, path));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !(path === "" && (key === "generated_at" || key === "commit")))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeFactsForArtifact(item, path ? `${path}.${key}` : key)]));
  }
  return value;
}

function factsArtifactEqual(left, right) {
  return JSON.stringify(normalizeFactsForArtifact(left)) === JSON.stringify(normalizeFactsForArtifact(right));
}

function factArrayKey(value) {
  return JSON.stringify(normalizeForComparison(value));
}

function diffFacts(before, after) {
  const changes = { additions: [], removals: [], contradictions: [] };

  function walk(left, right, path) {
    if (path === "generated_at" || path === "commit") return;
    if (Array.isArray(left) && Array.isArray(right)) {
      const beforeItems = new Map(left.map((item) => [factArrayKey(item), item]));
      const afterItems = new Map(right.map((item) => [factArrayKey(item), item]));
      for (const [key, item] of afterItems) {
        if (!beforeItems.has(key)) changes.additions.push({ target: path, value: item });
      }
      for (const [key, item] of beforeItems) {
        if (!afterItems.has(key)) changes.removals.push({ target: path, value: item });
      }
      return;
    }
    if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of [...keys].sort()) walk(left[key], right[key], path ? `${path}.${key}` : key);
      return;
    }
    if (!Object.is(left, right)) {
      changes.contradictions.push({ target: path, before: left, after: right });
    }
  }

  walk(before, after, "");
  return changes;
}

function factsSection(facts, section) {
  const [group, nested] = section.split(".", 2);
  if (nested) return facts.bindings?.environments?.production?.[group]?.[nested] ?? null;
  return facts.bindings?.environments?.production?.[group] ?? null;
}

function bindingState(facts, target) {
  const section = factsSection(facts, target.section);
  if (section === null) return { observed: null, value: null, source: `bindings.environments.production.${target.section}` };
  if (!Array.isArray(section)) return { observed: null, value: null, source: `bindings.environments.production.${target.section}` };
  const value = section.find((item) => item && item.binding === target.binding);
  return {
    observed: value ? true : false,
    value: value ?? null,
    source: `bindings.environments.production.${target.section}`,
  };
}

function declarationText(element) {
  return [element?.name, element?.description, element?.technology].filter(Boolean).join(" ");
}

function isInactive(element) {
  return /\b(disabled|inactive|planned|reserved|feature-gated)\b/i.test(declarationText(element));
}

function issue(type, target, details = {}) {
  return {
    type,
    target,
    ...details,
    rationale: null,
    rationale_status: "rationale required",
  };
}

function proposalFor(item) {
  const action = {
    addition: "Decide whether to add or reject the observed element in the C4 model.",
    removal: "Decide whether to remove or retain the C4 declaration.",
    contradiction: "Resolve the implementation/model state mismatch.",
  }[item.type] ?? "Decide how the architecture record should change.";
  return {
    type: item.type,
    target: item.target,
    files: ["architecture/workspace.dsl", "ARCHITECTURE.md", "docs/adr/"],
    action,
    rationale: null,
    rationale_status: "rationale required",
  };
}

function apparentSupersededAdrs(adrs) {
  const results = [];
  const byStem = new Map(adrs.map((adr) => [adr.path.split("/").pop().replace(/\.md$/, ""), adr]));
  for (const adr of adrs) {
    if (adr.status && /\b(superseded|deprecated|retired|withdrawn)\b/i.test(adr.status)) {
      results.push({ path: adr.path, status: adr.status, reason: "ADR status marks it as no longer current." });
    }
    if (!adr.supersedes) continue;
    const refs = [...adr.supersedes.matchAll(/(?:docs\/adr\/)?([A-Za-z0-9_-]+)(?:\.md)?/g)]
      .map((match) => match[1])
      .filter((ref) => ref !== "Supersedes");
    for (const ref of refs) {
      const target = byStem.get(ref);
      results.push({
        path: target?.path ?? `docs/adr/${ref}.md`,
        status: target?.status ?? null,
        reason: "Another ADR declares that it supersedes this record.",
        superseded_by: adr.path,
      });
    }
  }
  return results;
}

function reconcileArchitecture({ facts, baselineFacts = facts, model, adrs = [] }) {
  const parsedModel = typeof model === "string" ? parseWorkspace(model) : model;
  const additions = [];
  const removals = [];
  const contradictions = [];
  const declared = new Map(parsedModel.elements.map((element) => [element.id, element]));

  const factChanges = diffFacts(baselineFacts, facts);
  additions.push(...factChanges.additions.map((change) => issue("addition", `facts:${change.target}`, { value: change.value, source: change.value?.source ?? null })));
  removals.push(...factChanges.removals.map((change) => issue("removal", `facts:${change.target}`, { value: change.value, source: change.value?.source ?? null })));
  contradictions.push(...factChanges.contradictions.map((change) => issue("contradiction", `facts:${change.target}`, change)));

  for (const target of RESOURCE_TARGETS) {
    const state = bindingState(facts, target);
    const element = declared.get(target.modelId);
    const targetName = `${target.modelId} (${target.binding})`;

    if (state.observed === true && !element) {
      additions.push(issue("addition", targetName, { observed: state.value, source: state.source }));
      continue;
    }
    if (state.observed === true && element && isInactive(element)) {
      contradictions.push(issue("contradiction", targetName, {
        observed: state.value,
        declared: declarationText(element),
        source: state.source,
      }));
      continue;
    }
    if (state.observed === false && element && !isInactive(element)) {
      removals.push(issue("removal", targetName, {
        observed: false,
        declared: declarationText(element),
        source: state.source,
      }));
      continue;
    }
    if (state.observed === null && element && !isInactive(element)) {
      contradictions.push(issue("contradiction", targetName, {
        observed: null,
        declared: declarationText(element),
        source: state.source,
      }));
    }
  }

  const activeBindings = [];
  const environments = facts.bindings?.environments ?? {};
  for (const [environment, values] of Object.entries(environments)) {
    for (const [section, value] of Object.entries(values ?? {})) {
      if (section === "vars" || value === null) continue;
      const arrays = section === "queues" ? Object.entries(value ?? {}).map(([queueKind, rows]) => [`${section}.${queueKind}`, rows]) : [[section, value]];
      for (const [effectiveSection, rows] of arrays) {
        for (const row of rows ?? []) {
          if (row?.binding) activeBindings.push({ environment, section: effectiveSection, binding: row.binding, value: row });
        }
      }
    }
  }
  for (const active of activeBindings) {
    const target = RESOURCE_TARGETS.find((candidate) => candidate.section === active.section && candidate.binding === active.binding);
    if (!target) {
      additions.push(issue("addition", `binding ${active.environment}.${active.section}.${active.binding}`, {
        observed: active.value,
        source: `bindings.environments.${active.environment}.${active.section}`,
      }));
    }
  }

  for (const domain of DOMAIN_TARGETS) {
    const observed = domain.observed(facts);
    const element = declared.get(domain.modelId);
    if (observed && !element) {
      additions.push(issue("addition", domain.name, { model_id: domain.modelId }));
    } else if (!observed && element && !isInactive(element)) {
      removals.push(issue("removal", domain.name, { model_id: domain.modelId }));
    }
  }

  const supersededAdrs = apparentSupersededAdrs(adrs);
  const unique = (items) => [...new Map(items.map((item) => [JSON.stringify(item), item])).values()];
  const allDrift = unique([...additions, ...removals, ...contradictions]);
  const proposals = allDrift.map(proposalFor);

  return {
    schema: "cityscroll.architecture.reconciliation.v1",
    status: allDrift.length || supersededAdrs.length ? "drift" : "healthy",
    outcomes: {
      additions: unique(additions),
      removals: unique(removals),
      contradictions: unique(contradictions),
      superseded_adrs: unique(supersededAdrs),
      rationale_required: unique(parsedModel.rationaleRequired),
    },
    proposals,
    source_nulls: collectSourceNulls(facts),
  };
}

function collectSourceNulls(facts) {
  const nulls = [];
  for (const [environment, values] of Object.entries(facts.bindings?.environments ?? {})) {
    for (const [section, value] of Object.entries(values ?? {})) {
      if (value === null) nulls.push({
        path: `bindings.environments.${environment}.${section}`,
        value: null,
      });
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [nested, nestedValue] of Object.entries(value)) {
          if (nestedValue === null) nulls.push({
            path: `bindings.environments.${environment}.${section}.${nested}`,
            value: null,
          });
        }
      }
    }
  }
  return nulls;
}

function buildReport({ root = ROOT, factsPath = FACTS_PATH, modelPath = MODEL_PATH, adrDir = ADR_DIR } = {}) {
  const baselineFacts = readJson(factsPath);
  const generatedFacts = buildFacts({
    generatedAt: baselineFacts.generated_at ?? null,
    commit: baselineFacts.commit ?? null,
  });
  const report = reconcileArchitecture({
    facts: generatedFacts,
    baselineFacts,
    model: parseWorkspace(readFileSync(modelPath, "utf8")),
    adrs: loadAdrs(adrDir, root),
  });
  return {
    ...report,
    generated_at: generatedFacts.generated_at,
    facts: {
      path: relative(root, factsPath).split("\\").join("/"),
      artifact_current: factsArtifactEqual(baselineFacts, generatedFacts),
      regenerated_commit: generatedFacts.commit,
    },
  };
}

function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const check = args.has("--check");
  const noWrite = args.has("--no-write");
  const report = buildReport();

  if (!report.facts.artifact_current) {
    report.outcomes.contradictions.push(issue("contradiction", "architecture/generated/facts.json", {
      declared: "committed facts artifact",
      observed: "regenerated facts differ",
    }));
    report.status = "drift";
    report.proposals.push(proposalFor(report.outcomes.contradictions.at(-1)));
  }

  if (!noWrite) {
    mkdirSync(dirname(RECEIPT_PATH), { recursive: true });
    writeFileSync(RECEIPT_PATH, render(report));
    if (!check) {
      mkdirSync(dirname(FACTS_PATH), { recursive: true });
      writeFileSync(FACTS_PATH, render(buildFacts()));
    }
  }

  process.stdout.write(render(report));
  if (check && report.status !== "healthy") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export {
  apparentSupersededAdrs,
  buildReport,
  collectSourceNulls,
  diffFacts,
  parseAdr,
  parseWorkspace,
  reconcileArchitecture,
};
