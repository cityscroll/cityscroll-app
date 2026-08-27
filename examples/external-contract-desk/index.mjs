#!/usr/bin/env node

// A deliberately independent consumer of CityScroll's documented public HTTP
// contract-analysis surface. This file has no imports from the CityScroll
// application, worker, site, or capability implementation.

export const DEFAULT_API_ORIGIN = "https://api.cityscroll.org";
export const CONTRACTS_ANALYSIS_PATH = "/contracts/analysis";
export const CONSUMER_SCHEMA = "cityscroll.external_contract_desk_report.v1";

const PRIVATE_FIELDS = new Set([
  "raw_snapshot",
  "normalized_snapshot",
  "content_hash",
  "evidence_json",
  "resolution_run_id",
  "review_status",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNoPrivateFields(value, path = "response") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_FIELDS.has(key)) throw new Error(`public response exposed forbidden field ${path}.${key}`);
    assertNoPrivateFields(child, `${path}.${key}`);
  }
}

function analysisUrl({ apiOrigin, agency, measure, limit }) {
  const url = new URL(CONTRACTS_ANALYSIS_PATH, apiOrigin);
  url.searchParams.set("group_by", "vendor");
  url.searchParams.set("measure", measure);
  url.searchParams.set("agency", agency);
  url.searchParams.set("limit", String(limit));
  return url;
}

async function getAnalysis({ fetchImpl, apiOrigin, agency, measure, limit }) {
  const url = analysisUrl({ apiOrigin, agency, measure, limit });
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json();
  assertObject(payload, "contract analysis response");
  if (!response?.ok && payload.availability !== "unavailable") {
    throw new Error(`CityScroll contract analysis returned HTTP ${response?.status ?? "unknown"}`);
  }
  assertNoPrivateFields(payload);
  if (payload.capability_reference !== "contracts.analysis@1") {
    throw new Error("CityScroll response is not the documented contracts.analysis@1 capability");
  }
  if (!["complete", "empty", "unavailable"].includes(payload.availability)) {
    throw new Error("CityScroll contract analysis has an invalid availability");
  }
  return { url: url.toString(), payload };
}

function requireCompleteAnalysis(result, measure) {
  if (result.availability === "empty") return result;
  if (result.availability === "unavailable") return result;
  if (!Array.isArray(result.groups) || !result.denominator || !result.freshness || !result.coverage) {
    throw new Error(`complete ${measure} analysis is missing its documented envelope`);
  }
  if (result.measure?.unit !== (measure === "count" ? "contracts" : "USD")) {
    throw new Error(`complete ${measure} analysis has the wrong documented unit`);
  }
  return result;
}

function groupKey(group) {
  return clean(group?.label);
}

function exactIds(group) {
  return Array.isArray(group?.contract_ids) ? [...group.contract_ids] : [];
}

function assertGroup(group, label) {
  if (!groupKey(group) || !Number.isFinite(group.value) || !Number.isInteger(group.contract_count)
      || !Array.isArray(group.contract_ids) || group.contract_ids.length !== group.contract_count
      || typeof group.drill_through?.href !== "string") {
    throw new Error(`${label} group is missing public value, identity, count, or drill-through fields`);
  }
}

function mergeGroups(valueAnalysis, countAnalysis) {
  const countByLabel = new Map(countAnalysis.groups.map((group) => [groupKey(group), group]));
  if (countByLabel.size !== valueAnalysis.groups.length) {
    throw new Error("value/count analyses disagree on the set of vendor groups");
  }
  return valueAnalysis.groups.map((group, index) => {
    assertGroup(group, "value");
    const countGroup = countByLabel.get(groupKey(group));
    if (!countGroup) throw new Error(`count analysis omitted vendor ${groupKey(group)}`);
    assertGroup(countGroup, "count");
    if (group.contract_count !== countGroup.contract_count
        || JSON.stringify(exactIds(group)) !== JSON.stringify(exactIds(countGroup))) {
      throw new Error(`value/count analyses disagree for vendor ${groupKey(group)}`);
    }
    const denominatorValue = Number(valueAnalysis.denominator.value);
    return {
      rank: index + 1,
      label: groupKey(group),
      registered_value: group.value,
      registered_value_share: denominatorValue > 0 ? group.value / denominatorValue : 0,
      contract_count: group.contract_count,
      contract_ids: exactIds(group),
      site_drill_through: group.drill_through.href,
    };
  });
}

export async function buildContractDeskReport({
  agency,
  apiOrigin = DEFAULT_API_ORIGIN,
  limit = 10,
  fetchImpl = globalThis.fetch,
} = {}) {
  const selectedAgency = clean(agency);
  if (!selectedAgency) throw new Error("agency is required");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 through 100");
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");

  const origin = new URL(apiOrigin).toString();
  const valueResponse = await getAnalysis({
    fetchImpl, apiOrigin: origin, agency: selectedAgency, measure: "current", limit,
  });
  const valueAnalysis = requireCompleteAnalysis(valueResponse.payload, "current");
  if (valueAnalysis.availability === "unavailable") {
    return {
      schema: CONSUMER_SCHEMA,
      consumer: "external-contract-desk",
      scope: { agency: selectedAgency },
      availability: "unavailable",
      source: { capability: "contracts.analysis@1", http: valueResponse.url },
      vendors: [],
      known_gaps: ["The public contract-analysis endpoint is unavailable; no registered-contract claims were made."],
    };
  }
  if (valueAnalysis.availability === "empty") {
    return {
      schema: CONSUMER_SCHEMA,
      consumer: "external-contract-desk",
      scope: { agency: selectedAgency },
      availability: "empty",
      source: { capability: "contracts.analysis@1", http: valueResponse.url },
      vendors: [],
      known_gaps: ["The public analysis surface has no rows for this exact agency scope."],
    };
  }

  const countResponse = await getAnalysis({
    fetchImpl,
    apiOrigin: origin,
    agency: selectedAgency,
    measure: "count",
    limit,
  });
  const countAnalysis = requireCompleteAnalysis(countResponse.payload, "count");
  if (countAnalysis.availability !== "complete") {
    return {
      schema: CONSUMER_SCHEMA,
      consumer: "external-contract-desk",
      scope: { agency: selectedAgency },
      availability: "unavailable",
      source: { capability: "contracts.analysis@1", http: valueResponse.url, count_http: countResponse.url },
      vendors: [],
      known_gaps: ["The public count response was unavailable, so the value/count parity check was not claimed."],
    };
  }

  const valueMeasure = valueAnalysis.measure || {};
  if (valueMeasure.fact !== "registered_contract" || valueMeasure.not_payment !== true) {
    throw new Error("public value analysis did not identify the registered-contract fact and payment exclusion");
  }
  return {
    schema: CONSUMER_SCHEMA,
    consumer: "external-contract-desk",
    scope: { agency: selectedAgency },
    availability: "complete",
    as_of: valueAnalysis.freshness.as_of,
    fact: "registered_contract",
    measure: {
      label: valueMeasure.reader_label,
      unit: valueMeasure.unit,
      denominator_value: valueAnalysis.denominator.value,
      denominator_contract_count: valueAnalysis.denominator.contract_count,
    },
    coverage: {
      statement: valueAnalysis.coverage.statement,
      matched_contract_count: valueAnalysis.coverage.matched_contract_count,
      eligible_contract_count: valueAnalysis.coverage.eligible_contract_count,
      missing_pin_contract_count: valueAnalysis.coverage.missing_pin_contract_count,
    },
    vendors: mergeGroups(valueAnalysis, countAnalysis),
    parity: {
      value_request: valueResponse.url,
      count_request: countResponse.url,
      group_identity_agrees: true,
      site_values_and_links_carried_forward: true,
    },
    known_gaps: [
      "The documented contracts.analysis capability reports registered contract value, not actual payments or spending; this report makes no payment claim.",
    ],
    source: {
      capability: "contracts.analysis@1",
      http: valueResponse.url,
      mcp_equivalent: "analyze_contracts (documented, not required by this HTTP consumer)",
    },
  };
}

function money(value) {
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function pluralizeContracts(value) {
  return `${value.toLocaleString("en-US")} contract${value === 1 ? "" : "s"}`;
}

export function formatContractDeskReport(report) {
  const lines = [
    `Contract desk report — ${report.scope.agency}`,
    `Availability: ${report.availability}`,
  ];
  if (report.availability === "empty") return [...lines, "No public registered-contract rows matched this exact agency scope.", `Gap: ${report.known_gaps[0]}`].join("\n");
  if (report.availability === "unavailable") return [...lines, "The public contract-analysis endpoint is unavailable; no claims were made.", `Gap: ${report.known_gaps[0]}`].join("\n");
  lines.push(`As of: ${report.as_of}`);
  lines.push(`Registered contract value: ${money(report.measure.denominator_value)} across ${pluralizeContracts(report.measure.denominator_contract_count)}.`);
  lines.push("Top vendors by registered value:");
  for (const vendor of report.vendors) {
    lines.push(`${vendor.rank}. ${vendor.label} — ${money(vendor.registered_value)} (${(vendor.registered_value_share * 100).toFixed(1)}%; ${pluralizeContracts(vendor.contract_count)})`);
  }
  lines.push(`Coverage: ${report.coverage.statement}`);
  lines.push(`Gap: ${report.known_gaps[0]}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") args.json = true;
    else if (["--agency", "--base-url", "--limit"].includes(arg)) args[arg.slice(2).replaceAll("-", "_")] = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await buildContractDeskReport({
      agency: args.agency,
      apiOrigin: args.base_url || DEFAULT_API_ORIGIN,
      limit: args.limit === undefined ? 10 : Number(args.limit),
    });
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatContractDeskReport(report)}\n`);
  } catch (error) {
    process.stderr.write(`external contract desk: ${error.message}\n`);
    process.exitCode = 1;
  }
}
