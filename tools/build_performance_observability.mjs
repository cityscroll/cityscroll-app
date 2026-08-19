#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REGISTRY = join(ROOT, "architecture/performance-observability.v1.json");
const OUTPUT_PATHS = Object.freeze({
  browser: "site/data/performance-classification-manifest.v1.json",
  worker: "worker/src/data/performance-validation-allowlist.v1.json",
  operator: "worker/src/data/performance-operator-labels.v1.json",
});

const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PRIVATE_BROWSER_KEYS = new Set([
  "operator_label",
  "owner_source_path",
  "architecture_container_ref",
  "definition",
  "reason",
]);
const EXCLUSION_STATES = new Set([
  "not_user_facing",
  "not_performance_relevant",
  "intentionally_unmeasured",
]);
const REQUIRED_PROJECTIONS = ["browser", "operator", "worker"];

function sorted(values) {
  return [...values].sort((left, right) => String(left).localeCompare(String(right)));
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function registryHash(registry) {
  return createHash("sha256").update(canonicalJson(registry)).digest("hex");
}

function registryVersion(registry) {
  return registry.registry_version || registry.catalog_version;
}

function registryMetricIds(registry) {
  if (Array.isArray(registry.metric_ids)) return registry.metric_ids;
  if (Array.isArray(registry.metrics)) return registry.metrics.map((metric) => metric.id);
  return [];
}

function fail(errors, message) {
  errors.push(message);
}

function validateStableId(errors, value, label) {
  if (!ID_RE.test(value || "")) fail(errors, `${label} must be a lowercase kebab-case stable ID`);
  if (String(value || "").length > 64) fail(errors, `${label} must not exceed 64 characters`);
  if (/\d{4,}|[:/?#%]/.test(value || "")) {
    fail(errors, `${label} must not encode a record identifier, URL fragment, or user input`);
  }
}

function canonicalPathname(value) {
  const raw = String(value || "");
  if (!raw.startsWith("/") || raw.includes("?") || raw.includes("#") || raw.includes("//")) return null;
  if (raw === "/") return raw;
  return raw.replace(/\/+$/, "");
}

function matcherShape(matcher) {
  return `${matcher.kind}:${String(matcher.pathname || "").replace(/\{[a-z][a-z0-9-]*\}/g, "{}")}`;
}

function validatePathMatcher(errors, matcher, label) {
  if (!matcher || typeof matcher !== "object" || Array.isArray(matcher)) {
    fail(errors, `${label} must be an object`);
    return;
  }
  if (!["exact", "segment_template"].includes(matcher.kind)) {
    fail(errors, `${label}.kind must be exact or segment_template`);
    return;
  }
  const pathname = canonicalPathname(matcher.pathname);
  if (!pathname || pathname !== matcher.pathname) {
    fail(errors, `${label}.pathname must be a canonical public pathname without query or hash data`);
    return;
  }
  const placeholders = [...pathname.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  if (matcher.kind === "exact" && placeholders.length) {
    fail(errors, `${label} exact matchers cannot contain placeholders`);
  }
  if (matcher.kind === "segment_template") {
    if (!placeholders.length) fail(errors, `${label} segment_template requires a placeholder`);
    if (placeholders.some((placeholder) => !ID_RE.test(placeholder))) {
      fail(errors, `${label} placeholders must be public-safe semantic names`);
    }
    for (const segment of pathname.split("/").filter(Boolean)) {
      if (segment.includes("{") && !/^\{[a-z][a-z0-9-]*\}$/.test(segment)) {
        fail(errors, `${label} placeholders must occupy an entire path segment`);
      }
    }
  }
}

function validateSemanticMatcher(errors, matcher, label) {
  if (!matcher || matcher.kind !== "semantic_marker" || !ID_RE.test(matcher.marker || "")) {
    fail(errors, `${label} must be a public-safe semantic_marker with a stable marker ID`);
  }
}

function entryId(entry) {
  return entry.kind === "surface" ? entry.surface_id : entry.component_id;
}

function validateAliases(errors, entry, label, allCanonicalIds, allAliasIds) {
  if (!Array.isArray(entry.aliases) || !Array.isArray(entry.supersedes)) {
    fail(errors, `${label} aliases and supersedes must be arrays`);
    return;
  }
  const localAliases = new Set();
  for (const [index, alias] of entry.aliases.entries()) {
    const aliasLabel = `${label}.aliases[${index}]`;
    validateStableId(errors, alias?.alias_id, `${aliasLabel}.alias_id`);
    if (allCanonicalIds.has(alias?.alias_id)) fail(errors, `${aliasLabel}.alias_id collides with a canonical ID`);
    if (localAliases.has(alias?.alias_id) || allAliasIds.has(alias?.alias_id)) fail(errors, `${aliasLabel}.alias_id is duplicated`);
    localAliases.add(alias?.alias_id);
    allAliasIds.add(alias?.alias_id);
    if (!VERSION_RE.test(alias?.introduced_version || "") || !VERSION_RE.test(alias?.retired_version || "")) {
      fail(errors, `${aliasLabel} requires semantic introduced_version and retired_version values`);
    }
    if (typeof alias?.reason !== "string" || !alias.reason.trim()) fail(errors, `${aliasLabel}.reason is required`);
  }
  const supersedes = new Set(entry.supersedes);
  if (supersedes.size !== entry.supersedes.length) fail(errors, `${label}.supersedes contains duplicates`);
  for (const historicalId of supersedes) {
    if (!localAliases.has(historicalId)) fail(errors, `${label}.supersedes must reference a declared alias: ${historicalId}`);
  }
}

function validateEntry(errors, registry, entry, index, kind, root, allCanonicalIds, allAliasIds) {
  const collection = kind === "surface" ? "surfaces" : "components";
  const label = `${collection}[${index}]`;
  const id = kind === "surface" ? entry?.surface_id : entry?.component_id;
  if (entry?.kind !== kind && !(kind === "component" && entry?.kind === "interaction")) {
    fail(errors, `${label}.kind must be ${kind === "surface" ? "surface" : "component or interaction"}`);
  }
  validateStableId(errors, id, `${label}.${kind}_id`);
  if (allCanonicalIds.has(id)) fail(errors, `${label} duplicates canonical ID ${id}`);
  allCanonicalIds.add(id);
  if (typeof entry?.operator_label !== "string" || !entry.operator_label.trim() || entry.operator_label.length > 100) {
    fail(errors, `${label}.operator_label is required and must be at most 100 characters`);
  }
  if (entry?.parent !== null && typeof entry?.parent !== "string") fail(errors, `${label}.parent must be null or a typed reference`);
  if (!ID_RE.test(entry?.route_family || "")) fail(errors, `${label}.route_family must be a stable ID`);
  if (!registry.delivery_classes.includes(entry?.delivery_class)) fail(errors, `${label}.delivery_class is not registered`);
  if (!registry.lifecycle_states.includes(entry?.lifecycle_state)) fail(errors, `${label}.lifecycle_state is not registered`);
  if (!VERSION_RE.test(entry?.introduced_version || "")) fail(errors, `${label}.introduced_version must be semantic versioning`);
  if (typeof entry?.owner_source_path !== "string" || entry.owner_source_path.startsWith("/") || !existsSync(join(root, entry.owner_source_path))) {
    fail(errors, `${label}.owner_source_path must name an existing repository-relative path`);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(entry?.architecture_container_ref || "")) {
    fail(errors, `${label}.architecture_container_ref must be a stable C4 container reference`);
  }
  const metricIds = registryMetricIds(registry);
  if (!Array.isArray(entry?.applicable_metric_ids) || entry.applicable_metric_ids.some((metricId) => !metricIds.includes(metricId))) {
    fail(errors, `${label}.applicable_metric_ids must contain only catalog metric IDs`);
  }
  if (!Object.hasOwn(registry.semantic_readiness_contracts, entry?.semantic_readiness_contract)) {
    fail(errors, `${label}.semantic_readiness_contract is not registered`);
  }
  if (EXCLUSION_STATES.has(entry?.lifecycle_state) && (typeof entry?.exclusion_reason !== "string" || !entry.exclusion_reason.trim())) {
    fail(errors, `${label}.exclusion_reason is required for ${entry.lifecycle_state}`);
  }
  if (canonicalJson(sorted(entry?.projections || [])) !== canonicalJson(REQUIRED_PROJECTIONS)) {
    fail(errors, `${label}.projections must opt into browser, worker, and operator projections`);
  }
  if (kind === "surface") {
    if (!Array.isArray(entry?.public_safe_matcher) || !entry.public_safe_matcher.length) {
      fail(errors, `${label}.public_safe_matcher must contain at least one pathname matcher`);
    } else {
      entry.public_safe_matcher.forEach((matcher, matcherIndex) => validatePathMatcher(errors, matcher, `${label}.public_safe_matcher[${matcherIndex}]`));
    }
  } else {
    validateSemanticMatcher(errors, entry?.public_safe_matcher, `${label}.public_safe_matcher`);
  }
  validateAliases(errors, entry, label, allCanonicalIds, allAliasIds);
}

export function validatePerformanceRegistry(registry, { root = ROOT } = {}) {
  const errors = [];
  if (!["cityscroll.performance_observability.registry.v1", "cityscroll.performance_observability.v1"].includes(registry?.schema)) {
    fail(errors, "schema must identify the versioned CityScroll performance observability registry");
  }
  if (!VERSION_RE.test(registryVersion(registry) || "")) fail(errors, "registry/catalog version must use semantic versioning");
  if (!ID_RE.test(registry?.manifest_version || "")) fail(errors, "manifest_version must be a stable ID");
  const collector = registry?.collector_contract;
  if (!collector || !ID_RE.test(collector.collector_version || "")) {
    fail(errors, "collector_contract requires a stable collector_version");
  }
  if (collector?.library_name !== "web-vitals" || collector?.library_build !== "standard" || !VERSION_RE.test(collector?.library_version || "")) {
    fail(errors, "collector_contract requires a pinned standard web-vitals version");
  }
  if (typeof collector?.production_enabled !== "boolean") {
    fail(errors, "collector production_enabled must be an explicit boolean");
  }
  const metricIds = registryMetricIds(registry);
  if (!metricIds.length) fail(errors, "metric catalog must contain at least one metric ID");
  if (new Set(metricIds).size !== metricIds.length) fail(errors, "metric IDs must be unique");
  for (const metricId of metricIds) {
    if (!/^[a-z][a-z0-9_]*$/.test(metricId)) fail(errors, `invalid metric_id ${metricId}`);
  }
  const fieldMetricIds = collector?.field_metric_ids || [];
  const expectedFieldMetricIds = ["cls_score", "fcp_ms", "inp_ms", "lcp_ms", "ttfb_ms"];
  if (canonicalJson(sorted(fieldMetricIds)) !== canonicalJson(expectedFieldMetricIds)) {
    fail(errors, "collector_contract field_metric_ids must contain the five commissioned field vitals");
  }
  if (fieldMetricIds.some((metricId) => !metricIds.includes(metricId))) {
    fail(errors, "collector_contract references a metric outside the catalog");
  }
  for (const [key, expected] of Object.entries({
    device_classes: ["desktop", "mobile", "tablet", "unknown"],
    navigation_types: ["back-forward", "back-forward-cache", "navigate", "prerender", "reload", "restore", "unknown"],
  })) {
    if (canonicalJson(collector?.[key]) !== canonicalJson(expected)) {
      fail(errors, `collector_contract ${key} must stay a closed, ordered enumeration`);
    }
  }
  if (!Array.isArray(registry?.surfaces) || !registry.surfaces.length) fail(errors, "surfaces must be a non-empty array");
  if (!Array.isArray(registry?.components) || !registry.components.length) fail(errors, "components must be a non-empty array");
  if (!registry?.projection_policy || !registry?.semantic_readiness_contracts) fail(errors, "projection policy and semantic readiness contracts are required");
  const allCanonicalIds = new Set();
  const allAliasIds = new Set();
  for (const [index, surface] of (registry?.surfaces || []).entries()) {
    validateEntry(errors, registry, surface, index, "surface", root, allCanonicalIds, allAliasIds);
  }
  for (const [index, component] of (registry?.components || []).entries()) {
    validateEntry(errors, registry, component, index, "component", root, allCanonicalIds, allAliasIds);
  }
  for (const aliasId of allAliasIds) {
    if (allCanonicalIds.has(aliasId)) fail(errors, `alias ${aliasId} collides with a canonical ID`);
  }

  const surfaceIds = new Set((registry?.surfaces || []).map((surface) => surface.surface_id));
  const componentIds = new Set((registry?.components || []).map((component) => component.component_id));
  const validParents = new Set([
    ...(registry?.surfaces || []).map((surface) => `surface:${surface.surface_id}`),
    ...(registry?.components || []).map((component) => `component:${component.component_id}`),
  ]);
  for (const surface of registry?.surfaces || []) {
    if (surface.parent !== null && (!validParents.has(surface.parent) || !surface.parent.startsWith("surface:"))) {
      fail(errors, `surface ${surface.surface_id} has invalid parent ${surface.parent}`);
    }
  }
  for (const component of registry?.components || []) {
    if (!validParents.has(component.parent)) fail(errors, `component ${component.component_id} has invalid parent ${component.parent}`);
  }
  for (const contract of Object.values(registry?.semantic_readiness_contracts || {})) {
    if (!metricIds.includes(contract?.metric_id)) fail(errors, `semantic readiness contract uses unknown metric ${contract?.metric_id}`);
    if (!Array.isArray(contract?.terminal_result_states) || !contract.terminal_result_states.length) fail(errors, "semantic readiness contracts require terminal_result_states");
    if (typeof contract?.definition !== "string" || !contract.definition.trim()) fail(errors, "semantic readiness contracts require a definition");
  }

  const matcherOwners = new Map();
  for (const surface of registry?.surfaces || []) {
    for (const matcher of surface.public_safe_matcher || []) {
      const shape = matcherShape(matcher);
      if (matcherOwners.has(shape)) fail(errors, `route matcher ${shape} is shared by ${matcherOwners.get(shape)} and ${surface.surface_id}`);
      matcherOwners.set(shape, surface.surface_id);
    }
  }
  if (!surfaceIds.size || !componentIds.size) fail(errors, "surface and component identity sets must both be populated");
  if (errors.length) throw new Error(`performance observability registry invalid:\n- ${errors.join("\n- ")}`);
  return registry;
}

function publicAliases(entry) {
  return entry.aliases.map((alias) => ({
    alias_id: alias.alias_id,
    introduced_version: alias.introduced_version,
    retired_version: alias.retired_version,
  })).sort((left, right) => left.alias_id.localeCompare(right.alias_id));
}

function aliasEntries(entries) {
  return sortedObject(entries.flatMap((entry) => entry.aliases.map((alias) => [alias.alias_id, entryId(entry)])));
}

function surfaceAncestor(registry, component) {
  const components = new Map(registry.components.map((entry) => [entry.component_id, entry]));
  let parent = component.parent;
  const seen = new Set();
  while (parent?.startsWith("component:")) {
    const componentId = parent.slice("component:".length);
    if (seen.has(componentId)) throw new Error(`component parent cycle at ${component.component_id}`);
    seen.add(componentId);
    parent = components.get(componentId)?.parent;
  }
  if (!parent?.startsWith("surface:")) throw new Error(`component ${component.component_id} has no surface ancestor`);
  return parent.slice("surface:".length);
}

function surfaceDescendsFrom(surface, ancestorId, surfacesById) {
  let current = surface;
  const seen = new Set();
  while (current) {
    if (current.surface_id === ancestorId) return true;
    if (!current.parent?.startsWith("surface:")) return false;
    if (seen.has(current.surface_id)) throw new Error(`surface parent cycle at ${current.surface_id}`);
    seen.add(current.surface_id);
    current = surfacesById.get(current.parent.slice("surface:".length));
  }
  return false;
}

function componentApplications(registry) {
  const surfacesById = new Map(registry.surfaces.map((surface) => [surface.surface_id, surface]));
  return new Map(registry.components.map((component) => {
    const ancestorId = surfaceAncestor(registry, component);
    const surfaceIds = registry.surfaces
      .filter((surface) => surfaceDescendsFrom(surface, ancestorId, surfacesById))
      .map((surface) => surface.surface_id);
    return [component.component_id, sorted(surfaceIds)];
  }));
}

function browserProjection(registry, hash) {
  return {
    schema: "cityscroll.performance.browser_manifest.v1",
    manifest_version: registry.manifest_version,
    registry_version: registryVersion(registry),
    registry_hash: hash,
    collector: {
      ...registry.collector_contract,
      field_metric_ids: sorted(registry.collector_contract.field_metric_ids),
    },
    metrics: registry.metrics
      .map((metric) => ({
        metric_id: metric.id,
        metric_version: metric.version,
        unit: metric.unit,
      }))
      .sort((left, right) => left.metric_id.localeCompare(right.metric_id)),
    unclassified: {
      classification_state: "unclassified",
      surface_id: null,
      route_family: null,
      delivery_class: null,
    },
    surfaces: registry.surfaces.map((surface) => ({
      surface_id: surface.surface_id,
      kind: surface.kind,
      parent: surface.parent,
      route_family: surface.route_family,
      public_safe_matcher: surface.public_safe_matcher,
      delivery_class: surface.delivery_class,
      applicable_metric_ids: sorted(surface.applicable_metric_ids),
      semantic_readiness_contract: surface.semantic_readiness_contract,
      lifecycle_state: surface.lifecycle_state,
      aliases: publicAliases(surface),
      introduced_version: surface.introduced_version,
    })).sort((left, right) => left.surface_id.localeCompare(right.surface_id)),
    components: registry.components.map((component) => ({
      component_id: component.component_id,
      kind: component.kind,
      parent: component.parent,
      route_family: component.route_family,
      public_safe_matcher: component.public_safe_matcher,
      delivery_class: component.delivery_class,
      applicable_metric_ids: sorted(component.applicable_metric_ids),
      semantic_readiness_contract: component.semantic_readiness_contract,
      lifecycle_state: component.lifecycle_state,
      aliases: publicAliases(component),
      introduced_version: component.introduced_version,
    })).sort((left, right) => left.component_id.localeCompare(right.component_id)),
  };
}

function workerProjection(registry, hash) {
  const applications = componentApplications(registry);
  const terminalStates = sorted(new Set(Object.values(registry.semantic_readiness_contracts)
    .flatMap((contract) => contract.terminal_result_states)));
  const surfaceAliases = aliasEntries(registry.surfaces);
  const componentAliases = aliasEntries(registry.components);
  const surfaceIds = sorted(registry.surfaces.map((surface) => surface.surface_id));
  const componentIds = sorted(registry.components.map((component) => component.component_id));
  return {
    schema: "cityscroll.performance.worker_allowlist.v1",
    manifest_version: registry.manifest_version,
    registry_version: registryVersion(registry),
    registry_hash: hash,
    collector: {
      ...registry.collector_contract,
      field_metric_ids: sorted(registry.collector_contract.field_metric_ids),
    },
    metrics: registry.metrics.map((metric) => ({
      metric_id: metric.id,
      metric_version: metric.version,
      unit: metric.unit,
      minimum: metric.numeric_domain.minimum,
    })).sort((left, right) => left.metric_id.localeCompare(right.metric_id)),
    metric_ids: sorted(registryMetricIds(registry)),
    delivery_classes: sorted(registry.delivery_classes),
    result_states: terminalStates,
    surface_ids: surfaceIds,
    component_ids: ["none", ...componentIds],
    accepted_surface_ids: sorted([...surfaceIds, ...Object.keys(surfaceAliases)]),
    accepted_component_ids: ["none", ...sorted([...componentIds, ...Object.keys(componentAliases)])],
    surface_aliases: surfaceAliases,
    component_aliases: componentAliases,
    surfaces: sortedObject(registry.surfaces.map((surface) => [surface.surface_id, {
      parent: surface.parent,
      delivery_class: surface.delivery_class,
      applicable_metric_ids: sorted(surface.applicable_metric_ids),
      allowed_component_ids: sorted(registry.components
        .filter((component) => applications.get(component.component_id).includes(surface.surface_id))
        .map((component) => component.component_id)),
      lifecycle_state: surface.lifecycle_state,
    }])),
    components: sortedObject(registry.components.map((component) => [component.component_id, {
      kind: component.kind,
      parent: component.parent,
      applicable_surface_ids: applications.get(component.component_id),
      applicable_metric_ids: sorted(component.applicable_metric_ids),
      lifecycle_state: component.lifecycle_state,
    }])),
  };
}

function operatorProjection(registry, hash) {
  const readiness = registry.semantic_readiness_contracts;
  const project = (entry) => ({
    [`${entry.kind === "surface" ? "surface" : "component"}_id`]: entryId(entry),
    operator_label: entry.operator_label,
    kind: entry.kind,
    parent: entry.parent,
    route_family: entry.route_family,
    architecture_container_ref: entry.architecture_container_ref,
    delivery_class: entry.delivery_class,
    applicable_metric_ids: sorted(entry.applicable_metric_ids),
    semantic_readiness: {
      contract_id: entry.semantic_readiness_contract,
      ...readiness[entry.semantic_readiness_contract],
    },
    lifecycle_state: entry.lifecycle_state,
    ...(entry.exclusion_reason ? { exclusion_reason: entry.exclusion_reason } : {}),
    aliases: entry.aliases,
    supersedes: entry.supersedes,
    introduced_version: entry.introduced_version,
    owner_source_path: entry.owner_source_path,
  });
  return {
    schema: "cityscroll.performance.operator_inventory.v1",
    manifest_version: registry.manifest_version,
    registry_version: registryVersion(registry),
    registry_hash: hash,
    surfaces: registry.surfaces.map(project).sort((left, right) => left.surface_id.localeCompare(right.surface_id)),
    components: registry.components.map(project).sort((left, right) => left.component_id.localeCompare(right.component_id)),
  };
}

function assertPublicProjectionSafe(value, path = "browser") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicProjectionSafe(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_BROWSER_KEYS.has(key)) throw new Error(`${path}.${key} is private and cannot enter the browser projection`);
    assertPublicProjectionSafe(child, `${path}.${key}`);
  }
}

export function buildPerformanceObservability(registry, { root = ROOT } = {}) {
  validatePerformanceRegistry(registry, { root });
  const hash = registryHash(registry);
  const projections = {
    browser: browserProjection(registry, hash),
    worker: workerProjection(registry, hash),
    operator: operatorProjection(registry, hash),
  };
  assertPublicProjectionSafe(projections.browser);
  return projections;
}

export function loadPerformanceRegistry(path = DEFAULT_REGISTRY) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function renderProjection(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function projectionOutputs(projections, { root = ROOT } = {}) {
  return Object.entries(OUTPUT_PATHS).map(([name, relativePath]) => [
    join(root, relativePath),
    renderProjection(projections[name]),
  ]);
}

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(argumentValue("--out-root", ROOT));
  const registryPath = resolve(argumentValue("--registry", DEFAULT_REGISTRY));
  const projections = buildPerformanceObservability(loadPerformanceRegistry(registryPath), { root: ROOT });
  const check = process.argv.includes("--check");
  let changed = 0;
  for (const [outputPath, content] of projectionOutputs(projections, { root })) {
    if (existsSync(outputPath) && readFileSync(outputPath, "utf8") === content) continue;
    changed += 1;
    if (!check) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, content);
      console.log("wrote", outputPath);
    }
  }
  if (check && changed) {
    console.error(`${changed} performance observability projection(s) are stale`);
    process.exit(1);
  }
  console.log(check ? "performance observability projections ok" : `performance observability projections built (${changed} changed)`);
}
