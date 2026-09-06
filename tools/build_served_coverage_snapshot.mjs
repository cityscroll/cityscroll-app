#!/usr/bin/env node

/**
 * Served-product coverage snapshot.
 *
 * The Stats page used to stand in for the product with two numbers: an upstream notice
 * aggregate fetched from the publisher at request time, and a hardcoded list of six source
 * systems. Neither measured what CityScroll actually serves. This builder replaces both with
 * a materialised measurement of the served population: for each selected served consumer, the
 * canonical source-qualified records that consumer actually publishes, counted with that
 * consumer's own record identity, dated from that consumer's own evidence.
 *
 * Two artifacts come out of one pass:
 *
 *   site/data/served_coverage_snapshot.json   the closed public contract the Stats page and
 *                                             GET /stats both read. It carries translation
 *                                             keys, never rendered prose, and no receipt paths.
 *   docs/evidence/served-coverage/census.json the full disposition census: every contract in
 *                                             the source registry, its disposition, and the
 *                                             evidence behind it.
 *
 * Invariants:
 *   - No clock, no network, no randomness. Rebuilding with unchanged evidence produces byte
 *     identical output, so an evidence vintage cannot move because a build ran.
 *   - A unit's vintage comes from its own declared vintage field. When that field carries more
 *     than one instant (a composite of several inputs) the OLDEST instant wins: a coverage
 *     claim is never fresher than the least current evidence behind it.
 *   - A unit whose artifact or vintage cannot be resolved keeps the last verified value and
 *     date already committed in the snapshot, marked as retained. It never publishes zero and
 *     never inherits a newer date.
 *   - Counts are never summed across units. Different consumers count different things.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readProcurementBrowsePopulation } from "./lib/procurement_browse_population_io.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT_SCHEMA = "cityscroll.served_coverage_snapshot.v1";
export const CENSUS_SCHEMA = "cityscroll.served_coverage_census.v1";

/** The registry size this census was reviewed against. A change is reported, never absorbed. */
export const REVIEWED_REGISTRY_SIZE = 63;

export { SERVED_UNITS, DECLARED_DISPOSITIONS };

export const DISPOSITIONS = Object.freeze([
  "publicly_represented",
  "context_only",
  "not_served",
  "unresolved",
]);

export const UNIT_STATES = Object.freeze([
  "measured",
  "observed_zero",
  "retained",
  "unavailable",
]);

/**
 * Served consumers, deliberately selected. Each entry names one served population a reader can
 * reach, the record unit it counts, and the rule it counts by. Two representations of the same
 * population (a row set and its bounded query index) appear once, not twice.
 */
const SERVED_UNITS = Object.freeze([
  {
    unit_id: "procurement-records",
    artifact_id: "contracts-procurement-rows",
    record_unit_key: "coverage_record_procurement",
    counting_rule_key: "coverage_rule_canonical",
    route: "/browse/contracts/",
    source_breakdown: true,
  },
  {
    unit_id: "registered-contracts",
    artifact_id: "contracts-registered",
    record_unit_key: "coverage_record_contract",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/contracts/",
  },
  {
    unit_id: "contract-payments",
    artifact_id: "contracts-payments",
    record_unit_key: "coverage_record_payment",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/contracts/",
  },
  {
    unit_id: "contract-awards",
    artifact_id: "ocp-awards",
    record_unit_key: "coverage_record_award",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/contracts/",
  },
  {
    unit_id: "public-meetings",
    artifact_id: "shared-meetings",
    record_unit_key: "coverage_record_meeting",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/meetings/",
  },
  {
    unit_id: "board-meetings",
    artifact_id: "community-board-meetings",
    record_unit_key: "coverage_record_meeting",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/meetings/",
  },
  {
    unit_id: "meeting-outcomes",
    artifact_id: "meeting-outcomes",
    record_unit_key: "coverage_record_meeting_outcome",
    counting_rule_key: "coverage_rule_present_only",
    route: "/browse/meetings/",
    present_only: { total_field: "record_count", present_field: "present_count" },
  },
  {
    unit_id: "officials",
    artifact_id: "person-hub",
    record_unit_key: "coverage_record_official",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/people/",
  },
  {
    unit_id: "organizations",
    artifact_id: "people-organizations",
    record_unit_key: "coverage_record_organization",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/people/",
  },
  {
    unit_id: "committee-memberships",
    artifact_id: "committee-graph",
    record_unit_key: "coverage_record_membership",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/people/",
  },
  {
    unit_id: "agencies",
    artifact_id: "agency-constellation",
    record_unit_key: "coverage_record_agency",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/people/",
  },
  {
    unit_id: "land-projects",
    artifact_id: "zap-projects",
    record_unit_key: "coverage_record_project",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/zoning/",
  },
  {
    unit_id: "land-hearings",
    artifact_id: "land-upcoming-hearings",
    record_unit_key: "coverage_record_hearing",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/zoning/",
  },
  {
    unit_id: "properties",
    artifact_id: "property-domain",
    record_unit_key: "coverage_record_property",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/property/",
  },
  {
    unit_id: "rules",
    artifact_id: "rules-domain",
    record_unit_key: "coverage_record_rule",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/rules/",
  },
  {
    unit_id: "staffing-notices",
    artifact_id: "staffing-hires",
    record_unit_key: "coverage_record_notice",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/staffing/",
  },
  {
    unit_id: "exams",
    artifact_id: "staffing-exams",
    record_unit_key: "coverage_record_exam",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/exams/",
  },
  {
    unit_id: "agency-obligations",
    artifact_id: "agency-obligations",
    record_unit_key: "coverage_record_obligation",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/",
  },
  {
    unit_id: "community-boards",
    artifact_id: "community-board-geography",
    record_unit_key: "coverage_record_board",
    counting_rule_key: "coverage_rule_declared",
    route: "/browse/",
  },
]);

/** Route to domain grouping, in most-specific-first order. */
const DOMAINS = Object.freeze([
  { domain_id: "contracts", route: "/browse/contracts/" },
  { domain_id: "meetings", route: "/browse/meetings/" },
  { domain_id: "people", route: "/browse/people/" },
  { domain_id: "zoning", route: "/browse/zoning/" },
  { domain_id: "property", route: "/browse/property/" },
  { domain_id: "rules", route: "/browse/rules/" },
  { domain_id: "staffing", route: "/browse/staffing/" },
  { domain_id: "exams", route: "/browse/exams/" },
  { domain_id: "citywide", route: "/browse/" },
]);

/**
 * Served source systems in the shared procurement population, mapped to their registered
 * source contract. A served system with no registered contract is reported, never dropped.
 */
const PROCUREMENT_SOURCE_CONTRACTS = Object.freeze({
  city_record: "city-record",
  passport_public_contracts: "passport-public-contracts",
  passport_public_rfx: "passport-public-rfx",
  checkbook_contracts: "checkbook-contracts",
  checkbook_nycha_contracts: "checkbook-nycha-contracts",
  checkbook_spending: "checkbook-spending",
  nys_contract_reporter: "nys-contract-reporter",
  mta_current_opportunities: "mta-current-opportunities",
  mta_bid_results: "mta-bid-results",
  mta_annual_contracts: null,
  mta_cd_awards: null,
});

/**
 * Reviewed dispositions for registered contracts that no selected served unit counts. Every
 * entry states why. Mechanically derived dispositions are not listed here; a contract that is
 * neither derived nor declared fails the build rather than defaulting to a flattering answer.
 */
const DECLARED_DISPOSITIONS = Object.freeze({
  "abo-local-authorities": ["context_only", "Authority-scoped award context on mapped authority profiles; the awards themselves are counted in the procurement population, so a separate count would restate the same records."],
  "abo-local-development-corporations": ["context_only", "Authority-scoped award context on mapped local-development-corporation profiles; no independent served record population."],
  "abo-state-authorities": ["context_only", "Authority-scoped award context on mapped state-authority profiles; no independent served record population."],
  "active-civil-service-list": ["unresolved", "Serves aggregate list depth on exam cards through a live-only read; no committed served population artifact establishes a count."],
  "bid-tabulations-historical": ["not_served", "Registry status is disabled and the contract records no current product output; the measured join fell below the materialization threshold."],
  "business-improvement-district-boundaries": ["not_served", "Backstage ingestion and overlap quality assurance only; the registry states no resident-facing filter or relationship is published."],
  "capital-projects": ["not_served", "Registry status is disabled and the contract records no current product output."],
  "capital-projects-dashboard": ["unresolved", "Committed procurement-planning rows exist, but no first-class served-population artifact declares this contract as its source, so no served count is established."],
  "cfb-campaign-contributions": ["context_only", "Contribution edges shown on official profiles; officials are counted once as their own record unit."],
  "city-clerk-elobbyist": ["context_only", "Lobbying edges shown on official profiles; officials are counted once as their own record unit."],
  "city-council-committee-membership": ["context_only", "Committee membership evidence on official profiles; the served membership population is counted once from the committee graph."],
  "city-council-district-boundaries": ["context_only", "Resolves council districts for geocoded pins and location filters; a boundary is not a served record unit."],
  "city-council-meetings-open-data": ["not_served", "Registry status is disabled and the contract records no current product output for modern notice detail."],
  "citywide-payroll": ["unresolved", "Serves title and pay history in the staffing experience, but no first-class served-population artifact declares this contract as its source, so no served count is established."],
  "civil-service-list-certification": ["context_only", "Certification edges between exams and agency identities; exams are counted once as their own record unit."],
  "civil-service-titles": ["context_only", "Canonical title-code identities backing the alias registry; an identity registry is not a served record unit."],
  "dcas-annual-exam-outcomes": ["context_only", "Aggregate post-cycle outcomes joined onto exam cards; exams are counted once as their own record unit."],
  "dcas-eligible-list-utilization": ["context_only", "List utilization evidence on exam cards and exam documents; exams are counted once as their own record unit."],
  "dcas-exam-notices": ["context_only", "Application windows, fees and notice links shown on exam cards; exams are counted once as their own record unit."],
  "dcas-vehicle-auction-list": ["unresolved", "Serves the property open-now surface, but its rows are deliberately excluded from parcel chains and map counts and no first-class served-population artifact declares it, so no served count is established."],
  "dcp-nta2020-boundaries": ["not_served", "Backstage ingestion and crosswalk quality assurance only; the registry states this is not a resident-facing identity or filter."],
  "dcp-police-precinct-boundaries": ["not_served", "Backstage ingestion and point-resolution canaries only; the registry states no resident-facing scope or filter is enabled."],
  "dob-certificate-of-occupancy": ["context_only", "Certificate evidence inside the observed parcel biography; properties are counted once as their own record unit."],
  "dob-now-job-filings": ["context_only", "Current demolition-filing verification against an already served record; no independent served record population."],
  "dof-tax-lien-sale-lists": ["context_only", "Per-parcel lien progression and cycle rates shown on property surfaces; properties are counted once as their own record unit."],
  "doing-business-entities": ["context_only", "Vendor identity enrichment on vendor profiles; vendors appear through the procurement records already counted."],
  "dsny-district-boundaries": ["not_served", "Backstage ingestion and congruence drift measurement only; no resident-facing scope is published."],
  "expense-budget": ["context_only", "Agency budget codes and adopted totals used as agency context; agencies are counted once as their own record unit."],
  "ibo-fiscal-history": ["context_only", "Fiscal-year expenditure and staffing context inside the agency fiscal projection. The registry records this source as a family of two component workbooks; a component artifact is not a searchable source, and the family is not two."],
  "legacy-dob-job-filings": ["context_only", "Legacy demolition-filing verification against an already served record; no independent served record population."],
  "mandatory-inclusionary-housing": ["context_only", "Housing status evidence on land-use projects; projects are counted once as their own record unit."],
  "mappluto": ["context_only", "Tax-lot attribution and bounded parcel geometry behind property and land surfaces; a parcel reference layer is not a served record unit."],
  "mocs-ll1-plans": ["unresolved", "Committed procurement-planning rows exist, but no first-class served-population artifact declares this contract as its source, so no served count is established."],
  "mocs-ll63-plans": ["unresolved", "Committed procurement-planning rows exist, but no first-class served-population artifact declares this contract as its source, so no served count is established."],
  "nyc-geosearch": ["context_only", "Build-time geocoding of bounded snapshots; a geocoder is not a served record unit."],
  "nyc-jobs-postings": ["context_only", "Title-code aliases and agency observations for coverage measurement; no independent served record population."],
  "nyc-property-address-directory": ["context_only", "Address to parcel resolution without request-time publisher calls; an address directory is not a served record unit."],
  "nyc-rules-rss": ["context_only", "Rule lifecycle enrichment joined to already served rule records; rules are counted once as their own record unit."],
  "nycida-build-nyc-projects": ["unresolved", "Serves a separate subsidy timeline reader, but no first-class served-population artifact declares this contract as its source, so no served count is established."],
  "ocp-current-solicitations": ["context_only", "Solicitation-stage enrichment joined to already served procurement records."],
  "suitability-city-owned-leased-property-ll48": ["context_only", "Suitability evidence on property parcel biographies; properties are counted once as their own record unit."],
  "ulurp-recommendation-pdfs": ["unresolved", "Serves the land recommendation panel behind a usefulness gate, but no first-class served-population artifact declares this contract as its source."],
  "ulurp-recommendations": ["unresolved", "Serves the land recommendation panel behind a usefulness gate, but no first-class served-population artifact declares this contract as its source."],
  "zap-bbl": ["context_only", "Tax-lot joins from land-use projects to parcels; projects and properties are each counted once as their own record unit."],
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function valueAt(value, dottedPath) {
  return String(dottedPath || "").split(".").reduce((current, key) => current?.[key], value);
}

/** Every instant embedded in a field value, oldest first. A composite field yields several. */
function instantsIn(value) {
  if (typeof value !== "string") return [];
  const candidates = value.match(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g) || [];
  const instants = candidates
    .map((candidate) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(candidate) ? `${candidate}T00:00:00.000Z` : candidate))
    .filter(Number.isFinite);
  return [...new Set(instants)].sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
}

/**
 * Resolve a served artifact's own evidence vintage. Fields are tried in declared order, as the
 * first-class refresh contract does. A field holding several instants is a composite of several
 * inputs, and the oldest of them bounds what the coverage claim may assert.
 */
export function resolveVintage(payload, fields) {
  for (const field of fields || []) {
    const instants = instantsIn(valueAt(payload, field));
    if (!instants.length) continue;
    return {
      at: instants[0],
      field,
      basis: instants.length > 1 ? "composite_oldest" : "single",
    };
  }
  return { at: null, field: null, basis: "unresolved" };
}

/** Population size under the artifact's declared population fields, in declared order. */
export function resolvePopulation(payload, fields) {
  for (const field of fields || []) {
    const value = valueAt(payload, field);
    if (Array.isArray(value)) return { count: value.length, field };
    if (value !== null && value !== "" && Number.isFinite(Number(value))) return { count: Number(value), field };
    if (value && typeof value === "object") return { count: Object.keys(value).length, field };
  }
  return { count: null, field: null };
}

/**
 * Source-qualified observation counts over the served procurement population, counted from the
 * rows the browse consumer actually publishes rather than from the declared input coverage
 * block. The two differ whenever selection drops an input row, and the served figure is the
 * one a reader can retrieve.
 */
export function censusProcurementSources(population) {
  const rows = Array.isArray(population?.rows) ? population.rows : [];
  const counts = new Map();
  const specimens = new Map();
  for (const row of rows) {
    const seen = new Set();
    for (const reference of row?.source_observation_refs || []) {
      const system = String(reference).split(":", 1)[0];
      if (!system || seen.has(system)) continue;
      seen.add(system);
      counts.set(system, (counts.get(system) || 0) + 1);
      if (!specimens.has(system)) {
        specimens.set(system, {
          source_observation_ref: String(reference),
          procurement_id: row.procurement_id || null,
          canonical_route: row.canonical_href || null,
        });
      }
    }
  }
  const declared = population?.coverage && typeof population.coverage === "object" ? population.coverage : {};
  const systems = [...new Set([...Object.keys(declared), ...counts.keys()])].sort();
  return systems.map((system) => ({
    source_system: system,
    source_contract_id: Object.hasOwn(PROCUREMENT_SOURCE_CONTRACTS, system)
      ? PROCUREMENT_SOURCE_CONTRACTS[system]
      : null,
    registered: Object.hasOwn(PROCUREMENT_SOURCE_CONTRACTS, system),
    served_observations: counts.get(system) || 0,
    declared_input_rows: Number.isFinite(Number(declared[system]?.source_row_count))
      ? Number(declared[system].source_row_count)
      : null,
    specimen: specimens.get(system) || null,
  }));
}

function domainForRoute(route) {
  return (DOMAINS.find((domain) => domain.route === route) || DOMAINS[DOMAINS.length - 1]).domain_id;
}

function previousUnits(previousSnapshot) {
  const index = new Map();
  for (const domain of previousSnapshot?.domains || []) {
    for (const unit of domain.units || []) index.set(unit.unit_id, unit);
  }
  return index;
}

/**
 * Build both artifacts from committed evidence. `previousSnapshot` supplies the last verified
 * value for a unit whose evidence has gone missing, so a failed refresh degrades to the older
 * verified figure and its real date rather than to zero or to a fresh-looking one.
 */
export function buildServedCoverage({ root = ROOT, previousSnapshot = null, units: declarations = SERVED_UNITS } = {}) {
  const registry = readJson(join(root, "site/data/source_contracts.json"));
  const contracts = registry.contracts || [];
  const artifacts = new Map((registry.first_class_artifacts || []).map((entry) => [entry.id, entry]));
  const retained = previousUnits(previousSnapshot);

  const procurementPath = join(root, "site/data/procurement_browse_rows.json");
  const procurementSources = existsSync(procurementPath)
    ? censusProcurementSources(readProcurementBrowsePopulation(procurementPath))
    : [];

  const representedSources = new Set();
  const units = [];
  const unitEvidence = [];

  for (const declaration of declarations) {
    const artifact = artifacts.get(declaration.artifact_id);
    if (!artifact) throw new Error(`served unit ${declaration.unit_id}: unknown first-class artifact ${declaration.artifact_id}`);
    if (!(artifact.primary_routes || []).includes(declaration.route)) {
      throw new Error(`served unit ${declaration.unit_id}: route ${declaration.route} is not a primary route of ${declaration.artifact_id}`);
    }
    const artifactPath = artifact.public_artifact_path;
    const absolute = join(root, artifactPath);
    const sourceContract = contracts.find((entry) => entry.id === artifact.source_contract_id) || null;

    let state = "unavailable";
    let value = null;
    let vintage = { at: null, field: null, basis: "unresolved" };
    let populationField = null;
    let reason = null;
    let totalConsidered = null;

    if (!existsSync(absolute)) {
      reason = "artifact_not_committed";
    } else {
      const payload = readJson(absolute);
      vintage = resolveVintage(payload, artifact.vintage_fields);
      if (declaration.present_only) {
        const present = valueAt(payload, declaration.present_only.present_field);
        const total = valueAt(payload, declaration.present_only.total_field);
        if (Number.isFinite(Number(present))) {
          value = Number(present);
          populationField = declaration.present_only.present_field;
          totalConsidered = Number.isFinite(Number(total)) ? Number(total) : null;
        }
      } else {
        const population = resolvePopulation(payload, artifact.population_fields);
        value = population.count;
        populationField = population.field;
      }
      if (value == null) reason = "population_unresolved";
      else if (!vintage.at) reason = "vintage_unresolved";
    }

    if (value != null && vintage.at) state = value > 0 ? "measured" : "observed_zero";

    if (state === "unavailable") {
      const carried = retained.get(declaration.unit_id);
      if (carried && Number.isFinite(Number(carried.value)) && carried.evidence_vintage) {
        state = "retained";
        value = Number(carried.value);
        vintage = {
          at: carried.evidence_vintage,
          field: carried.vintage_field || null,
          basis: carried.vintage_basis || "retained",
        };
      } else {
        value = null;
      }
    }

    if (state === "measured" && !declaration.source_breakdown && artifact.source_contract_id) {
      representedSources.add(artifact.source_contract_id);
    }

    const unit = {
      unit_id: declaration.unit_id,
      domain_id: domainForRoute(declaration.route),
      record_unit_key: declaration.record_unit_key,
      counting_rule_key: declaration.counting_rule_key,
      route: declaration.route,
      // A unit built from several source systems names none of them here: the sources are the
      // breakdown beneath it, and borrowing one of their titles for the whole row would say
      // something the count does not.
      source_id: declaration.source_breakdown ? null : (artifact.source_contract_id || null),
      source_name: declaration.source_breakdown ? null : (sourceContract?.name || null),
      state,
      value,
      evidence_vintage: vintage.at,
      vintage_field: vintage.field,
      vintage_basis: vintage.basis,
    };
    if (totalConsidered != null) unit.records_considered = totalConsidered;
    if (reason && state !== "measured" && state !== "observed_zero") unit.reason = reason;

    if (declaration.source_breakdown) {
      unit.sources = procurementSources
        .filter((entry) => entry.registered && entry.source_contract_id)
        .map((entry) => ({
          source_id: entry.source_contract_id,
          source_name: contracts.find((contract) => contract.id === entry.source_contract_id)?.name || null,
          served_records: entry.served_observations,
          state: entry.served_observations > 0 ? "measured" : "observed_zero",
        }));
      for (const entry of unit.sources) {
        if (entry.state === "measured") representedSources.add(entry.source_id);
      }
    }

    units.push(unit);
    unitEvidence.push({
      unit_id: declaration.unit_id,
      first_class_artifact_id: declaration.artifact_id,
      artifact_path: artifactPath,
      population_field: populationField,
      vintage_field: vintage.field,
      vintage_basis: vintage.basis,
      state,
      value,
      reason,
    });
  }

  const vintages = units.map((unit) => unit.evidence_vintage).filter(Boolean).sort();
  const domains = DOMAINS
    .map((domain) => ({
      domain_id: domain.domain_id,
      route: domain.route,
      units: units.filter((unit) => unit.domain_id === domain.domain_id),
    }))
    .filter((domain) => domain.units.length);

  const dispositionByContract = new Map();
  const registryEvidence = [];
  const unitSourceIds = new Set(units.map((unit) => unit.source_id).filter(Boolean));
  const breakdownById = new Map(
    procurementSources.filter((entry) => entry.source_contract_id).map((entry) => [entry.source_contract_id, entry]),
  );

  for (const contract of contracts) {
    const id = contract.id;
    let disposition = null;
    let reason = null;
    const evidence = {};

    const servingUnits = units.filter((unit) => unit.source_id === id && unit.state === "measured");
    const breakdown = breakdownById.get(id);

    if (servingUnits.length) {
      disposition = "publicly_represented";
      reason = "Declared source of a counted served population.";
      evidence.units = servingUnits.map((unit) => ({
        unit_id: unit.unit_id,
        route: unit.route,
        served_records: unit.value,
        evidence_vintage: unit.evidence_vintage,
      }));
    } else if (breakdown && breakdown.served_observations > 0) {
      disposition = "publicly_represented";
      reason = "Source-qualified observations counted in the served procurement population.";
      evidence.procurement = {
        source_system: breakdown.source_system,
        served_observations: breakdown.served_observations,
        declared_input_rows: breakdown.declared_input_rows,
        specimen: breakdown.specimen,
      };
    } else if (breakdown) {
      disposition = "not_served";
      reason = "Declared available in the served procurement population and observed with no rows at this vintage.";
      evidence.procurement = {
        source_system: breakdown.source_system,
        served_observations: 0,
        declared_input_rows: breakdown.declared_input_rows,
      };
    } else if (unitSourceIds.has(id)) {
      disposition = "unresolved";
      reason = "Declared source of a selected served unit whose count could not be established at this vintage.";
      evidence.units = units.filter((unit) => unit.source_id === id).map((unit) => ({
        unit_id: unit.unit_id,
        state: unit.state,
      }));
    } else if (Object.hasOwn(DECLARED_DISPOSITIONS, id)) {
      [disposition, reason] = DECLARED_DISPOSITIONS[id];
      evidence.registry = {
        status: contract.status,
        delivery_tier: contract.delivery_tier,
        used_for: contract.used_for,
      };
    } else {
      throw new Error(`source contract ${id} has no derived or declared disposition; review it before the census can be published`);
    }

    if (!DISPOSITIONS.includes(disposition)) throw new Error(`source contract ${id}: invalid disposition ${disposition}`);
    dispositionByContract.set(id, disposition);
    registryEvidence.push({ source_id: id, name: contract.name, disposition, reason, evidence });
  }

  const registryDrift = {
    reviewed_registry_size: REVIEWED_REGISTRY_SIZE,
    observed_registry_size: contracts.length,
    changed: contracts.length !== REVIEWED_REGISTRY_SIZE,
  };

  const counts = Object.fromEntries(
    DISPOSITIONS.map((disposition) => [disposition, registryEvidence.filter((row) => row.disposition === disposition).length]),
  );

  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    measurement: {
      family: "served_product_coverage",
      counting_rule_keys: [...new Set(declarations.map((unit) => unit.counting_rule_key))].sort(),
      record_unit_keys: [...new Set(declarations.map((unit) => unit.record_unit_key))].sort(),
      state_keys: [...UNIT_STATES],
      units_are_not_summed: true,
    },
    metrics: [
      {
        metric_id: "served_sources_represented",
        state: representedSources.size > 0 ? "measured" : "unavailable",
        value: representedSources.size > 0 ? representedSources.size : null,
        counting_rule_key: "coverage_rule_source_represented",
        evidence_vintage: vintages.length ? vintages[0] : null,
      },
      {
        metric_id: "served_record_sets",
        state: units.some((unit) => unit.state === "measured") ? "measured" : "unavailable",
        value: units.filter((unit) => unit.state === "measured" || unit.state === "observed_zero" || unit.state === "retained").length,
        counting_rule_key: "coverage_rule_unit_published",
        evidence_vintage: vintages.length ? vintages[0] : null,
      },
    ],
    evidence_vintage: {
      oldest: vintages.length ? vintages[0] : null,
      newest: vintages.length ? vintages[vintages.length - 1] : null,
    },
    domains,
  };

  const census = {
    schema: CENSUS_SCHEMA,
    purpose: "Disposition of every registered source contract against the served product, and the served-population evidence behind each published coverage unit. Not a served artifact: this is the receipt the public snapshot is derived from.",
    registry: registryDrift,
    disposition_vocabulary: [...DISPOSITIONS],
    disposition_counts: counts,
    served_units: unitEvidence,
    procurement_source_census: procurementSources,
    sources_represented: [...representedSources].sort(),
    sources: registryEvidence.sort((a, b) => a.source_id.localeCompare(b.source_id)),
  };

  return { snapshot, census };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readIfPresent(path) {
  try { return readJson(path); } catch { return null; }
}

export function generatedFiles({ root = ROOT } = {}) {
  const previousSnapshot = readIfPresent(join(root, "site/data/served_coverage_snapshot.json"));
  const { snapshot, census } = buildServedCoverage({ root, previousSnapshot });
  return {
    [join(root, "site/data/served_coverage_snapshot.json")]: serialize(snapshot),
    [join(root, "docs/evidence/served-coverage/census.json")]: serialize(census),
  };
}

function main(argv) {
  const check = argv.includes("--check");
  const files = generatedFiles();
  if (check) {
    const stale = Object.entries(files).filter(([path, expected]) => {
      try { return readFileSync(path, "utf8") !== expected; } catch { return true; }
    });
    if (stale.length) {
      for (const [path] of stale) console.error(`out of date: ${path.slice(ROOT.length + 1)}`);
      console.error("run: node tools/build_served_coverage_snapshot.mjs");
      process.exitCode = 1;
      return;
    }
    console.log(`served coverage snapshot current (${Object.keys(files).length} artifacts)`);
    return;
  }
  for (const [path, contents] of Object.entries(files)) {
    // determinism-lint: allow write the --check branch above returns before reaching this line
    mkdirSync(dirname(path), { recursive: true });
    // determinism-lint: allow write the --check branch above returns before reaching this line
    writeFileSync(path, contents, "utf8");
    console.log(`wrote ${path.slice(ROOT.length + 1)}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main(process.argv.slice(2));
