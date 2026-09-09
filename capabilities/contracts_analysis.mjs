// Transport-neutral contract for the bounded Contracts analytical projection.
// The registered-contract population, not payment activity, is the only fact
// exposed by this capability.

export const CONTRACTS_ANALYSIS_CAPABILITY_ID = "contracts.analysis";
export const CONTRACTS_ANALYSIS_CAPABILITY_VERSION = "1.1.0";
export const CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE = "contracts.analysis@1";
export const CONTRACTS_ANALYSIS_PROVIDER_ID = "worker-static.procurement-contracts.analysis";
export const CONTRACTS_ANALYSIS_LIMITS = Object.freeze({
  filterMaximumLength: 240,
  minimumGroups: 1,
  maximumGroups: 100,
  defaultGroups: 10,
});
export const CONTRACTS_ANALYSIS_GROUPS = Object.freeze([
  "agency",
  "vendor",
  "registration_fiscal_year",
  "amount_band",
]);
export const CONTRACTS_ANALYSIS_MEASURES = Object.freeze([
  "current",
  "original",
  "count",
]);
export const CONTRACTS_ANALYSIS_AVAILABILITY = Object.freeze([
  "complete",
  "empty",
  "unavailable",
]);
// How a contributing registered contract was matched to the procurement detail
// record a reader can fetch. The aggregate and the detail capability identify
// the same contract in different namespaces, so the answer must say which
// authority resolved the pairing rather than leaving a reader to assemble an
// identifier itself.
export const PROCUREMENT_DETAIL_RESOLUTIONS = Object.freeze([
  // The detail read model's own rows were read, so each registration
  // identifier is resolved through the identity keys the record publishes.
  "identity_keys",
  // Only the detail read model's published identity index was read, so a
  // contract is resolved through the canonical identity that index publishes.
  "published_identity_index",
  // No detail read model was available, so retrievability is not claimed.
  "not_resolved",
]);
export const PROCUREMENT_DETAIL_NOT_RETRIEVABLE_REASON =
  "The shared procurement read model publishes no procurement detail record under this registered contract's own identity, so the contract cannot be fetched individually yet.";
export const CONTRACTS_ANALYSIS_REPRESENTATIONS = Object.freeze([
  Object.freeze({
    id: "json",
    mediaType: "application/json",
    projection: "bounded grouped registered-contract analysis",
  }),
  Object.freeze({
    id: "text-summary",
    mediaType: "text/plain",
    projection: "bounded grouped registered-contract analysis summary",
  }),
]);

const CONTRACTS_ANALYSIS_INPUT_FIELDS = new Set([
  "groupBy", "measure", "agency", "vendor", "fiscalYear", "amountBand",
  "minAmount", "maxAmount", "retroactive", "cityRecordMatch", "limit",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const CONTRACTS_ANALYSIS_CAPABILITY = deepFreeze({
  id: CONTRACTS_ANALYSIS_CAPABILITY_ID,
  version: CONTRACTS_ANALYSIS_CAPABILITY_VERSION,
  reference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
  owner: "procurement",
  operation: "read",
  authority: { class: "public-read", sideEffect: "none", approval: "none" },
  cost: { class: "bounded-static-read-model", machineFanOut: "low" },
  bounds: {
    input: CONTRACTS_ANALYSIS_LIMITS,
    output: { maximumGroups: CONTRACTS_ANALYSIS_LIMITS.maximumGroups },
  },
  input: {
    schema: "cityscroll.capability.contracts_analysis.input.v1",
    identity: "one row per exact prime_contract_id in the registered-contract projection",
    groupings: CONTRACTS_ANALYSIS_GROUPS,
    measures: CONTRACTS_ANALYSIS_MEASURES,
    filters: {
      agency: "case-sensitive exact projected agency label; call without agency and read filters.discovery.agency.accepted_labels before filtering",
      vendor: "case-sensitive exact projected prime-vendor label",
      fiscalYear: "NYC registration fiscal year derived from registration date: July 1 of the preceding year through June 30; not award, payment, or source partition year",
      amountBand: "exact versioned current registered-value band",
      minAmount: "inclusive current registered-value floor",
      maxAmount: "inclusive current registered-value ceiling",
      retroactive: "only rows with a published registration/start-date comparison",
      cityRecordMatch: "exact, none, or cannot_evaluate_missing_pin",
    },
    limits: CONTRACTS_ANALYSIS_LIMITS,
  },
  output: {
    schema: "cityscroll.capability.contracts_analysis.output.v1",
    fields: [
      "capability_reference", "availability", "group_by", "measure", "groups",
      "denominator", "population", "coverage", "contract_detail", "filters",
      "freshness", "error",
    ],
    filterDiscovery: "filters.discovery publishes accepted agency labels, suggestions for unrecognized labels, and registration fiscal-year semantics independently of the selected result population",
    availability: CONTRACTS_ANALYSIS_AVAILABILITY,
    representations: CONTRACTS_ANALYSIS_REPRESENTATIONS,
    privateFieldsForbidden: ["raw_snapshot", "normalized_snapshot", "content_hash", "evidence_json", "resolution_run_id", "review_status"],
  },
  provenance: {
    population: "site/data/analytics_registered_contracts.json",
    identity: "prime_contract_id (exact registered-contract identity)",
    drillThrough: "ordinary Contracts scope with exact contributing contract identifiers",
    contractDetail: "each contributing registration identifier is resolved to the canonical procurement id contract.get@1 accepts, or reported as not individually retrievable with a reason",
  },
  freshness: {
    owner: "committed registered-contract analytical projection",
    projection: "generated_at and snapshot_date",
  },
  provider: {
    id: CONTRACTS_ANALYSIS_PROVIDER_ID,
    module: "worker/src/contracts.mjs",
    export: "workerContractsAnalysis",
    store: "precomputed registered-contract analytical projection",
    readModel: "site/data/analytics_registered_contracts.json",
  },
  examples: [
    {
      input: { groupBy: "agency", measure: "current", fiscalYear: 2027, limit: 10 },
      output: { availability: "complete", measure: "current registered contract value in USD", denominator: "selected filtered population value" },
    },
    {
      input: { groupBy: "vendor", measure: "count", agency: "Department of Education" },
      output: { availability: "complete", measure: "unique registered contracts", drillThrough: "contract_ids and ordinary Contracts scope" },
    },
  ],
  adapters: [
    {
      id: "worker-http.contracts-analysis@1",
      module: "worker/src/contracts.mjs",
      kind: "http-route",
      route: "GET /contracts/analysis",
      surface: "Contracts analysis",
      representations: CONTRACTS_ANALYSIS_REPRESENTATIONS,
    },
    {
      id: "mcp.analyze_contracts@1",
      module: "worker/src/mcp.mjs",
      kind: "mcp-tool",
      tool: "analyze_contracts",
      route: "POST /mcp",
      surface: "MCP",
      representations: CONTRACTS_ANALYSIS_REPRESENTATIONS,
    },
  ],
});

function assertObject(input, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${name} input must be an object`);
}

function boundedString(value, field) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string" || value.length > CONTRACTS_ANALYSIS_LIMITS.filterMaximumLength) {
    throw new TypeError(`${field} must be a bounded string`);
  }
}

function finiteNumber(value, field) {
  if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError(`${field} must be a finite number`);
  }
}

export function validateContractsAnalysisInput(input) {
  assertObject(input, "contracts.analysis");
  for (const field of Object.keys(input)) {
    if (!CONTRACTS_ANALYSIS_INPUT_FIELDS.has(field)) throw new TypeError(`contracts.analysis does not accept field: ${field}`);
  }
  if (input.groupBy !== undefined && !CONTRACTS_ANALYSIS_GROUPS.includes(input.groupBy)) throw new TypeError("groupBy is not a supported Contracts analysis grouping");
  if (input.measure !== undefined && !CONTRACTS_ANALYSIS_MEASURES.includes(input.measure)) throw new TypeError("measure is not a supported Contracts analysis measure");
  for (const field of ["agency", "vendor", "amountBand", "cityRecordMatch"]) boundedString(input[field], field);
  if (input.cityRecordMatch !== undefined && input.cityRecordMatch !== null
      && !["exact", "none", "cannot_evaluate_missing_pin"].includes(input.cityRecordMatch)) {
    throw new TypeError("cityRecordMatch is not a supported City Record match state");
  }
  for (const field of ["minAmount", "maxAmount"]) finiteNumber(input[field], field);
  if (input.minAmount != null && input.maxAmount != null && input.minAmount > input.maxAmount) throw new TypeError("minAmount must not exceed maxAmount");
  if (input.fiscalYear !== undefined && input.fiscalYear !== null
      && (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1900 || input.fiscalYear > 2200)) throw new TypeError("fiscalYear must be a valid integer fiscal year");
  if (input.retroactive !== undefined && input.retroactive !== null && typeof input.retroactive !== "boolean") throw new TypeError("retroactive must be boolean");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < CONTRACTS_ANALYSIS_LIMITS.minimumGroups || input.limit > CONTRACTS_ANALYSIS_LIMITS.maximumGroups)) {
    throw new TypeError(`limit must be an integer from ${CONTRACTS_ANALYSIS_LIMITS.minimumGroups} through ${CONTRACTS_ANALYSIS_LIMITS.maximumGroups}`);
  }
  return input;
}

function assertNoPrivateFields(value, path = "output") {
  if (!value || typeof value !== "object") return;
  for (const [field, child] of Object.entries(value)) {
    if (CONTRACTS_ANALYSIS_CAPABILITY.output.privateFieldsForbidden.includes(field)) throw new TypeError(`Contracts analysis exposes private field: ${path}.${field}`);
    assertNoPrivateFields(child, `${path}.${field}`);
  }
}

function assertGroup(group, measure) {
  if (!group || typeof group !== "object" || typeof group.label !== "string"
      || !Number.isInteger(group.contract_count) || group.contract_count < 0
      || !Array.isArray(group.contract_ids) || group.contract_ids.length !== group.contract_count
      || new Set(group.contract_ids).size !== group.contract_ids.length
      || typeof group.value !== "number" || !Number.isFinite(group.value)
      || group.unit !== measure.unit || !group.drill_through || typeof group.drill_through.href !== "string") {
    throw new TypeError("Contracts analysis group is incomplete");
  }
  assertGroupContractDetail(group);
}

/**
 * A group may not publish an identifier a reader cannot act on. Either every
 * contributing contract carries the canonical procurement id contract.get@1
 * accepts at the same index, or it carries an explicit null that the envelope's
 * contract_detail block explains.
 */
function assertGroupContractDetail(group) {
  const resolved = group.contract_procurement_ids;
  const retrieval = group.contract_retrieval;
  if (!retrieval || typeof retrieval !== "object"
      || !PROCUREMENT_DETAIL_RESOLUTIONS.includes(retrieval.resolution)
      || !Number.isInteger(retrieval.retrievable_contract_count)
      || !Number.isInteger(retrieval.not_retrievable_contract_count)) {
    throw new TypeError("Contracts analysis group is missing its contract retrieval state");
  }
  if (resolved === null) {
    if (retrieval.resolution !== "not_resolved"
        || retrieval.retrievable_contract_count !== 0
        || retrieval.not_retrievable_contract_count !== group.contract_count) {
      throw new TypeError("unresolved Contracts analysis group cannot claim retrievable contracts");
    }
    return;
  }
  if (!Array.isArray(resolved) || resolved.length !== group.contract_ids.length
      || retrieval.resolution === "not_resolved") {
    throw new TypeError("Contracts analysis contract_procurement_ids must pair with contract_ids");
  }
  let retrievable = 0;
  for (const procurementId of resolved) {
    if (procurementId === null) continue;
    if (typeof procurementId !== "string" || !procurementId.startsWith("procurement:")) {
      throw new TypeError("Contracts analysis resolved a non-canonical procurement id");
    }
    retrievable += 1;
  }
  if (retrieval.retrievable_contract_count !== retrievable
      || retrieval.not_retrievable_contract_count !== resolved.length - retrievable) {
    throw new TypeError("Contracts analysis retrieval counts disagree with the resolved ids");
  }
}

/** The envelope must name the capability a resolved identifier is fetched through. */
function assertContractDetail(result) {
  const detail = result.contract_detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)
      || detail.capability !== "contract.get@1"
      || detail.identifier_field !== "contract_procurement_ids"
      || typeof detail.identifier_note !== "string" || !detail.identifier_note
      || !PROCUREMENT_DETAIL_RESOLUTIONS.includes(detail.resolution)
      || typeof detail.not_retrievable_reason !== "string" || !detail.not_retrievable_reason
      || !Number.isInteger(detail.retrievable_contract_count)
      || !Number.isInteger(detail.not_retrievable_contract_count)) {
    throw new TypeError("Contracts analysis contract_detail is incomplete");
  }
  for (const group of result.groups) {
    if (group.contract_retrieval.resolution !== detail.resolution) {
      throw new TypeError("Contracts analysis group resolution drifted from the envelope");
    }
  }
}

export function validateContractsAnalysisOutput(result, input) {
  validateContractsAnalysisInput(input);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new TypeError("contracts.analysis provider must return an object");
  if (result.capability_reference !== CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE) throw new TypeError("contracts.analysis capability reference drifted");
  if (!CONTRACTS_ANALYSIS_AVAILABILITY.includes(result.availability)) throw new TypeError("contracts.analysis availability is invalid");
  if (result.availability === "unavailable") {
    if (result.groups !== null || result.contract_detail !== null || result.error !== "unavailable") throw new TypeError("unavailable Contracts analysis output is inconsistent");
    return result;
  }
  if (!CONTRACTS_ANALYSIS_GROUPS.includes(result.group_by) || !result.measure
      || !CONTRACTS_ANALYSIS_MEASURES.includes(result.measure.key)
      || !["USD", "contracts"].includes(result.measure.unit)
      || !Array.isArray(result.groups) || result.groups.length > CONTRACTS_ANALYSIS_LIMITS.maximumGroups) {
    throw new TypeError("Contracts analysis measure or groups are invalid");
  }
  for (const group of result.groups) assertGroup(group, result.measure);
  if (result.availability === "complete" && !result.groups.length) throw new TypeError("empty analysis must use empty availability");
  if (result.availability === "empty" && result.groups.length) throw new TypeError("non-empty analysis must use complete availability");
  if (!result.denominator || typeof result.denominator.value !== "number"
      || !Number.isFinite(result.denominator.value) || result.denominator.unit !== result.measure.unit
      || !Number.isInteger(result.denominator.contract_count) || result.denominator.contract_count < 0
      || !result.population || typeof result.population.included !== "string"
      || !Array.isArray(result.population.excluded)
      || !result.coverage || typeof result.coverage.statement !== "string"
      || !result.freshness || typeof result.freshness.as_of !== "string") {
    throw new TypeError("Contracts analysis population, denominator, coverage, or freshness is incomplete");
  }
  if (!result.filters || typeof result.filters !== "object" || Array.isArray(result.filters)) throw new TypeError("Contracts analysis filters are required");
  assertContractDetail(result);
  if (result.error !== null) throw new TypeError("available Contracts analysis output cannot carry an error");
  assertNoPrivateFields(result);
  return result;
}

export async function executeContractsAnalysis(provider, input) {
  validateContractsAnalysisInput(input);
  if (!provider || provider.capabilityReference !== CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE
      || provider.providerId !== CONTRACTS_ANALYSIS_PROVIDER_ID || typeof provider.execute !== "function") {
    throw new TypeError("contracts.analysis requires the registered explicit provider");
  }
  return validateContractsAnalysisOutput(await provider.execute(input), input);
}
