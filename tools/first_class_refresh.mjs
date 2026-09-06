#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BROWSE_FACETS } from "../site/browse_view.mjs";
import { BROWSE_SURFACES } from "../site/browse_surface_contracts.mjs";
import { ANALYTICAL_PROJECTION_URL } from "../site/analytical_projection.mjs";
import { PAYMENT_ANALYTICAL_PROJECTION_URL } from "../site/analytical_payment_projection.mjs";
import { PERFORMANCE_EVIDENCE_ANALYTICAL_PROJECTION_URL } from "../site/analytical_performance_evidence.mjs";

export const FIRST_CLASS_REPORT_SCHEMA = "cityscroll.first_class_freshness_report.v1";
export const FIRST_CLASS_REFRESH_RECEIPT_SCHEMA = "cityscroll.first_class_refresh_receipt.v1";
export const FIRST_CLASS_DUE_LIST_SCHEMA = "cityscroll.first_class_due_list.v1";
export const FIRST_CLASS_STATES = Object.freeze([
  "fresh",
  "fresh_empty",
  "degraded",
  "stale",
  "unavailable",
]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_PATH = join(ROOT, "site/data/source_contracts.json");
const OBSERVATIONS_PATH = join(ROOT, "site/data/source_health_observations.json");
const REPORT_PATH = join(ROOT, "site/data/first_class_freshness_report.json");
const PLAN_PATH = join(ROOT, ".artifacts/first-class-refresh-plan.json");
const RECEIPT_PATH = join(ROOT, ".artifacts/first-class-refresh-receipt.json");

const DISCOVERED_DERIVED_ARTIFACTS = Object.freeze([
  "/data/money_procurement_agencies.json",
  "/data/money_resident_snapshot.json",
  "/data/procurement_browse_rows.json",
  "/data/procurement_browse_query.json",
  "/data/people_organizations_read_model.json",
  "/data/shared_meeting_read_model.json",
  "/data/property_resident_snapshot.json",
  `/${ANALYTICAL_PROJECTION_URL}`,
  `/${PAYMENT_ANALYTICAL_PROJECTION_URL}`,
  `/${PERFORMANCE_EVIDENCE_ANALYTICAL_PROJECTION_URL}`,
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sitePath(value) {
  const path = String(value || "").replace(/^\/+/, "");
  return path.startsWith("site/") ? path : `site/${path}`;
}

function commandKey(command) {
  return JSON.stringify(command);
}

function validInstant(value) {
  if (typeof value !== "string") return null;
  const candidates = value.match(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g) || [];
  const instants = candidates
    .map((candidate) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(candidate) ? `${candidate}T00:00:00.000Z` : candidate))
    .filter(Number.isFinite);
  return instants.length ? new Date(Math.max(...instants)).toISOString() : null;
}

function valueAt(value, dottedPath) {
  return String(dottedPath || "").split(".").reduce((current, key) => current?.[key], value);
}

function vintageFrom(payload, fields) {
  for (const field of fields || []) {
    const vintage = validInstant(valueAt(payload, field));
    if (vintage) return vintage;
  }
  return null;
}

function populationSize(payload, fields) {
  for (const field of fields || []) {
    const value = valueAt(payload, field);
    if (Array.isArray(value)) return value.length;
    if (Number.isFinite(Number(value)) && value !== "") return Number(value);
    if (value && typeof value === "object") return Object.keys(value).length;
  }
  return null;
}

function artifactSource(root, artifact) {
  const path = join(root, artifact.public_artifact_path);
  if (!existsSync(path)) return { payload: null, vintage: null, population: null };
  try {
    const payload = readJson(path);
    return {
      payload,
      vintage: vintageFrom(payload, artifact.vintage_fields),
      population: populationSize(payload, artifact.population_fields),
    };
  } catch {
    return { payload: null, vintage: null, population: null };
  }
}

export function discoverFirstClassArtifactPaths(root = ROOT) {
  const paths = new Set(Object.values(BROWSE_FACETS).map((facet) => sitePath(facet.dataPath)));
  for (const path of DISCOVERED_DERIVED_ARTIFACTS) paths.add(sitePath(path));

  const primaryBuilder = readFileSync(join(root, "tools/build_primary_documents.mjs"), "utf8");
  for (const match of primaryBuilder.matchAll(/json\(["'](\/data\/[^"']+\.json)["']\)/g)) {
    paths.add(sitePath(match[1]));
  }
  const nowSource = readFileSync(join(root, "site/now_view.mjs"), "utf8");
  for (const match of nowSource.matchAll(/["'](data\/[^"']+\.json)["']/g)) {
    paths.add(sitePath(match[1]));
  }
  return [...paths].sort();
}

export function discoverFirstClassRoutes() {
  return [...new Set([
    "/browse/",
    "/now/",
    ...Object.values(BROWSE_FACETS).map((facet) => facet.route),
    ...BROWSE_SURFACES.map((surface) => surface.canonicalRoute),
  ])].sort();
}

function validateCommand(command, label, root, errors) {
  if (!Array.isArray(command) || command.length < 2 || !command.every((part) => typeof part === "string" && part.trim())) {
    errors.push(`${label}: must be a non-empty argv array`);
    return;
  }
  if (!new Set(["node", "python3"]).has(command[0])) errors.push(`${label}: command must use node or python3`);
  if (/^(?:\/|\.\.)/.test(command[1])) errors.push(`${label}: executable path must be repository-relative`);
  if (!existsSync(join(root, command[1]))) errors.push(`${label}: executable does not exist: ${command[1]}`);
}

export function validateFirstClassRefreshContracts(registry, options = {}) {
  const root = options.root || ROOT;
  const errors = [];
  const sourceContracts = new Map((registry?.contracts || []).map((contract) => [contract.id, contract]));
  const sourceIds = new Set(sourceContracts.keys());
  const artifacts = registry?.first_class_artifacts;
  if (!Array.isArray(artifacts) || !artifacts.length) return ["first_class_artifacts must be a non-empty array"];
  const ids = new Set();
  const paths = new Set();
  const routes = new Set();
  const evidenceFields = new Set();
  for (const artifact of artifacts) {
    const label = artifact?.id || "(missing id)";
    if (!artifact?.id) errors.push(`${label}: missing id`);
    if (ids.has(artifact?.id)) errors.push(`${label}: duplicate id`);
    ids.add(artifact?.id);
    if (!artifact?.public_artifact_path?.startsWith("site/")) errors.push(`${label}: public_artifact_path must begin with site/`);
    if (paths.has(artifact?.public_artifact_path)) errors.push(`${label}: duplicate public_artifact_path`);
    paths.add(artifact?.public_artifact_path);
    if (!sourceIds.has(artifact?.source_contract_id)) errors.push(`${label}: unknown source_contract_id ${artifact?.source_contract_id}`);
    validateCommand(artifact?.acquisition_command, `${label}: acquisition_command`, root, errors);
    validateCommand(artifact?.builder_command, `${label}: builder_command`, root, errors);
    if (typeof artifact?.owning_builder !== "string" || !existsSync(join(root, artifact.owning_builder))) {
      errors.push(`${label}: owning_builder must name an existing repository file`);
    }
    if (!Array.isArray(artifact?.dependent_materializers) || !artifact.dependent_materializers.length) {
      errors.push(`${label}: dependent_materializers must be non-empty`);
    } else {
      for (const materializer of artifact.dependent_materializers) {
        if (!existsSync(join(root, materializer))) errors.push(`${label}: dependent materializer does not exist: ${materializer}`);
      }
    }
    const cadence = Number(artifact?.normal_refresh_cadence_hours);
    if (!(cadence > 0)) errors.push(`${label}: normal_refresh_cadence_hours must be positive`);
    if (cadence > 24 && !String(artifact?.cadence_justification || "").trim()) {
      errors.push(`${label}: cadence over 24 hours needs cadence_justification`);
    }
    const warning = Number(artifact?.warning_age_hours);
    const maximum = Number(artifact?.hard_maximum_age_hours);
    if (!(warning > 0)) errors.push(`${label}: warning_age_hours must be positive`);
    if (!(maximum >= warning)) errors.push(`${label}: hard_maximum_age_hours must be at least warning_age_hours`);
    const servingDays = Number(sourceContracts.get(artifact?.source_contract_id)?.freshness_contract?.serving_max_age_days);
    if (Number.isFinite(servingDays) && maximum > servingDays * 24) {
      errors.push(`${label}: hard_maximum_age_hours exceeds the source contract serving limit`);
    }
    if (!Array.isArray(artifact?.vintage_fields) || !artifact.vintage_fields.length) errors.push(`${label}: vintage_fields must be non-empty`);
    if (!Array.isArray(artifact?.population_fields) || !artifact.population_fields.length) errors.push(`${label}: population_fields must be non-empty`);
    for (const field of [
      "last_known_good_behavior",
      "resident_stale_behavior",
      "resident_unavailable_behavior",
      "production_evidence_field",
    ]) {
      if (!String(artifact?.[field] || "").trim()) errors.push(`${label}: missing ${field}`);
    }
    if (!Array.isArray(artifact?.primary_routes) || !artifact.primary_routes.length) {
      errors.push(`${label}: primary_routes must be non-empty`);
    } else {
      for (const route of artifact.primary_routes) {
        if (typeof route !== "string" || !route.startsWith("/")) errors.push(`${label}: primary route must be root-relative`);
        routes.add(route);
      }
    }
    if (evidenceFields.has(artifact?.production_evidence_field)) errors.push(`${label}: duplicate production_evidence_field`);
    evidenceFields.add(artifact?.production_evidence_field);
  }
  const discovered = options.discoveredPaths || discoverFirstClassArtifactPaths(root);
  for (const path of discovered) {
    if (!paths.has(path)) errors.push(`${path}: first-class artifact lacks a refresh contract`);
  }
  for (const route of options.discoveredRoutes || discoverFirstClassRoutes()) {
    if (!routes.has(route)) errors.push(`${route}: primary route lacks a refresh contract`);
  }
  return [...new Set(errors)].sort();
}

export function buildScheduledRefreshPlan(registry) {
  const artifacts = [...(registry?.first_class_artifacts || [])].sort((left, right) => (
    Number(left.normal_refresh_cadence_hours) - Number(right.normal_refresh_cadence_hours)
    || left.public_artifact_path.localeCompare(right.public_artifact_path)
  ));
  const groups = [];
  for (const cadence of [...new Set(artifacts.map((artifact) => Number(artifact.normal_refresh_cadence_hours)))].sort((a, b) => a - b)) {
    const members = artifacts.filter((artifact) => Number(artifact.normal_refresh_cadence_hours) === cadence);
    const acquisitions = [...new Map(members.map((artifact) => [commandKey(artifact.acquisition_command), artifact.acquisition_command])).values()];
    const builders = [...new Map(members.map((artifact) => [commandKey(artifact.builder_command), artifact.builder_command])).values()];
    const materializers = [...new Set(members.flatMap((artifact) => artifact.dependent_materializers))];
    groups.push({
      cadence_hours: cadence,
      artifacts: members.map((artifact) => artifact.public_artifact_path),
      stages: [
        { order: 1, kind: "acquisition", commands: acquisitions },
        { order: 2, kind: "owning-builder", commands: builders },
        { order: 3, kind: "dependent-materializer", commands: materializers.map((path) => ["node", path]) },
      ],
    });
  }
  return {
    schema: "cityscroll.first_class_refresh_plan.v1",
    generated_from: "site/data/source_contracts.json#first_class_artifacts",
    resident_reads_contact_publishers: false,
    scheduled_acquisition_may_contact_publishers: true,
    groups,
  };
}

function failedSources(refreshReceipt) {
  const result = new Set();
  for (const row of refreshReceipt?.commands || []) {
    if (row.status === "failed") for (const sourceId of row.source_contract_ids || []) result.add(sourceId);
  }
  return result;
}

export function buildFirstClassFreshnessReport(registry, options = {}) {
  const root = options.root || ROOT;
  const now = validInstant(options.now || new Date().toISOString());
  if (!now) throw new Error("first-class freshness report requires a valid evaluation timestamp");
  const healthBySource = new Map((options.observations?.observations || []).map((row) => [row.source_id, row.health?.status]));
  const failed = failedSources(options.refreshReceipt);
  const surfaces = (registry?.first_class_artifacts || []).map((artifact) => {
    const source = artifactSource(root, artifact);
    const ageHours = source.vintage == null ? null : (Date.parse(now) - Date.parse(source.vintage)) / 3_600_000;
    const sourceHealth = healthBySource.get(artifact.source_contract_id) || "UNKNOWN";
    let freshnessState = "unavailable";
    if (source.vintage != null && source.population != null && ageHours <= Number(artifact.hard_maximum_age_hours)) {
      if (failed.has(artifact.source_contract_id) || ["Degraded", "Source-unavailable", "Delayed"].includes(sourceHealth)
        || ageHours > Number(artifact.warning_age_hours)) {
        freshnessState = "degraded";
      } else {
        freshnessState = source.population === 0 ? "fresh_empty" : "fresh";
      }
    } else if (source.vintage != null) {
      freshnessState = "stale";
    }
    const populationState = source.population == null
      ? "unknown"
      : source.population === 0 ? "empty" : "populated";
    const disclosure = freshnessState === "fresh_empty"
      ? "The refreshed source contains no records for this declared population."
      : freshnessState === "degraded"
        ? artifact.last_known_good_behavior
        : freshnessState === "stale"
          ? artifact.resident_stale_behavior
          : freshnessState === "unavailable"
            ? artifact.resident_unavailable_behavior
            : null;
    return {
      id: artifact.id,
      public_artifact_path: artifact.public_artifact_path,
      primary_routes: artifact.primary_routes,
      source_contract_id: artifact.source_contract_id,
      source_vintage: source.vintage,
      age_hours: ageHours == null ? null : Math.max(0, Math.round(ageHours * 100) / 100),
      freshness_state: freshnessState,
      population_state: populationState,
      population_count: source.population,
      complete_for_empty_claim: freshnessState === "fresh_empty",
      owning_builder: artifact.owning_builder,
      production_evidence_field: artifact.production_evidence_field,
      source_health_status: sourceHealth,
      disclosure,
    };
  }).sort((left, right) => left.public_artifact_path.localeCompare(right.public_artifact_path));
  const counts = Object.fromEntries(FIRST_CLASS_STATES.map((state) => [
    state,
    surfaces.filter((surface) => surface.freshness_state === state).length,
  ]));
  return {
    schema: FIRST_CLASS_REPORT_SCHEMA,
    generated_at: now,
    deployment_identity: options.deploymentIdentity || null,
    registry: "site/data/source_contracts.json#first_class_artifacts",
    surface_count: surfaces.length,
    status: counts.stale || counts.unavailable ? "blocked" : counts.degraded ? "degraded" : "current",
    counts,
    surfaces,
  };
}

export function productionFreshnessFindings(report) {
  return (report?.surfaces || [])
    .filter((surface) => ["stale", "unavailable"].includes(surface.freshness_state))
    .map((surface) => `${surface.public_artifact_path}: ${surface.freshness_state} first-class artifact (vintage ${surface.source_vintage || "unknown"})`);
}

function selectedArtifactsForRun(registry, root, now, all) {
  return (registry.first_class_artifacts || []).filter((artifact) => {
    if (all) return true;
    const source = artifactSource(root, artifact);
    if (!source.vintage) return true;
    return Date.parse(now) - Date.parse(source.vintage) >= Number(artifact.normal_refresh_cadence_hours) * 3_600_000;
  });
}

export function rematerializationIsNotAcquisition(artifact = {}) {
  return JSON.stringify(artifact.acquisition_command || []) === JSON.stringify(artifact.builder_command || []);
}

export function runRefreshCommands(registry, options = {}) {
  const root = options.root || ROOT;
  const now = validInstant(options.now || new Date().toISOString());
  const selected = selectedArtifactsForRun(registry, root, now, options.all === true);
  const commands = [];
  const seen = new Set();
  const acquisitionFailed = new Set();
  for (const kind of ["acquisition_command", "builder_command"]) {
    for (const artifact of selected) {
      const command = artifact[kind];
      const key = commandKey(command);
      if (seen.has(key)) continue;
      seen.add(key);
      const declaredConsumers = selected.filter((candidate) => commandKey(candidate[kind]) === key);
      const consumers = kind === "builder_command"
        ? declaredConsumers.filter((candidate) => !acquisitionFailed.has(candidate.id))
        : declaredConsumers;
      if (!consumers.length) {
        commands.push({
          kind: "owning-builder",
          command,
          source_contract_ids: [...new Set(declaredConsumers.map((candidate) => candidate.source_contract_id))].sort(),
          artifact_paths: declaredConsumers.map((candidate) => candidate.public_artifact_path).sort(),
          status: "skipped",
          exit_code: null,
          reason: "acquisition failed; retained the last-known-good artifact",
        });
        continue;
      }
      const executable = command[0] === "node" ? process.execPath : command[0];
      const args = command[0] === "node" ? [join(root, command[1]), ...command.slice(2)] : [join(root, command[1]), ...command.slice(2)];
      const result = (options.spawn || spawnSync)(executable, args, { cwd: root, stdio: options.stdio || "inherit" });
      const status = result?.error || result?.status !== 0 ? "failed" : "succeeded";
      if (kind === "acquisition_command" && status === "failed") {
        for (const consumer of consumers) acquisitionFailed.add(consumer.id);
      }
      commands.push({
        kind: kind === "acquisition_command" ? "acquisition" : "owning-builder",
        command,
        source_contract_ids: [...new Set(consumers.map((candidate) => candidate.source_contract_id))].sort(),
        artifact_paths: consumers.map((candidate) => candidate.public_artifact_path).sort(),
        status,
        exit_code: result?.status ?? null,
      });
    }
  }
  const materializerConsumers = new Map();
  for (const artifact of selected) {
    for (const materializer of artifact.dependent_materializers || []) {
      if (!materializerConsumers.has(materializer)) materializerConsumers.set(materializer, []);
      materializerConsumers.get(materializer).push(artifact);
    }
  }
  for (const [materializerPath, declaredConsumers] of materializerConsumers) {
    const command = ["node", materializerPath];
    const consumers = declaredConsumers.filter((candidate) => !acquisitionFailed.has(candidate.id));
    if (!consumers.length) {
      commands.push({
        kind: "dependent-materializer",
        command,
        source_contract_ids: [...new Set(declaredConsumers.map((candidate) => candidate.source_contract_id))].sort(),
        artifact_paths: declaredConsumers.map((candidate) => candidate.public_artifact_path).sort(),
        status: "skipped",
        exit_code: null,
        reason: "acquisition failed; retained the last-known-good artifact",
      });
      continue;
    }
    const result = (options.spawn || spawnSync)(process.execPath, [join(root, materializerPath)], { cwd: root, stdio: options.stdio || "inherit" });
    const status = result?.error || result?.status !== 0 ? "failed" : "succeeded";
    commands.push({
      kind: "dependent-materializer",
      command,
      source_contract_ids: [...new Set(consumers.map((candidate) => candidate.source_contract_id))].sort(),
      artifact_paths: consumers.map((candidate) => candidate.public_artifact_path).sort(),
      status,
      exit_code: result?.status ?? null,
    });
  }
  return {
    schema: FIRST_CLASS_REFRESH_RECEIPT_SCHEMA,
    generated_at: now,
    status: commands.some((row) => row.status === "failed") ? "partial" : "succeeded",
    commands,
  };
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function writeJson(path, value) {
  // determinism-lint: allow write explicit --write/--run modes emit only declared generated artifacts and receipts
  mkdirSync(dirname(path), { recursive: true });
  // determinism-lint: allow write explicit --write/--run modes emit only declared generated artifacts and receipts
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function main(argv = process.argv.slice(2)) {
  const root = resolve(option(argv, "--source-dir", ROOT));
  const registry = readJson(join(root, "site/data/source_contracts.json"));
  const errors = validateFirstClassRefreshContracts(registry, { root });
  if (errors.length) throw new Error(`invalid first-class refresh contracts:\n${errors.join("\n")}`);
  if (argv.includes("--check-registry")) console.log(`first-class refresh registry complete: ${registry.first_class_artifacts.length} artifacts`);
  if (argv.includes("--write-plan")) {
    const output = resolve(root, option(argv, "--plan-out", relative(root, PLAN_PATH)));
    writeJson(output, buildScheduledRefreshPlan(registry));
    console.log(`wrote ${relative(root, output)}`);
  }
  if (argv.includes("--list-due")) {
    // Read-only rehearsal: report what a refresh run would select, run nothing.
    // determinism-lint: allow clock the due list is evaluated against the caller's production instant
    const now = validInstant(option(argv, "--now", new Date().toISOString()));
    const due = selectedArtifactsForRun(registry, root, now, argv.includes("--run-all"));
    console.log(JSON.stringify({
      schema: FIRST_CLASS_DUE_LIST_SCHEMA,
      generated_at: now,
      registry: "site/data/source_contracts.json#first_class_artifacts",
      due_count: due.length,
      due: due.map((artifact) => ({
        id: artifact.id,
        public_artifact_path: artifact.public_artifact_path,
        source_contract_id: artifact.source_contract_id,
        source_vintage: artifactSource(root, artifact).vintage,
        normal_refresh_cadence_hours: Number(artifact.normal_refresh_cadence_hours),
        acquisition_command: artifact.acquisition_command,
        builder_command: artifact.builder_command,
      })),
    }, null, 2));
  }
  let refreshReceipt = null;
  if (argv.includes("--run-due") || argv.includes("--run-all")) {
    refreshReceipt = runRefreshCommands(registry, {
      root,
      // determinism-lint: allow clock scheduled acquisition receipts record the production run instant outside check-only mode
      now: option(argv, "--now", new Date().toISOString()),
      all: argv.includes("--run-all"),
    });
    const output = resolve(root, option(argv, "--receipt-out", relative(root, RECEIPT_PATH)));
    writeJson(output, refreshReceipt);
    console.log(`wrote ${relative(root, output)} status=${refreshReceipt.status}`);
  }
  if (argv.includes("--write-report") || argv.includes("--check-production")) {
    const observations = existsSync(join(root, "site/data/source_health_observations.json"))
      ? readJson(join(root, "site/data/source_health_observations.json")) : null;
    const receiptPath = resolve(root, option(argv, "--receipt", relative(root, RECEIPT_PATH)));
    if (!refreshReceipt && existsSync(receiptPath)) refreshReceipt = readJson(receiptPath);
    const report = buildFirstClassFreshnessReport(registry, {
      root,
      observations,
      refreshReceipt,
      // determinism-lint: allow clock generated production freshness reports record their evaluation instant outside check-only mode
      now: option(argv, "--now", new Date().toISOString()),
      deploymentIdentity: option(argv, "--deployment-identity", process.env.GITHUB_SHA || null),
    });
    if (argv.includes("--write-report")) {
      const output = resolve(root, option(argv, "--report-out", relative(root, REPORT_PATH)));
      writeJson(output, report);
      console.log(`wrote ${relative(root, output)} status=${report.status}`);
    }
    if (argv.includes("--check-production")) {
      const findings = productionFreshnessFindings(report);
      if (findings.length) throw new Error(`first-class production freshness failed:\n${findings.join("\n")}`);
      console.log(`first-class production freshness accepted: ${report.surface_count} artifacts`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(); } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
