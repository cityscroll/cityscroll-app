#!/usr/bin/env node

/**
 * Reconcile generated architecture evidence with the human-owned C4 model.
 *
 * This tool is deliberately a proposal generator. It can identify a state
 * mismatch, but it cannot know why a design changed. Every proposed semantic
 * change therefore carries a null rationale and the literal status
 * "rationale required" for human adjudication.
 *
 * Over-time comparison uses the committed compact watermark at
 * architecture/generated/watermark.json as baselineFacts. Advance that
 * baseline with --write-watermark after review. --check never writes it.
 */
import { buildFacts } from "./build_architecture_facts.mjs";
import {
  WATERMARK_RELATIVE,
  buildWatermark,
  isWatermark,
  loadWatermark,
  projectForDiff,
} from "./architecture_watermark.mjs";
import { checkArchitectureEvidence } from "./architecture_evidence_shards.mjs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = join(ROOT, "architecture", "generated");
const MODEL_PATH = join(ROOT, "architecture", "workspace.dsl");
const ADR_DIR = join(ROOT, "docs", "adr");
const ARCHITECTURE_NARRATIVE_RELATIVE = "ARCHITECTURE.md";
const CANONICAL_ARCHITECTURE_RELATIVE = "docs/architecture.md";
const RESIDENT_READ_POLICY_RELATIVE = "architecture/resident-read-policy.json";
const RESIDENT_READ_TARGET = `${ARCHITECTURE_NARRATIVE_RELATIVE}:resident-read-invariant`;

const RESOURCE_TARGETS = [
  { modelId: "d1_notices", section: "d1_databases", binding: "DB" },
  { modelId: "kv_nl_meter", section: "kv_namespaces", binding: "NL_METER" },
  { modelId: "kv_alert_state", section: "kv_namespaces", binding: "ALERT_STATE" },
  { modelId: "kv_subs", section: "kv_namespaces", binding: "SUBS" },
  { modelId: "kv_feedback", section: "kv_namespaces", binding: "FEEDBACK" },
  { modelId: "digest_queue", section: "queues.producers", binding: "DIGEST_QUEUE" },
  { modelId: "analytics_engine", section: "analytics_engine_datasets", binding: "USAGE_ANALYTICS" },
  { modelId: "rum_analytics", section: "analytics_engine_datasets", binding: "RUM_ANALYTICS" },
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
  {
    modelId: "performance_registry",
    name: "Performance observability registry",
    observed: (facts) => Boolean(
      facts.performance_observability?.catalog?.registry_hash
      && facts.performance_observability?.registry?.surface_count,
    ),
  },
];

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

function factArrayKey(value) {
  return JSON.stringify(normalizeForComparison(value));
}

function diffFacts(before, after) {
  const changes = { additions: [], removals: [], contradictions: [] };

  function walk(left, right, path) {
    // Observer coverage is a first-class LA8 outcome, not a topology diff.
    // Compact watermarks carry observer_coverage_hash instead; skip this
    // block so coverage never double-counts as addition/removal.
    if (path === "generated_at" || path === "commit" || path === "observer_coverage") return;
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

function unknownSurfaceTarget(entry) {
  const id = entry?.id ? String(entry.id) : "";
  const path = entry?.path ? String(entry.path) : "";
  if (id && path) return `${id} (${path})`;
  return id || path || "unknown_surface";
}

function unmappedSurfacesFromCoverage(facts) {
  const surfaces = facts?.observer_coverage?.unmapped_surfaces;
  if (!Array.isArray(surfaces) || surfaces.length === 0) return [];
  return surfaces
    .filter((entry) => entry && (entry.id || entry.path))
    .map((entry) => issue("unknown_surface", unknownSurfaceTarget(entry), {
      canary_id: entry.id ?? null,
      path: entry.path ?? null,
      source: "observer_coverage.unmapped_surfaces",
    }));
}

function normalizeProse(value) {
  return String(value || "")
    .replace(/[`*_>#\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function narrativeStatements(contents) {
  const prose = String(contents || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  return prose
    .split(/(?<=[.!?])\s+|\n+/)
    .map((statement) => normalizeProse(statement))
    .filter(Boolean);
}

function assertsRequestTimePublisherRead(statement) {
  const text = normalizeProse(statement).toLowerCase();
  if (!text) return false;
  if (/\b(?:never|does not|do not|must not|may not|cannot|can't|none? permits?|without)\b/.test(text)) {
    return false;
  }

  // These are assertion shapes, not an invariant registry. The invariant
  // itself remains owned by resident-read-policy.json; this detector catches
  // prose that grants the request-time publisher behavior that it forbids.
  const directPublisherRead = /\b(?:browser|resident|visitor|read path|reader|view|lens|route|site|page|hydration|request)\b.{0,180}\b(?:can|may|does|will|uses?|allows?|supports?)\b.{0,100}\b(?:read|fetch|query|call|lookup|refresh)\b.{0,100}\b(?:live|publisher|upstream|external|socrata|geospatial|api|source)\b/;
  const liveFallback = /\b(?:bounded|documented|synchronous|request[- ]time|live)\s+(?:(?:publisher|upstream|external|source)\s+)?(?:live\s+)?fallback\b|\bfallback\b.{0,80}\b(?:publisher|upstream|external|live source)\b/;
  const liveRequest = /\b(?:live\s+)?(?:publisher|upstream|external)\s+(?:request|call|lookup|fetch|read)s?\b.{0,80}\b(?:remain|retained|allowed|supported|freshness|fallback)\b|\bfreshness\b.{0,60}\b(?:live request|live source)\b|\blive sources?\b.{0,80}\b(?:remain|retained|allowed|supported|freshness|fallback)\b/;
  const exactExternalLookup = /\b(?:resident|visitor|browser|hydration|read|view|route)\b.{0,160}\bexact external lookup\b/;

  return directPublisherRead.test(text)
    || liveFallback.test(text)
    || liveRequest.test(text)
    || exactExternalLookup.test(text);
}

function residentReadDocumentContradictions({
  architectureNarrative,
  canonicalArchitecture,
  residentReadPolicy,
} = {}) {
  if (architectureNarrative == null && canonicalArchitecture == null && residentReadPolicy == null) return [];

  const invariant = normalizeProse(residentReadPolicy?.invariant);
  if (!invariant) {
    return [issue("contradiction", `${RESIDENT_READ_POLICY_RELATIVE}#invariant`, {
      declared: residentReadPolicy?.invariant ?? null,
      required: "non-empty authoritative invariant string",
      source: RESIDENT_READ_POLICY_RELATIVE,
    })];
  }

  const findings = [];
  if (!normalizeProse(canonicalArchitecture).includes(invariant)) {
    findings.push(issue("contradiction", `${CANONICAL_ARCHITECTURE_RELATIVE}:resident-read-invariant`, {
      declared: "authoritative policy invariant is absent from the canonical architecture document",
      required: residentReadPolicy.invariant,
      source: `${RESIDENT_READ_POLICY_RELATIVE}#invariant`,
    }));
  }

  for (const statement of narrativeStatements(architectureNarrative)) {
    if (!assertsRequestTimePublisherRead(statement)) continue;
    findings.push(issue("contradiction", RESIDENT_READ_TARGET, {
      declared: statement,
      required: residentReadPolicy.invariant,
      source: `${RESIDENT_READ_POLICY_RELATIVE}#invariant`,
    }));
  }
  return findings;
}

function proposalFor(item) {
  const documentInvariant = item.target === RESIDENT_READ_TARGET
    || String(item.target || "").startsWith(`${CANONICAL_ARCHITECTURE_RELATIVE}:`)
    || String(item.target || "").startsWith(`${RESIDENT_READ_POLICY_RELATIVE}#`);
  const action = {
    addition: "Decide whether to add or reject the observed element in the C4 model.",
    removal: "Decide whether to remove or retain the C4 declaration.",
    contradiction: documentInvariant
      ? "Align the human architecture narrative with the canonical resident-read invariant and its policy gate."
      : item.target === WATERMARK_RELATIVE || String(item.target || "").startsWith("facts:canaries.")
        ? "Review the compact watermark against current observed canary fingerprints, then advance it with --write-watermark or restore the prior topology."
        : "Resolve the implementation/model state mismatch.",
    unknown_surface: "Extend the facts observer to cover this known canary, or record an ADR explaining the unobserved architecture-affecting surface.",
  }[item.type] ?? "Decide how the architecture record should change.";
  return {
    type: item.type,
    target: item.target,
    files: documentInvariant
      ? [ARCHITECTURE_NARRATIVE_RELATIVE, CANONICAL_ARCHITECTURE_RELATIVE, RESIDENT_READ_POLICY_RELATIVE]
      : item.type === "unknown_surface"
      ? ["architecture/observer-canaries.json", "tools/build_architecture_facts.mjs", "ARCHITECTURE.md", "docs/adr/"]
      : item.target === WATERMARK_RELATIVE || String(item.target || "").startsWith("facts:canaries.")
        ? [WATERMARK_RELATIVE, "ARCHITECTURE.md", "docs/adr/"]
        : ["architecture/workspace.dsl", "ARCHITECTURE.md", "docs/adr/"],
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

function missingWatermarkIssue() {
  return issue("contradiction", WATERMARK_RELATIVE, {
    before: null,
    after: "required compact baseline",
    source: WATERMARK_RELATIVE,
  });
}

function reconcileArchitecture({
  facts,
  baselineFacts,
  model,
  adrs = [],
  root = ROOT,
  architectureNarrative,
  canonicalArchitecture,
  residentReadPolicy,
} = {}) {
  // baselineFacts is the LA9 seam. The CLI and buildReport load the committed
  // compact watermark; explicit callers may still pass full facts. LA8 still
  // fails independently when observer_coverage.unmapped_surfaces is non-empty.
  const parsedModel = typeof model === "string" ? parseWorkspace(model) : model;
  const additions = [];
  const removals = [];
  const contradictions = residentReadDocumentContradictions({
    architectureNarrative,
    canonicalArchitecture,
    residentReadPolicy,
  });
  const declared = new Map(parsedModel.elements.map((element) => [element.id, element]));

  const resolvedBaseline = baselineFacts !== undefined
    ? baselineFacts
    : loadWatermark({ root });
  if (resolvedBaseline == null) {
    contradictions.push(missingWatermarkIssue());
  }
  const factChanges = resolvedBaseline == null
    ? { additions: [], removals: [], contradictions: [] }
    : diffFacts(projectForDiff(resolvedBaseline, facts), projectForDiff(facts, resolvedBaseline));
  additions.push(...factChanges.additions.map((change) => issue("addition", `facts:${change.target}`, { value: change.value, source: change.value?.source ?? null })));
  removals.push(...factChanges.removals.map((change) => issue("removal", `facts:${change.target}`, { value: change.value, source: change.value?.source ?? null })));
  contradictions.push(...factChanges.contradictions.map((change) => issue("contradiction", `facts:${change.target}`, {
    before: change.before,
    after: change.after,
    source: change.source ?? null,
  })));

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
  const unmapped = unique(unmappedSurfacesFromCoverage(facts));
  const allDrift = unique([...additions, ...removals, ...contradictions, ...unmapped]);
  const proposals = allDrift.map(proposalFor);

  return {
    schema: "cityscroll.architecture.reconciliation.v1",
    status: allDrift.length || supersededAdrs.length ? "drift" : "healthy",
    outcomes: {
      additions: unique(additions),
      removals: unique(removals),
      contradictions: unique(contradictions),
      unmapped,
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

function baselineLabel(baselineFacts) {
  if (baselineFacts == null) return null;
  if (isWatermark(baselineFacts)) return WATERMARK_RELATIVE;
  return "supplied";
}

function buildReport({
  root = ROOT,
  facts = buildFacts(),
  baselineFacts,
  modelPath = MODEL_PATH,
  adrDir = ADR_DIR,
  architectureNarrative,
  canonicalArchitecture,
  residentReadPolicy,
} = {}) {
  const resolvedBaseline = baselineFacts !== undefined
    ? baselineFacts
    : loadWatermark({ root });
  const resolvedNarrative = architectureNarrative !== undefined
    ? architectureNarrative
    : readFileSync(join(root, ARCHITECTURE_NARRATIVE_RELATIVE), "utf8");
  const resolvedCanonical = canonicalArchitecture !== undefined
    ? canonicalArchitecture
    : readFileSync(join(root, CANONICAL_ARCHITECTURE_RELATIVE), "utf8");
  const resolvedPolicy = residentReadPolicy !== undefined
    ? residentReadPolicy
    : JSON.parse(readFileSync(join(root, RESIDENT_READ_POLICY_RELATIVE), "utf8"));
  const report = reconcileArchitecture({
    facts,
    baselineFacts: resolvedBaseline,
    model: parseWorkspace(readFileSync(modelPath, "utf8")),
    adrs: loadAdrs(adrDir, root),
    root,
    architectureNarrative: resolvedNarrative,
    canonicalArchitecture: resolvedCanonical,
    residentReadPolicy: resolvedPolicy,
  });
  return {
    ...report,
    generated_at: facts.generated_at,
    facts: {
      source: "generated_in_memory",
      regenerated_commit: facts.commit,
      baseline: baselineLabel(resolvedBaseline),
      performance_observability: {
        coverage: facts.performance_observability?.coverage ?? null,
        measurements_included: facts.performance_observability?.measurements_included === true,
      },
    },
  };
}

function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const check = args.has("--check");
  const noWrite = args.has("--no-write");
  // Watermark advancement is a reviewed LA6 step. --check never writes it.
  const writeWatermark = args.has("--write-watermark");
  const outputDir = resolve(ROOT, optionValue(argv, "--output-dir") || DEFAULT_OUTPUT_DIR);
  const facts = buildFacts();
  const report = buildReport({ facts });

  const evidence = check
    ? checkArchitectureEvidence({ root: ROOT })
    : null;

  if (!noWrite) {
    // determinism-lint: allow write check-mode facts go only to --output-dir or gitignored generated files
    mkdirSync(outputDir, { recursive: true });
    // determinism-lint: allow write check-mode facts go only to --output-dir or gitignored generated files
    writeFileSync(join(outputDir, "facts.json"), render(facts));
    // determinism-lint: allow write check-mode facts go only to --output-dir or gitignored generated files
    writeFileSync(join(outputDir, "reconciliation.json"), render(report));
    if (
      evidence?.sourceCardsText &&
      evidence?.projectionsText &&
      resolve(outputDir) !== resolve(DEFAULT_OUTPUT_DIR)
    ) {
      // determinism-lint: allow write derived inventories go only to an explicit --output-dir
      writeFileSync(join(outputDir, "source-cards.json"), evidence.sourceCardsText);
      // determinism-lint: allow write derived inventories go only to an explicit --output-dir
      writeFileSync(join(outputDir, "projections.json"), evidence.projectionsText);
    }
  }
  if (writeWatermark) {
    const target = join(ROOT, WATERMARK_RELATIVE);
    // determinism-lint: allow write watermark advancement is a reviewed non-check step
    mkdirSync(dirname(target), { recursive: true });
    // determinism-lint: allow write watermark advancement is a reviewed non-check step
    writeFileSync(target, render(buildWatermark(facts)));
  }

  process.stdout.write(render(report));
  if (check && report.status !== "healthy") process.exitCode = 1;
  if (check && evidence?.status !== "PASS") {
    for (const row of evidence.findings) console.error(`architecture-evidence: ${row}`);
    process.exitCode = 1;
  }
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
  residentReadDocumentContradictions,
};
