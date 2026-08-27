/**
 * Reader-facing projection for accepted, exact cross-source evidence.
 *
 * This module deliberately does not match records. It consumes accepted graph
 * joins and retained observations, then keeps each publisher's assertion and
 * provenance beside the comparison result.
 */

import { residentOfficialSource } from "./provenance_disclosure.mjs";

export const CROSS_SOURCE_EVIDENCE_RECEIPT_SCHEMA =
  "cityscroll.cross_source_evidence_receipt.v1";
export const CROSS_SOURCE_EVIDENCE_RECEIPT_VERSION = 1;

const EXACT_JOIN_BASIS = new Map([
  ["exact_contract_id", "Exact contract ID"],
  ["contract_id_exact", "Exact contract ID"],
  ["exact_epin", "Exact PIN / EPIN"],
  ["pin_epin_exact", "Exact PIN / EPIN"],
  ["exact_request_id", "Exact request ID"],
  ["request_id", "Exact request ID"],
  ["exact_board_date_publisher_identifier", "Exact board, date, and publisher identifier"],
]);

const SOURCE_LABELS = Object.freeze({
  city_record: "City Record",
  passport_public_contracts: "PASSPort Public contracts",
  passport_public_rfx: "PASSPort Public solicitations",
  checkbook_contracts: "Checkbook NYC",
  checkbook_spending: "Checkbook NYC spending",
  "ocp-recent-awards": "Recent Contract Awards (OCP)",
  "ocp-recent-contract-awards": "Recent Contract Awards (OCP)",
  ocp_awards: "Recent Contract Awards (OCP)",
  abo: "NYS Authorities Budget Office",
});

const SOURCE_HREFS = Object.freeze({
  "ocp-recent-awards": "https://data.cityofnewyork.us/d/qyyg-4tf5",
  "ocp-recent-contract-awards": "https://data.cityofnewyork.us/d/qyyg-4tf5",
  ocp_awards: "https://data.cityofnewyork.us/d/qyyg-4tf5",
});

const FACT_DEFINITIONS = Object.freeze([
  {
    key: "contract_id",
    label: "Contract ID",
    fields: ["contract_id", "contractId", "id", "prime_contract_id"],
    normalize: (value) => exactText(value),
    display: (value) => exactText(value),
  },
  {
    key: "pin",
    label: "PIN / EPIN",
    fields: ["epin", "epin_norm", "pin", "prime_contract_pin"],
    normalize: (value) => exactText(value),
    display: (value) => exactText(value),
  },
  {
    key: "title",
    label: "Title",
    fields: ["title", "short_title", "description", "procurement_description"],
    normalize: (value) => looseText(value)?.toLowerCase() || null,
    display: (value) => looseText(value),
  },
  {
    key: "vendor",
    label: "Vendor",
    fields: ["vendor", "vendor_name", "prime_vendor", "payee_name"],
    normalize: (value) => looseText(value)?.toLowerCase() || null,
    display: (value) => looseText(value),
  },
  {
    key: "amount",
    label: "Amount",
    fields: ["award_amount", "contract_amount", "current_amount", "current", "amount", "check_amount"],
    normalize: (value) => amount(value),
    display: (value) => {
      const parsed = amount(value);
      return parsed == null ? null : `$${parsed.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    },
  },
  {
    key: "date",
    label: "Date",
    fields: ["start_date", "registration_date", "registered", "date", "award_date", "issue_date"],
    normalize: (value) => dateOnly(value),
    display: (value) => dateOnly(value),
  },
  {
    key: "status",
    label: "Status",
    fields: ["status"],
    normalize: (value) => looseText(value)?.toLowerCase() || null,
    display: (value) => looseText(value),
  },
]);

function looseText(value) {
  const result = String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return result || null;
}

function exactText(value) {
  return looseText(value);
}

function amount(value) {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value) {
  const text = looseText(value);
  return text ? text.slice(0, 10) : null;
}

function snapshotOf(observation) {
  if (observation?.snapshot && typeof observation.snapshot === "object") return observation.snapshot;
  for (const value of [observation?.normalized_snapshot, observation?.raw_snapshot]) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // An unreadable snapshot cannot contribute a source assertion.
    }
  }
  return {};
}

function sourceSystem(observation) {
  return looseText(observation?.source_system)?.toLowerCase() || null;
}

function observationRef(observation) {
  return looseText(observation?.source_observation_ref)
    || (sourceSystem(observation) && looseText(observation?.source_system_id || observation?.source_id)
      ? `${sourceSystem(observation)}:${looseText(observation.source_system_id || observation.source_id)}`
      : null);
}

function acceptedJoin(join) {
  const status = looseText(join?.status)?.toLowerCase();
  const basis = looseText(join?.basis || join?.join_method || join?.join_key)?.toLowerCase();
  return (status === "accepted" || status === "corroborated" || (status === "matched" && EXACT_JOIN_BASIS.has(basis)))
    && EXACT_JOIN_BASIS.has(basis);
}

function joinRefs(join) {
  return [
    join?.left_source_observation_ref,
    join?.right_source_observation_ref,
    ...(Array.isArray(join?.source_observation_refs) ? join.source_observation_refs : []),
  ].map((value) => looseText(value)).filter(Boolean);
}

function sourceHref(system, observation, snapshot) {
  const explicit = snapshot.source_url || snapshot.source_href || observation?.source_url;
  if (explicit) {
    const official = residentOfficialSource({
      sourceSystem: system,
      sourceRecordId: observation?.source_system_id || observation?.source_id,
      sourceHref: explicit,
      label: SOURCE_LABELS[system],
    });
    if (official) return official;
  }
  if (SOURCE_HREFS[system]) {
    return { href: SOURCE_HREFS[system], label: SOURCE_LABELS[system] };
  }
  return residentOfficialSource({
    sourceSystem: system,
    sourceRecordId: observation?.source_system_id || observation?.source_id,
    label: SOURCE_LABELS[system],
  });
}

function sourceNativeId(observation, snapshot) {
  return looseText(
    observation?.source_system_id
      || observation?.source_id
      || snapshot.source_record_id
      || snapshot.request_id
      || snapshot.contract_id
      || snapshot.contractId
      || snapshot.id,
  );
}

function valueFor(definition, snapshot) {
  for (const field of definition.fields) {
    const value = definition.display(snapshot?.[field]);
    if (value != null) return { value, field };
  }
  return { value: null, field: null };
}

function coverageFor(system, observation, sourceStatus) {
  const coverage = looseText(observation?.coverage || observation?.coverage_status)
    || looseText(sourceStatus?.[system]?.status)
    || "available";
  const labels = {
    available: "Available in the materialized snapshot",
    partial: "Partial source coverage",
    stale: "Stale source snapshot",
    unavailable: "Source unavailable",
  };
  return { coverage, coverage_label: labels[coverage] || coverage };
}

function sourceProjection(observation, sourceStatus, generatedAt, methods) {
  const system = sourceSystem(observation);
  const snapshot = snapshotOf(observation);
  const official = sourceHref(system, observation, snapshot);
  const nativeId = sourceNativeId(observation, snapshot);
  const coverage = coverageFor(system, observation, sourceStatus);
  const asOf = looseText(
    snapshot.as_of || snapshot.source_as_of || observation?.as_of || observation?.observed_at
      || observation?.ingested_at || sourceStatus?.[system]?.generated_at || generatedAt,
  );
  return {
    source_system: system,
    source_name: SOURCE_LABELS[system] || system || "Source",
    source_native_id: nativeId,
    source_href: official?.href || null,
    source_label: official?.label || SOURCE_LABELS[system] || "Official source",
    accepted_join_methods: [...methods].map((method) => ({
      id: method,
      label: EXACT_JOIN_BASIS.get(method),
    })),
    coverage: coverage.coverage,
    coverage_label: coverage.coverage_label,
    as_of: asOf,
    snapshot,
  };
}

/**
 * Build a bounded receipt from accepted exact joins. No join candidates are
 * inferred here, and non-exact states cannot be promoted by this projection.
 */
export function buildCrossSourceEvidenceReceipt({
  object = {},
  observations = [],
  acceptedJoins = [],
  sourceStatus = {},
  generatedAt = null,
  factDefinitions = FACT_DEFINITIONS,
} = {}) {
  const objectId = looseText(object?.procurement_id || object?.object_ref || object?.subject_ref);
  const byRef = new Map((Array.isArray(observations) ? observations : [])
    .map((observation) => [observationRef(observation), observation])
    .filter(([ref]) => ref));
  const joins = (Array.isArray(acceptedJoins) ? acceptedJoins : [])
    .filter((join) => acceptedJoin(join))
    .filter((join) => !objectId || !join?.procurement_id || join.procurement_id === objectId)
    .map((join) => ({
      ...join,
      basis: looseText(join.basis || join.join_method || join.join_key)?.toLowerCase(),
      refs: joinRefs(join),
    }))
    .filter((join) => join.refs.length >= 2 && join.refs.every((ref) => byRef.has(ref)));
  if (!joins.length) return null;

  const joinedRefs = new Set(joins.flatMap((join) => join.refs));
  const methodsByRef = new Map();
  for (const join of joins) {
    for (const ref of join.refs) {
      if (!methodsByRef.has(ref)) methodsByRef.set(ref, new Set());
      methodsByRef.get(ref).add(join.basis);
    }
  }
  const sourceRows = [...joinedRefs]
    .map((ref) => sourceProjection(byRef.get(ref), sourceStatus, generatedAt, methodsByRef.get(ref)))
    .filter((source) => source.source_system);
  if (new Set(sourceRows.map((source) => source.source_system)).size < 2) return null;

  const facts = [];
  for (const definition of Array.isArray(factDefinitions) ? factDefinitions : []) {
    const assertions = sourceRows.map((source) => {
      const found = valueFor(definition, source.snapshot);
      return {
        source_system: source.source_system,
        source_name: source.source_name,
        source_native_id: source.source_native_id,
        source_href: source.source_href,
        source_label: source.source_label,
        assertion: found.value,
        assertion_label: found.value == null ? "Not published by this source" : found.value,
        field: found.field,
        provenance: {
          source_system: source.source_system,
          source_record_id: source.source_native_id,
          source_url: source.source_href,
          coverage: source.coverage,
          coverage_label: source.coverage_label,
          as_of: source.as_of,
        },
      };
    });
    const asserted = assertions.filter((assertion) => assertion.assertion != null);
    if (asserted.length < 2) continue;
    const normalized = asserted.map((assertion) => definition.normalize(assertion.assertion));
    const agrees = normalized.every((value) => value != null && value === normalized[0]);
    facts.push({
      key: definition.key,
      label: definition.label,
      status: agrees ? "agrees" : "disagrees",
      assertions,
    });
  }
  if (!facts.length) return null;

  const uniqueJoins = [...new Map(joins.map((join) => [
    `${join.refs.slice().sort().join("\0")}\0${join.basis}`,
    {
      status: "accepted",
      basis: join.basis,
      basis_label: EXACT_JOIN_BASIS.get(join.basis),
      matched_value: looseText(join.matched_value),
      source_observation_refs: join.refs.slice().sort(),
    },
  ])).values()];
  const fieldScopeBySource = new Map(sourceRows.map((source) => [source.source_system, new Set()]));
  for (const fact of facts) {
    for (const assertion of fact.assertions) {
      if (assertion.field && fieldScopeBySource.has(assertion.source_system)) {
        fieldScopeBySource.get(assertion.source_system).add(assertion.field);
      }
    }
  }
  const sourceOutput = sourceRows.map(({ snapshot: _snapshot, ...source }) => ({
    ...source,
    field_scope: [...(fieldScopeBySource.get(source.source_system) || [])].sort(),
  }));
  return Object.freeze({
    schema: CROSS_SOURCE_EVIDENCE_RECEIPT_SCHEMA,
    version: CROSS_SOURCE_EVIDENCE_RECEIPT_VERSION,
    status: facts.some((fact) => fact.status === "disagrees") ? "disagreement" : "corroborated",
    object_ref: objectId,
    sources: Object.freeze(sourceOutput),
    joins: Object.freeze(uniqueJoins),
    facts: Object.freeze(facts),
    generated_at: generatedAt,
  });
}

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function sourceLink(source) {
  const id = source.source_native_id ? ` <code>${esc(source.source_native_id)}</code>` : "";
  return source.source_href
    ? `<a class="cross-source-evidence-source-link" href="${esc(source.source_href)}" target="_blank" rel="noopener noreferrer">${esc(source.source_name)}<span aria-hidden="true">↗</span></a>${id}`
    : `${esc(source.source_name)}${id}`;
}

function factHtml(fact) {
  const stateLabel = fact.status === "disagrees" ? "Sources disagree" : "Sources agree";
  const assertionItems = fact.assertions.map((assertion) => {
    const value = assertion.assertion == null ? assertion.assertion_label : assertion.assertion;
    const metadata = [
      assertion.provenance.coverage_label,
      assertion.provenance.as_of ? `as of ${assertion.provenance.as_of}` : null,
      assertion.field ? `publisher field: ${assertion.field}` : null,
    ].filter(Boolean).join(" · ");
    return `<li class="cross-source-evidence-assertion" data-source-system="${esc(assertion.source_system)}"><div><strong>${esc(assertion.source_name)}</strong> <span class="cross-source-evidence-assertion-value">${esc(value)}</span> <span class="cross-source-evidence-assertion-kind">source assertion</span></div><div class="cross-source-evidence-provenance">${sourceLink(assertion)}${metadata ? ` · ${esc(metadata)}` : ""}</div></li>`;
  }).join("");
  return `<article class="cross-source-evidence-fact cross-source-evidence-fact-${esc(fact.status)}" data-fact-key="${esc(fact.key)}"><h3>${esc(fact.label)} <span class="cross-source-evidence-state">${esc(stateLabel)}</span></h3><ul>${assertionItems}</ul>${fact.status === "disagrees" ? `<p class="cross-source-evidence-honesty">Each publisher's value is shown as reported; CityScroll has not selected a winning value.</p>` : ""}</article>`;
}

/** Render the receipt without creating a request-time source lookup. */
export function renderCrossSourceEvidenceReceipt(receipt) {
  if (!receipt || !Array.isArray(receipt.sources) || receipt.sources.length < 2
      || !Array.isArray(receipt.facts) || !receipt.facts.length) return "";
  const sourceNames = receipt.sources.map((source) => source.source_name).join(" and ");
  const methods = [...new Set((receipt.joins || []).map((join) => join.basis_label).filter(Boolean))].join("; ");
  const sourceCards = receipt.sources.map((source) => `<li class="cross-source-evidence-source"><strong>${sourceLink(source)}</strong><span>${esc(source.coverage_label || source.coverage || "Coverage not stated")}</span><span>${source.as_of ? `As of ${esc(source.as_of)}` : "As-of date not published"}</span><span>Accepted join: ${esc((source.accepted_join_methods || []).map((method) => method.label).join("; ") || methods || "Exact identifier")}</span><span>Fields in receipt: ${esc((source.field_scope || []).join(", ") || "Not published")}</span></li>`).join("");
  return `<section class="node-section node-card cross-source-evidence-receipt" data-cross-source-evidence-receipt="1" data-receipt-status="${esc(receipt.status)}" aria-labelledby="cross-source-evidence-heading"><h2 id="cross-source-evidence-heading">Cross-source evidence</h2><p class="cross-source-evidence-lead"><strong>Also recorded in ${esc(sourceNames)}</strong>. These records are linked by an accepted exact identifier; the fields below keep each publisher's assertion visible.</p><ul class="cross-source-evidence-sources">${sourceCards}</ul><div class="cross-source-evidence-facts">${receipt.facts.map(factHtml).join("")}</div></section>`;
}

export const crossSourceEvidenceReceiptFacts = FACT_DEFINITIONS;
