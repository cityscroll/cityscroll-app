/**
 * Operator exception overview for the authenticated desk.
 *
 * This module does not evaluate health, invent a repair queue, or synthesize
 * cards. It classifies already-projected source state into distinct operator
 * conditions, joins each canonical source only to declared first-class
 * artifacts / routes and to the existing repair-queue identity, and reports
 * three separate denominators so a condition count cannot be read as a source
 * count or a monitoring-gap count.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const OPERATOR_OVERVIEW_SCHEMA = "cityscroll.operator_overview.v1";
export const OPERATOR_OVERVIEW_EXTENSION_VERSION = 1;

export const OPERATOR_CONDITION_IDS = Object.freeze([
  "historical",
  "manual",
  "disabled",
  "candidate",
  "unknown-publisher-timestamp",
  "missing-required-monitoring",
  "failed-acquisition",
  "cadence-noncompliant",
  "fresh-acquisition-stale-serving",
  "eligible-fallback",
  "failed-stage",
  "unknown-dependency",
]);

export const INVENTORY_CONDITIONS = Object.freeze([
  "historical",
  "manual",
  "disabled",
  "candidate",
]);

export const ACTIONABLE_CONDITIONS = Object.freeze([
  "failed-acquisition",
  "failed-stage",
  "missing-required-monitoring",
  "cadence-noncompliant",
  "fresh-acquisition-stale-serving",
  "eligible-fallback",
]);

export const OPERATOR_CONDITION_LABELS = Object.freeze({
  historical: "Historical",
  manual: "Manual",
  disabled: "Disabled",
  candidate: "Candidate",
  "unknown-publisher-timestamp": "Unknown publisher timestamp",
  "missing-required-monitoring": "Missing required monitoring",
  "failed-acquisition": "Failed acquisition",
  "cadence-noncompliant": "Cadence not met",
  "fresh-acquisition-stale-serving": "Fresh acquisition, stale serving",
  "eligible-fallback": "Eligible fallback",
  "failed-stage": "Failed stage",
  "unknown-dependency": "Unverified dependency",
});

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const PUBLIC_REFERENCE = /^https:\/\/[^\s"'<>]+$/;
const PRIVATE_REFERENCE = new RegExp([
  "^(?:file|",
  ["backstage", ""].join(""),
  "):",
  "|^/Users/|^/var/folders/|^/tmp/|^/private/|^[A-Za-z]:\\\\",
  "|^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::|/|$)",
].join(""), "i");

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clean(value, max = 240) {
  if (value == null) return null;
  const out = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return out ? out.slice(0, max) : null;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function validInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const epoch = Date.parse(/T/.test(value) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? `${value}Z` : value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function clockAgeMs(clock, nowMs) {
  if (clock?.state !== "KNOWN" || !clock.at) return null;
  const at = Date.parse(clock.at);
  return Number.isFinite(at) ? nowMs - at : null;
}

function nestedValue(payload, dottedPath) {
  return String(dottedPath || "").split(".").reduce((current, key) => current?.[key], payload);
}

export function publicReference(value) {
  const text = clean(value, 500);
  if (!text) return null;
  if (PRIVATE_REFERENCE.test(text) || !PUBLIC_REFERENCE.test(text)) return null;
  return text;
}

export function readDeclaredArtifactVintage(artifact, root = ROOT) {
  const path = artifact?.public_artifact_path;
  if (!path) {
    return { at: null, state: "UNKNOWN", basis: null, path: null, available: false };
  }
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    return { at: null, state: "UNKNOWN", basis: "artifact-not-materialised", path, available: false };
  }
  try {
    const payload = JSON.parse(readFileSync(absolute, "utf8"));
    for (const field of artifact.vintage_fields || []) {
      const instant = validInstant(nestedValue(payload, field));
      if (instant) return { at: instant, state: "KNOWN", basis: field, path, available: true };
    }
    return { at: null, state: "UNKNOWN", basis: "vintage-fields-absent", path, available: true };
  } catch {
    return { at: null, state: "UNKNOWN", basis: "artifact-unreadable", path, available: false };
  }
}

function declaredCadenceHours(artifacts) {
  const hours = artifacts
    .map((artifact) => Number(artifact?.normal_refresh_cadence_hours))
    .filter((value) => Number.isFinite(value) && value > 0);
  return hours.length ? Math.min(...hours) : null;
}

function servingMaxAgeDays(contract) {
  const serving = Number(contract?.freshness_contract?.serving_max_age_days);
  if (Number.isFinite(serving) && serving > 0) return serving;
  const stale = Number(contract?.freshness_contract?.max_stale_days ?? contract?.max_stale_days);
  return Number.isFinite(stale) && stale > 0 ? stale : null;
}

function productFamily(artifact) {
  const route = (artifact?.primary_routes || []).find((item) => /^\/browse\/[^/]+\//.test(item));
  if (route) {
    const family = route.split("/").filter(Boolean)[1];
    if (family) return family;
  }
  const id = String(artifact?.id || "");
  const dash = id.indexOf("-");
  return dash > 0 ? id.slice(0, dash) : id || null;
}

function reasonCodes(source) {
  return Array.isArray(source?.health?.reason_codes) ? source.health.reason_codes : [];
}

function classifyConditions({ source, contract, artifacts, asOfMs }) {
  const conditions = [];
  const mode = contract?.freshness_contract?.mode || null;
  if (source?.node_class === "candidate-source") conditions.push("candidate");
  if (source?.status === "disabled" || contract?.status === "disabled") conditions.push("disabled");
  if (mode === "historical" || source?.health?.status === "Historical") conditions.push("historical");
  if (mode === "manual-conditional" || source?.status === "manual" || source?.health?.status === "Manual-refresh") {
    conditions.push("manual");
  }

  const publisher = source?.clocks?.publisher_updated;
  if (publisher?.state === "UNKNOWN") conditions.push("unknown-publisher-timestamp");

  const watchdog = source?.freshness_watchdog || {};
  const watchdogReasons = Array.isArray(watchdog.reason_codes) ? watchdog.reason_codes : [];
  if (
    watchdog.status === "STALE"
    || watchdogReasons.includes("monitor-missing")
    || reasonCodes(source).includes("missing-health-observation")
  ) {
    conditions.push("missing-required-monitoring");
  }

  if (reasonCodes(source).includes("acquisition-failed") || reasonCodes(source).includes("acquisition-held")) {
    conditions.push("failed-acquisition");
  }

  const runs = Array.isArray(source?.runs) ? source.runs : [];
  const failedRuns = runs.filter((run) => run.status === "failed");
  const healthyRuns = runs.filter((run) => run.status === "succeeded" || run.status === "ok");
  if (failedRuns.length) conditions.push("failed-stage");

  if (source?.serving_fallback?.active) conditions.push("eligible-fallback");

  const acquisitionAgeMs = clockAgeMs(source?.clocks?.cityscroll_checked_acquired, asOfMs);
  const servingAgeMs = clockAgeMs(source?.clocks?.cityscroll_serving, asOfMs);
  const cadenceHours = declaredCadenceHours(artifacts);
  const servingDays = servingMaxAgeDays(contract);
  const cadenceOverdue = cadenceHours != null && acquisitionAgeMs != null && acquisitionAgeMs > cadenceHours * HOUR_MS;
  const servingWithinTolerance = servingDays != null && servingAgeMs != null && servingAgeMs <= servingDays * DAY_MS;
  const servingUnknown = source?.clocks?.cityscroll_serving?.state !== "KNOWN";
  const servingStale = servingDays != null && servingAgeMs != null && servingAgeMs > servingDays * DAY_MS;
  const acquisitionFresh = cadenceHours != null && acquisitionAgeMs != null && acquisitionAgeMs <= cadenceHours * HOUR_MS;

  if (cadenceOverdue) conditions.push("cadence-noncompliant");
  if ((acquisitionFresh || (acquisitionAgeMs != null && !cadenceOverdue && cadenceHours != null)) && (servingStale || servingUnknown)) {
    if (source?.clocks?.cityscroll_checked_acquired?.state === "KNOWN") {
      conditions.push("fresh-acquisition-stale-serving");
    }
  }

  if (!artifacts.length && source?.node_class === "source-contract") {
    conditions.push("unknown-dependency");
  }

  const unique = OPERATOR_CONDITION_IDS.filter((id) => conditions.includes(id));
  return {
    conditions: unique,
    mode: mode || source?.status || "unknown",
    cadence_hours: cadenceHours,
    serving_max_age_days: servingDays,
    cadence_compliance: cadenceHours == null
      ? "not-declared"
      : acquisitionAgeMs == null
        ? "unknown"
        : cadenceOverdue ? "overdue" : "met",
    served_age: servingUnknown
      ? "unknown"
      : servingWithinTolerance
        ? "within_tolerance"
        : servingStale
          ? "beyond_tolerance"
          : "measured",
    failed_stages: failedRuns.map((run) => ({
      adapter: run.adapter || null,
      at: run.at || null,
      exact_error: run.exact_error || null,
      run_id: run.run_id || null,
    })),
    healthy_siblings: healthyRuns.map((run) => ({
      adapter: run.adapter || null,
      at: run.at || null,
      status: run.status,
    })),
  };
}

function productUses(artifacts, vintageByPath) {
  return artifacts.map((artifact) => {
    const vintage = vintageByPath.get(artifact.public_artifact_path) || {
      at: null,
      state: "UNKNOWN",
      basis: null,
      available: false,
      path: artifact.public_artifact_path,
    };
    return {
      artifact_id: artifact.id,
      public_artifact_path: artifact.public_artifact_path,
      primary_routes: [...(artifact.primary_routes || [])],
      product_family: productFamily(artifact),
      served_vintage: {
        at: vintage.at,
        state: vintage.state,
        basis: vintage.basis,
      },
      evidence_available: vintage.available === true,
      join: "declared-first-class-artifact",
    };
  }).sort((left, right) => compare(left.artifact_id, right.artifact_id));
}

function repairLinks(sourceId, queue) {
  if (queue?.status !== "available") {
    return {
      status: queue?.status || "unavailable",
      groups: [],
    };
  }
  const groups = (queue.issues || [])
    .filter((issue) => issue?.identity?.source_contract_id === sourceId)
    .map((issue) => ({
      issue_key: issue.issue_key,
      state: issue.state,
      condition: issue.identity.condition,
      adapter: issue.identity.adapter,
      affected_scopes: issue.affected_scopes,
      affected_sources: 1,
      owner: {
        source_contract_id: issue.owner?.source_contract_id || sourceId,
        publishers: [...(issue.owner?.publishers || [])],
      },
      engineering_card: publicReference(issue.engineering_card?.reference)
        ? {
          reference: publicReference(issue.engineering_card.reference),
          label: issue.engineering_card.label || issue.engineering_card.reference,
        }
        : null,
      resolution_receipt: issue.resolution_receipt
        ? {
          at: issue.resolution_receipt.at || null,
          outcome: issue.resolution_receipt.outcome || null,
          reference: publicReference(issue.resolution_receipt.reference),
        }
        : null,
      original_evidence: issue.original_evidence || null,
    }));
  return { status: "available", groups };
}

export function buildOperatorOverview({
  sources = [],
  contracts = [],
  firstClassArtifacts = [],
  repairQueue = { status: "unavailable", issues: [] },
  asOf = null,
  healthIngestion = { available: true, reason: null, missing_inputs: [] },
  artifactVintageByPath = null,
  root = ROOT,
} = {}) {
  const ingestion = {
    available: healthIngestion?.available === true,
    reason: healthIngestion?.available === true
      ? null
      : clean(healthIngestion?.reason, 300) || "source health observations were not read",
    missing_inputs: [...new Set((Array.isArray(healthIngestion?.missing_inputs) ? healthIngestion.missing_inputs : [])
      .map((path) => clean(path, 300))
      .filter(Boolean))].sort(),
  };

  if (!ingestion.available) {
    return {
      schema: OPERATOR_OVERVIEW_SCHEMA,
      status: "unavailable",
      visibility: "private",
      consumer: "authenticated desk",
      observed_at: validInstant(asOf),
      ingestion,
      condition_ids: OPERATOR_CONDITION_IDS,
      denominators: {
        actionable_conditions: null,
        affected_sources: null,
        insufficient_monitoring: null,
        definition: {
          actionable_conditions: "Distinct actionable condition identifiers present in the measured set.",
          affected_sources: "Distinct canonical sources carrying at least one actionable condition.",
          insufficient_monitoring: "Distinct canonical sources missing required monitoring evidence.",
        },
      },
      all_clear: false,
      rows: [],
    };
  }

  const nowMs = Date.parse(validInstant(asOf) || new Date().toISOString());
  const contractById = new Map((contracts || []).map((contract) => [contract.id, contract]));
  const artifactsBySource = new Map();
  for (const artifact of firstClassArtifacts || []) {
    const id = artifact?.source_contract_id;
    if (!id) continue;
    if (!artifactsBySource.has(id)) artifactsBySource.set(id, []);
    artifactsBySource.get(id).push(artifact);
  }

  const vintageByPath = artifactVintageByPath || new Map();
  if (!artifactVintageByPath) {
    for (const artifact of firstClassArtifacts || []) {
      if (!artifact?.public_artifact_path) continue;
      vintageByPath.set(artifact.public_artifact_path, readDeclaredArtifactVintage(artifact, root));
    }
  }

  const rows = (sources || []).map((source) => {
    const contract = contractById.get(source.id) || null;
    const artifacts = artifactsBySource.get(source.id) || [];
    const classified = classifyConditions({ source, contract, artifacts, asOfMs: nowMs });
    const uses = productUses(artifacts, vintageByPath);
    const servedVintage = uses.find((item) => item.served_vintage.state === "KNOWN")?.served_vintage
      || {
        at: source?.clocks?.cityscroll_serving?.at || null,
        state: source?.clocks?.cityscroll_serving?.state || "UNKNOWN",
        basis: source?.clocks?.cityscroll_serving?.basis || null,
      };
    const repair = repairLinks(source.id, repairQueue);
    const primary = classified.conditions.find((id) => ACTIONABLE_CONDITIONS.includes(id))
      || classified.conditions[0]
      || null;
    return {
      source_id: source.id,
      name: source.name,
      node_class: source.node_class,
      publisher: source.body,
      mode: classified.mode,
      interval: classified.cadence_hours == null
        ? "Not declared"
        : `${classified.cadence_hours}-hour declared cadence`,
      last_success: source?.clocks?.cityscroll_checked_acquired || { at: null, state: "UNKNOWN", basis: null },
      served_vintage: servedVintage,
      cadence_compliance: classified.cadence_compliance,
      served_age: classified.served_age,
      serving_max_age_days: classified.serving_max_age_days,
      conditions: classified.conditions,
      primary_condition: primary,
      product_uses: uses,
      product_families: [...new Set(uses.map((item) => item.product_family).filter(Boolean))].sort(),
      dependency_edge: artifacts.length ? "declared" : "unverified",
      failed_stages: classified.failed_stages,
      healthy_siblings: classified.healthy_siblings,
      repair,
      repair_state: repair.groups[0]?.state || (repair.status === "available" ? "none" : "unavailable"),
    };
  }).sort((left, right) => {
    const leftAction = left.conditions.some((id) => ACTIONABLE_CONDITIONS.includes(id)) ? 0 : 1;
    const rightAction = right.conditions.some((id) => ACTIONABLE_CONDITIONS.includes(id)) ? 0 : 1;
    return leftAction - rightAction
      || compare(left.primary_condition || "", right.primary_condition || "")
      || compare(left.name || "", right.name || "")
      || compare(left.source_id, right.source_id);
  });

  const countable = rows.filter((row) => (
    row.node_class === "source-contract"
    && !row.conditions.includes("historical")
    && !row.conditions.includes("manual")
    && !row.conditions.includes("disabled")
    && !row.conditions.includes("candidate")
  ));
  const actionableIds = new Set();
  const affected = new Set();
  const insufficient = new Set();
  for (const row of countable) {
    for (const condition of row.conditions) {
      if (ACTIONABLE_CONDITIONS.includes(condition)) {
        actionableIds.add(condition);
        affected.add(row.source_id);
      }
      if (condition === "missing-required-monitoring") insufficient.add(row.source_id);
    }
  }

  return {
    schema: OPERATOR_OVERVIEW_SCHEMA,
    status: "available",
    visibility: "private",
    consumer: "authenticated desk",
    observed_at: validInstant(asOf),
    ingestion,
    condition_ids: OPERATOR_CONDITION_IDS,
    denominators: {
      actionable_conditions: actionableIds.size,
      affected_sources: affected.size,
      insufficient_monitoring: insufficient.size,
      definition: {
        actionable_conditions: "Distinct actionable condition identifiers present in the measured set.",
        affected_sources: "Distinct canonical sources carrying at least one actionable condition.",
        insufficient_monitoring: "Distinct canonical sources missing required monitoring evidence.",
      },
    },
    all_clear: false,
    rows,
  };
}

function productCell(row) {
  if (row.dependency_edge === "unverified") {
    return `<span data-dependency="unverified">Unverified — no declared artifact</span>`;
  }
  if (!row.product_uses.length) return "None declared";
  return row.product_uses.map((use) => {
    const routes = (use.primary_routes || [])
      .map((route) => `<a href="${esc(route)}" data-product-route="${esc(route)}">${esc(route)}</a>`)
      .join(" ");
    return `<div class="overview-use"><code>${esc(use.artifact_id)}</code><small>${esc(use.public_artifact_path)}</small>${routes}</div>`;
  }).join("");
}

function repairCell(row) {
  if (row.repair.status !== "available") {
    return `<span data-repair-state="unavailable">Repair state unavailable</span>`;
  }
  if (!row.repair.groups.length) return `<span data-repair-state="none">No repair group</span>`;
  return row.repair.groups.map((group) => {
    const card = group.engineering_card
      ? `<a href="${esc(group.engineering_card.reference)}" target="_blank" rel="noopener noreferrer">${esc(group.engineering_card.label)}</a>`
      : "No existing record";
    return `<div class="overview-repair" data-linked-repair="${esc(group.issue_key)}" data-linked-repair-state="${esc(group.state)}">${esc(OPERATOR_CONDITION_LABELS[group.condition] || group.condition)} · ${esc(group.state)} · ${group.affected_scopes} affected scope${group.affected_scopes === 1 ? "" : "s"}<small>${card}</small></div>`;
  }).join("");
}

function clockCell(clock) {
  if (!clock || clock.state !== "KNOWN" || !clock.at) return "UNKNOWN";
  return esc(clock.at);
}

export function renderOperatorOverviewSection(overview) {
  if (overview?.status !== "available") {
    const missing = overview?.ingestion?.missing_inputs?.length
      ? `<ul>${overview.ingestion.missing_inputs.map((path) => `<li><code>${esc(path)}</code></li>`).join("")}</ul>`
      : "";
    return `<section class="overview-view" id="overviewView" aria-labelledby="overviewHeading">
  <h2 id="overviewHeading">Source health</h2>
  <div class="queue-unavailable" role="status" data-overview-status="unavailable"><strong>Exception overview unavailable.</strong> ${esc(overview?.ingestion?.reason || "source health observations were not read")}. This is not an all-clear: no condition was evaluated in this pass.${missing}</div>
</section>`;
  }

  const d = overview.denominators;
  const publishers = [...new Set(overview.rows.map((row) => row.publisher).filter(Boolean))].sort();
  const families = [...new Set(overview.rows.flatMap((row) => row.product_families))].sort();
  const modes = [...new Set(overview.rows.map((row) => row.mode).filter(Boolean))].sort();
  const publisherOptions = publishers.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
  const productOptions = families.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
  const conditionOptions = OPERATOR_CONDITION_IDS
    .map((id) => `<option value="${esc(id)}">${esc(OPERATOR_CONDITION_LABELS[id])}</option>`).join("");
  const modeOptions = modes.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");

  const rows = overview.rows.map((row) => {
    const search = [
      row.name, row.source_id, row.publisher, row.mode, row.interval, row.repair_state,
      ...row.conditions, ...row.product_families, ...row.product_uses.map((item) => item.artifact_id),
    ].join(" ").toLowerCase();
    const conditionLabel = row.conditions.length
      ? row.conditions.map((id) => OPERATOR_CONDITION_LABELS[id] || id).join(" · ")
      : "None recorded";
    return `<tr id="overview-source-${esc(row.source_id)}" data-overview-row="${esc(row.source_id)}" data-search="${esc(search)}" data-publisher="${esc(row.publisher || "")}" data-product="${esc(row.product_families.join(" "))}" data-condition="${esc(row.conditions.join(" "))}" data-mode="${esc(row.mode || "")}" data-cadence="${esc(row.cadence_compliance)}" data-served-age="${esc(row.served_age)}" data-dependency="${esc(row.dependency_edge)}">
    <th scope="row"><a class="overview-source table-source" href="?source=${esc(row.source_id)}#source-${esc(row.source_id)}" data-source="${esc(row.source_id)}">${esc(row.name)}</a><small>${esc(row.source_id)}</small></th>
    <td>${productCell(row)}</td>
    <td>${esc(row.interval)}<small>cadence ${esc(row.cadence_compliance)}</small></td>
    <td>${clockCell(row.last_success)}</td>
    <td>${row.served_vintage?.state === "KNOWN" ? esc(row.served_vintage.at) : "UNKNOWN"}<small>served age ${esc(row.served_age)}${row.serving_max_age_days != null ? ` · tolerance ${esc(row.serving_max_age_days)} days` : ""}</small></td>
    <td>${esc(conditionLabel)}</td>
    <td>${repairCell(row)}</td>
  </tr>`;
  }).join("\n");

  return `<section class="overview-view" id="overviewView" aria-labelledby="overviewHeading">
  <div id="glanceView">
  <h2 id="overviewHeading">Source health</h2>
  <p class="queue-lede">Monitoring and publication status first, then the conditions that need attention. Cadence compliance is independent of a tolerated served age. Inventory modes (historical, manual, disabled, candidate) stay distinct from failures.</p>
  <div class="meta" data-overview-status="available">
    <span class="pill" data-denominator="actionable-conditions">${d.actionable_conditions} actionable condition${d.actionable_conditions === 1 ? "" : "s"}</span>
    <span class="pill" data-denominator="affected-sources">${d.affected_sources} affected source${d.affected_sources === 1 ? "" : "s"}</span>
    <span class="pill" data-denominator="insufficient-monitoring">${d.insufficient_monitoring} insufficient monitoring</span>
    <span class="pill">Observed ${esc(overview.observed_at || "not recorded")}</span>
  </div>
  <div class="controls overview-filters">
    <label for="productFilter">Product</label>
    <select id="productFilter"><option value="">All products</option>${productOptions}</select>
    <label for="publisherFilter">Publisher</label>
    <select id="publisherFilter"><option value="">All publishers</option>${publisherOptions}</select>
    <label for="conditionFilter">Condition</label>
    <select id="conditionFilter"><option value="">All conditions</option>${conditionOptions}</select>
    <label for="modeFilter">Mode</label>
    <select id="modeFilter"><option value="">All modes</option>${modeOptions}</select>
  </div>
  <div class="overview-table-wrap" tabindex="0" role="region" aria-label="Exception table">
    <table>
      <thead><tr><th>Source</th><th>Product uses</th><th>Interval</th><th>Last success</th><th>Served vintage</th><th>Condition</th><th>Repair state</th></tr></thead>
      <tbody id="overviewBody">
${rows}
      </tbody>
    </table>
  </div>
  </div>
</section>`;
}
