/**
 * Compact reader-facing cross-source coverage ledger for a bounded object.
 *
 * This is a lookup-state projection, not a world-absence claim. A checked
 * no-match stays a snapshot miss; stopped, unknown, and incomplete lookups
 * stay unresolved. AP-06 registered-contract coverage is a separate analytical
 * scope and never becomes a citywide rate here.
 */

import { CROSS_SOURCE_EVIDENCE_SOURCE_LABELS } from "./cross_source_evidence_receipt.mjs";
import defaultAboResidual from "./data/abo_award_residual_lookup.json" with { type: "json" };
import defaultSourceCoverage from "../entity_resolution/source_coverage.json" with { type: "json" };

const MEETING_DECLARED_SOURCES = Object.freeze(["city_record", "community_board"]);

export const CROSS_SOURCE_COVERAGE_LEDGER_SCHEMA = "cityscroll.cross_source_coverage_ledger.v1";
export const CROSS_SOURCE_COVERAGE_LEDGER_VERSION = 1;

export const CROSS_SOURCE_COVERAGE_STATES = Object.freeze([
  "corroborated",
  "checked-no-match",
  "not-checked",
  "ambiguous",
  "unavailable",
  "stale",
]);

const STATE_LABELS = Object.freeze({
  corroborated: "Recorded in this source",
  "checked-no-match": "No exact match in this lookup",
  "not-checked": "Lookup not run",
  ambiguous: "Identity is ambiguous",
  unavailable: "Source unavailable",
  stale: "Source snapshot is stale",
});

const NYC_PROCUREMENT_SOURCES = Object.freeze([
  "city_record",
  "passport_public_contracts",
  "passport_public_rfx",
  "checkbook_contracts",
  "checkbook_spending",
  "nys_abo_awards",
]);

const NATIVE_PROCUREMENT_SOURCES = Object.freeze([
  "nys_contract_reporter",
  "mta_current_opportunities",
  "mta_bid_results",
  "mta_annual_contracts",
  "mta_cd_awards",
]);

const CHECKBOOK_SOURCES = new Set(["checkbook_contracts", "checkbook_spending"]);
const STOPPED_BRIDGE = /stopped|below_threshold|not_enabled|held/;

function text(value) {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  return result || null;
}

function lower(value) {
  return text(value)?.toLowerCase() || null;
}

function sourceName(system) {
  return CROSS_SOURCE_EVIDENCE_SOURCE_LABELS[system] || system || "Source";
}

function isNativeProcurement(object, observations = []) {
  const refs = [
    ...(Array.isArray(object?.source_observation_refs) ? object.source_observation_refs : []),
    ...(Array.isArray(observations) ? observations.map((row) => row?.source_system) : []),
  ];
  return refs.some((ref) => NATIVE_PROCUREMENT_SOURCES.includes(String(ref || "").split(":")[0]));
}

function objectSystems(object = {}, observations = []) {
  const systems = new Set();
  for (const ref of Array.isArray(object.source_observation_refs) ? object.source_observation_refs : []) {
    const system = String(ref || "").split(":")[0]?.toLowerCase();
    if (system) systems.add(system);
  }
  const objectId = text(object.procurement_id || object.meeting_id || object.object_ref);
  for (const observation of Array.isArray(observations) ? observations : []) {
    const system = lower(observation?.source_system);
    const ref = text(observation?.source_observation_ref)
      || (system && text(observation?.source_system_id || observation?.source_id)
        ? `${system}:${text(observation.source_system_id || observation.source_id)}`
        : null);
    const tied = (object.source_observation_refs || []).includes(ref)
      || (objectId && (observation?.procurement_id === objectId || observation?.meeting_id === objectId))
      || (object.source_system && system === lower(object.source_system));
    if (system && tied) systems.add(system);
  }
  if (object.source_system) systems.add(lower(object.source_system));
  return systems;
}

function asOfFor(system, object, observations, envelope, inventoryRow) {
  const observation = (Array.isArray(observations) ? observations : []).find((row) =>
    lower(row?.source_system) === system);
  return text(
    observation?.as_of
      || observation?.ingested_at
      || observation?.observed_at
      || envelope?.generated_at
      || inventoryRow?.live_observation?.latest_ingested_at
      || inventoryRow?.live_observation?.measured_at
      || object?.generated_at,
  );
}

function inventoryRow(sourceCoverage, system) {
  const rows = Array.isArray(sourceCoverage?.sources) ? sourceCoverage.sources : [];
  return rows.find((row) => lower(row?.source_system) === system) || null;
}

function envelopeOf(sourceStatus, system) {
  const value = sourceStatus?.[system];
  if (!value) return null;
  if (typeof value === "string") return { source_system: system, status: lower(value) };
  return { ...value, status: lower(value.status) };
}

function lookupOf(lookups, system) {
  const value = lookups?.[system];
  if (!value || typeof value !== "object") return null;
  const state = lower(value.state || value.status);
  const match = lower(value.match);
  if (state === "stopped" || STOPPED_BRIDGE.test(state || "")) {
    return { state: "not-checked", stopped: true, ...value, as_of: text(value.as_of), basis: text(value.basis) };
  }
  if (CROSS_SOURCE_COVERAGE_STATES.includes(state)) {
    return { state, ...value, as_of: text(value.as_of), basis: text(value.basis) };
  }
  if (match === "ambiguous" || state === "needs_review" || state === "ambiguous") {
    return { state: "ambiguous", ...value, as_of: text(value.as_of), basis: text(value.basis) };
  }
  if (match === "none" || state === "checked" || state === "unknown") {
    return { state: "checked-no-match", ...value, as_of: text(value.as_of), basis: text(value.basis) };
  }
  if (match === "exact" || state === "matched" || state === "corroborated") {
    return { state: "corroborated", ...value, as_of: text(value.as_of), basis: text(value.basis) };
  }
  if (value.checked === false || state === "not-checked" || state === "not_checked") {
    return { state: "not-checked", ...value, as_of: text(value.as_of), basis: text(value.basis) };
  }
  return null;
}

function aboLookup(aboResidual) {
  const status = lower(aboResidual?.bridge?.status);
  if (!aboResidual) return null;
  if (status === "accepted") return null;
  if (!status || STOPPED_BRIDGE.test(status) || status === "gap") {
    return {
      state: "not-checked",
      stopped: true,
      as_of: text(aboResidual.observed_at),
      basis: text(aboResidual.bridge?.status),
      population: "fixed ABO residual sample",
      vintage: text(aboResidual.observed_at)?.slice(0, 10),
      denominator: Number.isFinite(Number(aboResidual.bridge?.total)) ? Number(aboResidual.bridge.total) : null,
    };
  }
  return { state: "not-checked", stopped: true, as_of: text(aboResidual.observed_at) };
}

function corroborationState(object) {
  const status = lower(object?.checkbook_corroboration?.status);
  if (!status) return null;
  if (status === "corroborated") return { state: "corroborated", basis: text(object.checkbook_corroboration.join_method) };
  if (status === "needs_review") return { state: "ambiguous", basis: text(object.checkbook_corroboration.join_method) };
  if (status === "unknown" || status === "related_instrument") {
    return { state: "checked-no-match", basis: text(object.checkbook_corroboration.join_method) };
  }
  return null;
}

function crosswalkState(object, crosswalk, system) {
  if (!crosswalk || (system !== "passport_public_contracts" && system !== "checkbook_contracts")) return null;
  const metrics = crosswalk.metrics || {};
  const denominator = Number(metrics.checkbook_contracts || metrics.denominator_count);
  const vintage = text(crosswalk.observed_on || crosswalk.generated_at)?.slice(0, 10);
  const population = text(metrics.denominator) || "bounded Checkbook ↔ PASSPort crosswalk";
  const contractIds = new Set((object?.identity_keys?.contract_ids || [])
    .map((value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "")));
  const pins = new Set((object?.identity_keys?.epins || [])
    .map((value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "")));
  const rows = Array.isArray(crosswalk.rows) ? crosswalk.rows : [];
  const hits = rows.filter((row) => {
    const checkbook = String(row.checkbook_contract_id || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const passport = String(row.passport_contract_id || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const pin = String(row.checkbook_pin || row.passport_epin || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return contractIds.has(checkbook) || contractIds.has(passport) || (pin && pins.has(pin));
  });
  if (!hits.length) return null;
  const matched = hits.some((row) => lower(row.status) === "matched");
  const ambiguous = hits.some((row) => lower(row.status) === "ambiguous");
  const state = matched ? "corroborated" : ambiguous ? "ambiguous" : "checked-no-match";
  return {
    state,
    basis: text(hits[0]?.join_method) || "bounded_crosswalk",
    denominator: Number.isFinite(denominator) ? denominator : null,
    vintage,
    population,
  };
}

function meetingOtherState(object, system) {
  if (!object?.meeting_id) return null;
  const home = lower(object.source_system);
  if (!home || home === system) return null;
  const join = lower(object.join_status || object.meeting_join?.status || object.community_board_source_join?.status);
  if (join === "matched" || join === "official") return { state: "corroborated", basis: "exact_board_date_publisher_identifier" };
  if (join === "ambiguous") return { state: "ambiguous", basis: "exact_board_date_publisher_identifier" };
  if (join === "unknown" || join === "held" || join === "not_applicable") {
    return { state: "not-checked", basis: text(object.join_status) };
  }
  return null;
}

function declaredSources(kind, object, observations) {
  if (kind === "meeting") return [...MEETING_DECLARED_SOURCES];
  if (isNativeProcurement(object, observations)) return [...NATIVE_PROCUREMENT_SOURCES];
  const systems = objectSystems(object, observations);
  const nycPresent = NYC_PROCUREMENT_SOURCES.some((source) => source !== "nys_abo_awards" && systems.has(source));
  if (systems.has("checkbook_nycha_contracts") && !nycPresent) {
    return ["checkbook_nycha_contracts"];
  }
  const declared = [...NYC_PROCUREMENT_SOURCES];
  if (systems.has("checkbook_nycha_contracts")) declared.push("checkbook_nycha_contracts");
  return declared;
}

function classifySource({
  system,
  present,
  envelope,
  inventory,
  lookup,
  corroboration,
  crosswalk,
  meetingJoin,
}) {
  if (lookup?.state) return lookup;
  if (present) return { state: "corroborated" };
  if (envelope?.status === "unavailable") return { state: "unavailable" };
  if (envelope?.status === "stale") return { state: "stale" };
  const live = lower(inventory?.dual_write?.after || inventory?.live_observation?.status);
  if (!present && live === "stale") return { state: "stale" };
  if (!present && (live === "empty-declared-live")) return { state: "unavailable" };
  if (corroboration && CHECKBOOK_SOURCES.has(system)) return corroboration;
  if (crosswalk) return crosswalk;
  if (meetingJoin) return meetingJoin;
  return { state: "not-checked" };
}

/**
 * Project EBCG-01 measured coverage only when a named population and vintage exist.
 * Partial populations stay partial; a missing denominator never becomes a rate.
 */
export function measuredCoverageFromInventory(sourceCoverage) {
  const measurement = sourceCoverage?.measurement;
  const covered = Number(measurement?.after?.covered);
  const total = Number(measurement?.after?.total);
  const vintage = text(measurement?.observed_at);
  const population = text(measurement?.unit);
  if (!Number.isFinite(covered) || !Number.isFinite(total) || total <= 0 || !vintage || !population) {
    return null;
  }
  const partial = Number(measurement?.by_status?.partial) > 0;
  return Object.freeze({
    scope: "source_coverage",
    covered,
    total,
    rate: Number((covered / total).toFixed(4)),
    vintage,
    population,
    partial,
    basis: text(measurement.after?.basis) || text(measurement.basis),
  });
}

function ap06Scope(registeredContractCoverage) {
  if (!registeredContractCoverage || typeof registeredContractCoverage !== "object") return null;
  const exact = Number(registeredContractCoverage.exact ?? registeredContractCoverage.city_record_matched_contract_count);
  const none = Number(registeredContractCoverage.none ?? registeredContractCoverage.city_record_unmatched_contract_count);
  const missingPin = Number(
    registeredContractCoverage.cannot_evaluate_missing_pin
      ?? registeredContractCoverage.city_record_missing_pin_contract_count,
  );
  const denominator = Number(
    registeredContractCoverage.denominator
      ?? registeredContractCoverage.city_record_eligible_contract_count
      ?? registeredContractCoverage.eligible,
  );
  const vintage = text(registeredContractCoverage.vintage || registeredContractCoverage.observed_at);
  const population = text(registeredContractCoverage.population)
    || "registered Checkbook expense contracts";
  if (![exact, none, missingPin, denominator].every(Number.isFinite) || !vintage) return null;
  return Object.freeze({
    scope: "ap06_registered_contracts",
    exact,
    none,
    cannot_evaluate_missing_pin: missingPin,
    denominator,
    vintage,
    population,
    citywide: false,
  });
}

function sourceRow({
  system,
  classification,
  asOf,
  envelope,
  inventory,
}) {
  const vintage = text(classification.vintage) || asOf?.slice(0, 10) || text(inventory?.live_observation?.measured_at)?.slice(0, 10);
  const denominator = Number.isFinite(Number(classification.denominator))
    ? Number(classification.denominator)
    : (Number.isFinite(Number(inventory?.live_observation?.row_count)) && classification.state === "checked-no-match"
      ? Number(inventory.live_observation.row_count)
      : null);
  const population = text(classification.population)
    || (denominator != null ? text(inventory?.id) && `${sourceName(system)} retained observations` : null);
  const unresolved = ["not-checked", "ambiguous", "unavailable", "stale"].includes(classification.state);
  return Object.freeze({
    source_system: system,
    source_name: sourceName(system),
    state: classification.state,
    state_label: STATE_LABELS[classification.state],
    as_of: asOf,
    vintage: vintage || null,
    lookup_basis: text(classification.basis) || null,
    denominator,
    population,
    stopped: Boolean(classification.stopped),
    unresolved,
    envelope_status: envelope?.status || null,
  });
}

/**
 * Build one compact ledger for a procurement or meeting object.
 */
export function buildCrossSourceCoverageLedger({
  object = {},
  observations = [],
  sourceStatus = {},
  sourceCoverage,
  lookups = {},
  aboResidual,
  crosswalk = null,
  registeredContractCoverage = null,
  kind = null,
} = {}) {
  const objectKind = kind
    || (object.meeting_id ? "meeting" : "procurement");
  const objectRef = text(object.procurement_id || object.meeting_id || object.object_ref || object.subject_ref);
  if (!objectRef) return null;
  const coverageInventory = sourceCoverage === undefined && objectKind === "procurement"
    ? defaultSourceCoverage
    : sourceCoverage;
  const residual = aboResidual === undefined && objectKind === "procurement"
    ? defaultAboResidual
    : aboResidual;
  const present = objectSystems(object, observations);
  const corroboration = corroborationState(object);
  const abo = objectKind === "procurement" ? aboLookup(residual) : null;
  const sources = declaredSources(objectKind, object, observations).map((system) => {
    const envelope = envelopeOf(sourceStatus, system);
    const inventory = inventoryRow(coverageInventory, system);
    const explicit = lookupOf(lookups, system)
      || (system === "nys_abo_awards" ? abo : null);
    const classification = classifySource({
      system,
      present: present.has(system) || present.has(system.replace("nys_abo_awards", "abo")),
      envelope,
      inventory,
      lookup: explicit,
      corroboration,
      crosswalk: crosswalkState(object, crosswalk, system),
      meetingJoin: meetingOtherState(object, system),
    });
    return sourceRow({
      system,
      classification,
      asOf: asOfFor(system, object, observations, envelope, inventory),
      envelope,
      inventory,
    });
  });
  if (!sources.length) return null;
  return Object.freeze({
    schema: CROSS_SOURCE_COVERAGE_LEDGER_SCHEMA,
    version: CROSS_SOURCE_COVERAGE_LEDGER_VERSION,
    object_kind: objectKind,
    object_ref: objectRef,
    sources: Object.freeze(sources),
    measured_coverage: measuredCoverageFromInventory(coverageInventory),
    analytical_scopes: Object.freeze({
      ap06_registered_contracts: ap06Scope(registeredContractCoverage),
    }),
  });
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function rateHtml(coverage) {
  if (!coverage || coverage.total == null || !coverage.vintage || !coverage.population) return "";
  const percent = `${(coverage.rate * 100).toFixed(1)}%`;
  const partial = coverage.partial ? " Partial streams remain in the denominator." : "";
  return `<p class="cross-source-coverage-rate" data-coverage-scope="${esc(coverage.scope)}">Importer coverage: ${esc(coverage.covered)} of ${esc(coverage.total)} ${esc(coverage.population)} (${esc(percent)}) as of ${esc(coverage.vintage)}.${esc(partial)}</p>`;
}

function sourceMeta(source) {
  const parts = [
    source.as_of ? `as of ${source.as_of}` : null,
    source.lookup_basis ? `lookup: ${source.lookup_basis}` : null,
    source.denominator != null && source.population
      ? `${source.denominator} in ${source.population}`
      : (source.vintage && source.state === "checked-no-match" ? `vintage ${source.vintage}` : null),
    source.stopped ? "stopped lookup" : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Render a compact object-view ledger. Empty or incomplete input paints nothing. */
export function renderCrossSourceCoverageLedger(ledger) {
  if (!ledger || !Array.isArray(ledger.sources) || !ledger.sources.length) return "";
  const items = ledger.sources.map((source) => {
    const meta = sourceMeta(source);
    return `<li class="cross-source-coverage-source" data-source-system="${esc(source.source_system)}" data-coverage-state="${esc(source.state)}" data-unresolved="${source.unresolved ? "1" : "0"}"><span class="cross-source-coverage-name">${esc(source.source_name)}</span><span class="cross-source-coverage-state">${esc(source.state_label)}</span>${meta ? `<span class="cross-source-coverage-meta">${esc(meta)}</span>` : ""}</li>`;
  }).join("");
  return `<section class="node-section node-card cross-source-coverage-ledger" data-cross-source-coverage-ledger="1" aria-labelledby="cross-source-coverage-heading"><h2 id="cross-source-coverage-heading">Source coverage</h2><p class="cross-source-coverage-lead">Declared publisher lookup state for this record. No exact match is a snapshot miss, not a conclusion that the publisher never issued the record.</p><ul class="cross-source-coverage-sources">${items}</ul>${rateHtml(ledger.measured_coverage)}</section>`;
}

export const CROSS_SOURCE_COVERAGE_STATE_LABELS = STATE_LABELS;
export const NYC_PROCUREMENT_COVERAGE_SOURCES = NYC_PROCUREMENT_SOURCES;
