import { createHash } from "node:crypto";

import {
  OCP_SITE_EVIDENCE_SELECT_COLS,
  rowToSiteEvidenceSource,
} from "./ocp_lookup.mjs";
import {
  addressShardKey,
  parseAddressQuery,
  resolveAddressFromShard,
} from "../../site/precomputed_address_geocoder.mjs";

export const PROCUREMENT_SITE_EVIDENCE_SCHEMA = "cityscroll.procurement_site_evidence.v1";
export const PAD_RESOLVER_VERSION = "26b";
export const PAD_RESOLVER_METHOD = "nyc_dcp_pad_snapshot";
export const SOURCE_SYSTEMS = Object.freeze({
  OCP: "ocp_recent_contract_awards",
  CITY_RECORD: "city_record_online",
});

const OCP_DATASET_ID = "qyyg-4tf5";
const CITY_RECORD_DATASET_ID = "dg92-zbpx";
const OCP_URL = "https://data.cityofnewyork.us/resource/qyyg-4tf5.json";
const CITY_RECORD_URL = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const AWARD_BODY_FIELDS = Object.freeze([
  "additional_description_1",
  "additional_description_2",
  "additional_description_3",
  "other_info_1",
  "other_info_2",
  "other_info_3",
]);
const STREET_TYPES = "Street|St\\.?|Avenue|Ave\\.?|Boulevard|Blvd\\.?|Road|Rd\\.?|Place|Pl\\.?|Drive|Dr\\.?|Court|Ct\\.?|Lane|Ln\\.?|Way|Parkway|Pkwy\\.?|Circle|Cir\\.?|Terrace|Ter\\.?|Broadway";
const ADDRESS_RE = new RegExp(
  `\\b(\\d{1,6}(?:-\\d{1,3})?(?:\\s+[A-Za-z])?(?:\\s+[A-Za-z0-9'’.-]+){0,6}\\s+(?:${STREET_TYPES}))\\b`,
  "gi",
);
const EPIN_RE = /(?:E[- ]?PIN|EPIN|PIN)\s*#?\s*[:#]?\s*([0-9]{5}[A-Z][A-Z0-9]{6,})/gi;
const SECTION_RE = /IN\s+THE\s+MATTER\s+OF/gi;
const SERVICE_WORD_RE = /\b(?:facility|facilities|residence|shelter|annex|site|kiosk|cleaning|janitorial|service|services|house|upgrade|renovation|location)\b/i;
const BOROUGH_RE = /\b(?:Bronx|Brooklyn|Queens|Manhattan|Staten Island|New York)\b(?:\s*,?\s*NY)?(?:\s+\d{5}(?:-\d{4})?)?/i;

export const SITE_EVIDENCE_SOURCE_FIELDS = Object.freeze([
  ...OCP_SITE_EVIDENCE_SELECT_COLS,
  "parent_notice_id",
  "contract_section",
]);

function text(value) {
  return String(value == null ? "" : value);
}

function cleanText(value) {
  return text(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&rsquo;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\u001a/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(value) {
  return createHash("sha256").update(text(value)).digest("hex");
}

function normalized(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sourceUrl(sourceSystem, requestId) {
  const base = sourceSystem === SOURCE_SYSTEMS.OCP ? OCP_URL : CITY_RECORD_URL;
  return `${base}?$where=request_id='${encodeURIComponent(text(requestId))}'`;
}

function pinKey(value) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function valueForField(row, field) {
  return row?.[field] == null ? "" : text(row[field]);
}

function bodyFields(row) {
  return AWARD_BODY_FIELDS
    .map((field) => ({ field, value: valueForField(row, field) }))
    .filter(({ value }) => value.trim());
}

function splitSections(row) {
  const field = bodyFields(row).find(({ field: name }) => name === "additional_description_1")
    || bodyFields(row)[0]
    || { field: "additional_description_1", value: "" };
  const raw = field.value;
  const starts = [...raw.matchAll(SECTION_RE)].map((match) => match.index);
  if (starts.length < 2) {
    return [{
      locator: "body:01",
      source_field: field.field,
      raw_text: raw,
      index: 0,
      epins: [...raw.matchAll(EPIN_RE)].map((match) => match[1].toUpperCase()),
    }];
  }
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? raw.length;
    const rawText = raw.slice(start, end).trim();
    return {
      locator: `body:in-the-matter-of:${String(index + 1).padStart(2, "0")}`,
      source_field: field.field,
      raw_text: rawText,
      index,
      epins: [...rawText.matchAll(EPIN_RE)].map((match) => match[1].toUpperCase()),
    };
  });
}

function retainedAddressRoles(row) {
  return {
    vendor: {
      source_field: "vendor_address",
      published_value: valueForField(row, "vendor_address") || null,
      role: "vendor",
    },
    request: {
      source_field: "address_to_request",
      published_value: valueForField(row, "address_to_request") || null,
      role: "request",
    },
  };
}

function addressParts(rawAddress, suffix = "") {
  const original = cleanText(rawAddress);
  const unitPattern = /\b(?:\d+(?:st|nd|rd|th)\s+floor|(?:suite|ste|unit|apt|apartment|floor|fl)\.?\s*[A-Za-z0-9-]+)\b/i;
  const unitMatch = original.match(unitPattern) || suffix.match(unitPattern);
  const localityMatch = `${original} ${suffix}`.match(BOROUGH_RE);
  const unit = unitMatch?.[0] || null;
  const locality = localityMatch?.[0]?.replace(/^[,\s]+|[,\s]+$/g, "") || null;
  return {
    original_address: original,
    unit,
    locality,
    query_address: [original, locality].filter(Boolean).join(", "),
  };
}

function candidateContext(source, start, end) {
  return source.slice(Math.max(0, start - 100), Math.min(source.length, end + 120));
}

function hasExplicitServiceContext(context, title) {
  return SERVICE_WORD_RE.test(`${context} ${title}`);
}

function extractAddressCandidates(row, section) {
  const title = valueForField(row, "short_title");
  const vendor = normalized(valueForField(row, "vendor_address"));
  const candidates = [];
  const segments = [
    { field: "short_title", value: title },
    ...(section?.raw_text
      ? [{ field: section.source_field || "additional_description_1", value: section.raw_text }]
      : bodyFields(row)),
  ];
  for (const segment of segments) {
    const source = cleanText(segment.value);
    if (!source) continue;
    for (const match of source.matchAll(ADDRESS_RE)) {
      const original = cleanText(match[1]);
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const context = candidateContext(source, start, end);
      const parts = addressParts(original, source.slice(end, end + 80));
      const isVendorValue = vendor && normalized(original) === vendor;
      const explicitService = hasExplicitServiceContext(context, title);
      const historicalAddress = /\b(?:former|previous|old)\s+(?:offices?|locations?)\b/i.test(
        source.slice(Math.max(0, start - 100), start),
      );
      const vendorIntroduction = /\b(?:vendor|contractor|proposed contractor|located at)\b/i.test(
        source.slice(Math.max(0, start - 70), start),
      );
      const vendorLead = isVendorValue && vendorIntroduction && (
        /\b(?:to provide|for the provision|for provision)\b/i.test(source.slice(end, end + 150))
        || !SERVICE_WORD_RE.test(title)
      );
      if (!explicitService || historicalAddress || (isVendorValue && vendorLead)) continue;
      candidates.push({
        ...parts,
        published_value: original,
        passage: context,
        passage_start: start,
        evidence_role: /\bannex\b/i.test(context) ? "annex_site" : "facility_service_site",
        source_field: segment.field,
        source_text_hash: sha256(segment.value),
      });
    }
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${normalized(candidate.original_address)}|${candidate.passage_start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectedSectionForHearing(row, selectedPins) {
  const sections = splitSections(row);
  return sections.map((section) => {
    const discovered = section.epins.map(pinKey);
    const matched = [...selectedPins].find((pin) => discovered.includes(pin));
    return { ...section, matched_epin: matched || null };
  });
}

function resolveSite(candidate, resolver) {
  const parts = candidate;
  const query = parseAddressQuery(parts.query_address);
  const metadata = {
    method: PAD_RESOLVER_METHOD,
    version: resolver?.manifest?.source?.version || PAD_RESOLVER_VERSION,
    resolved_at: resolver?.manifest?.generated_at || null,
    candidate_cardinality: null,
  };
  if (query.status === "not_full_address") {
    return {
      status: "uncovered",
      reason: "not_full_address",
      bbl: null,
      ...metadata,
    };
  }
  if (!resolver?.manifest || !resolver?.shards) {
    return {
      status: "uncovered",
      reason: "snapshot_unavailable",
      bbl: null,
      ...metadata,
    };
  }
  const key = addressShardKey(query.street, resolver.manifest.shard_count);
  const shard = resolver.shards instanceof Map ? resolver.shards.get(key) : resolver.shards[key];
  const resolved = resolveAddressFromShard(query, shard, resolver.manifest);
  return {
    status: resolved.status === "matched" ? "resolved" : resolved.status === "unknown" && resolved.reason === "ambiguous" ? "ambiguous" : "uncovered",
    reason: resolved.status === "matched" ? null : resolved.reason,
    bbl: resolved.status === "matched" ? resolved.bbl : null,
    candidate_cardinality: resolved.candidate_count ?? (resolved.status === "matched" ? 1 : 0),
    ...metadata,
    candidate_cardinality: resolved.candidate_count ?? (resolved.status === "matched" ? 1 : 0),
  };
}

function makeEvidenceItem({ row, section, candidate, contractScope, resolver, conflict }) {
  const resolved = resolveSite(candidate, resolver);
  const held = conflict || resolved.status !== "resolved";
  const sourceTextHash = candidate.source_text_hash || sha256(section.raw_text || candidate.passage);
  return {
    evidence_id: `${SOURCE_SYSTEMS.CITY_RECORD === contractScope.source_system ? "city-record" : "ocp"}:${row.request_id}:${section.locator}:${candidate.passage_start}`,
    source_system: contractScope.source_system,
    request_id: text(row.request_id) || null,
    parent_notice_id: contractScope.parent_notice_id || text(row.request_id) || null,
    contract_section: contractScope.section_locator || "body:01",
    epin: contractScope.epin || pinKey(row.pin) || null,
    source_url: sourceUrl(contractScope.source_system, row.request_id),
    source_field: candidate.source_field,
    passage_locator: `${section.locator}:chars-${candidate.passage_start}-${candidate.passage_start + candidate.published_value.length}`,
    published_value: candidate.published_value,
    passage: candidate.passage,
    source_text_hash: sourceTextHash,
    evidence_role: candidate.evidence_role,
    contract_scope: {
      source_system: contractScope.source_system,
      request_id: text(row.request_id) || null,
      parent_notice_id: contractScope.parent_notice_id || text(row.request_id) || null,
      epin: contractScope.epin || pinKey(row.pin) || null,
      section_locator: contractScope.section_locator || section.locator,
    },
    original_address: candidate.original_address,
    unit: candidate.unit,
    locality: candidate.locality,
    resolved_bbl: held ? null : resolved.bbl,
    resolution: {
      status: conflict ? "conflicting_target" : resolved.status,
      reason: conflict ? "conflicting_target" : resolved.reason,
      method: resolved.method,
      version: resolved.version,
      resolved_at: resolved.resolved_at,
      candidate_cardinality: resolved.candidate_cardinality,
    },
    provenance: {
      dataset_id: contractScope.source_system === SOURCE_SYSTEMS.OCP ? OCP_DATASET_ID : CITY_RECORD_DATASET_ID,
      source_system: contractScope.source_system,
      source_url: sourceUrl(contractScope.source_system, row.request_id),
      source_field: candidate.source_field,
      source_text_hash: sourceTextHash,
      original_address: candidate.original_address,
      unit: candidate.unit,
      locality: candidate.locality,
      resolver: {
        method: resolved.method,
        version: resolved.version,
        date: resolved.resolved_at,
      },
    },
  };
}

function recordReason(row, candidates, sourceAvailable) {
  if (!sourceAvailable) return "acquisition_missing";
  if (!bodyFields(row).length && !candidates.length) return "no_publisher_body";
  if (!candidates.length) return "unsupported_extraction";
  return null;
}

function materializeRecord({ row, sourceSystem, section, epin, resolver }) {
  const sourceAvailable = Boolean(row && (row.request_id || row.pin));
  const candidates = row?._source_acquired === false ? [] : extractAddressCandidates(row, section);
  const scope = {
    source_system: sourceSystem,
    parent_notice_id: text(row.request_id) || null,
    section_locator: section.locator,
    epin: epin || pinKey(row.pin) || null,
  };
  const distinctAddresses = new Map(candidates.map((candidate) => [normalized(candidate.original_address), candidate]));
  const conflict = distinctAddresses.size > 1
    && !candidates.some((candidate) => candidate.evidence_role === "annex_site");
  const evidence = [...distinctAddresses.values()].map((candidate) => makeEvidenceItem({
    row,
    section,
    candidate,
    contractScope: scope,
    resolver,
    conflict,
  }));
  const resolved = evidence.filter((item) => item.resolved_bbl);
  let reason = recordReason(row, candidates, sourceAvailable);
  if (conflict) reason = "conflicting_target";
  else if (resolved.length) reason = "accepted";
  else if (candidates.length && evidence.some((item) => item.resolution.status === "ambiguous")) reason = "ambiguous_target";
  else if (candidates.length && evidence.some((item) => item.resolution.status === "uncovered")) reason = "successful_empty_scope";
  const baseRecord = {
    record_id: `${sourceSystem}:${text(row.request_id) || pinKey(row.pin) || "unknown"}:${section.locator}`,
    source_system: sourceSystem,
    request_id: text(row.request_id) || null,
    parent_notice_id: scope.parent_notice_id,
    epin: scope.epin,
    section_locator: section.locator,
    classification: reason,
    evidence,
  };
  if (!evidence.length) return baseRecord;
  return {
    ...baseRecord,
    parent_notice_id: scope.parent_notice_id,
    epin: scope.epin,
    section_locator: section.locator,
    section_source_text_hash: sha256(section.raw_text || ""),
    title: valueForField(row, "short_title") || null,
    address_roles: retainedAddressRoles(row),
  };
}

function countBy(items, getter) {
  return Object.fromEntries([...items.reduce((counts, item) => {
    const key = getter(item);
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const shaped = rowToSiteEvidenceSource(row);
    if (shaped && row?._source_acquired != null) shaped._source_acquired = Boolean(row._source_acquired);
    return shaped;
  }).filter(Boolean);
}

export function sourceAcquisitionSelect() {
  return OCP_SITE_EVIDENCE_SELECT_COLS.join(",");
}

export function selectExactProcurementInputs({ retainedAwardRows = [], awardRows = [], hearingRows = [] } = {}) {
  const retained = normalizeRows(retainedAwardRows);
  const awards = normalizeRows(awardRows);
  const byId = new Map(awards.map((row) => [text(row.request_id), row]));
  const selectedAwardIds = [...new Set(retained.map((row) => text(row.request_id)).filter(Boolean))].sort();
  const selectedAwards = selectedAwardIds.map((id) => byId.get(id) || retained.find((row) => text(row.request_id) === id) || { request_id: id });
  const selectedPins = new Set(selectedAwards.map((row) => pinKey(row.pin)).filter(Boolean));
  const selectedHearings = normalizeRows(hearingRows).filter((row) => {
    const structured = pinKey(row.pin);
    if (structured && selectedPins.has(structured)) return true;
    return [...selectedPins].some((pin) => cleanText(valueForField(row, "additional_description_1")).toUpperCase().includes(pin));
  });
  return {
    selectedAwardIds,
    selectedAwards,
    selectedHearings,
    selectedPins,
    acquisition: {
      retained_award_ids: selectedAwardIds.length,
      award_rows_acquired: selectedAwards.filter((row) => byId.has(text(row.request_id))).length,
      award_rows_missing: selectedAwardIds.filter((id) => !byId.has(id)),
      hearing_rows_reached_by_exact_identifier: selectedHearings.length,
    },
  };
}

export function materializeProcurementSiteEvidence({
  retainedAwardRows = [],
  awardRows = [],
  hearingRows = [],
  resolver = null,
  sourceSnapshot = null,
} = {}) {
  const selected = selectExactProcurementInputs({ retainedAwardRows, awardRows, hearingRows });
  const records = [];
  for (const row of selected.selectedAwards) {
    const sections = splitSections(row);
    records.push(materializeRecord({ row, sourceSystem: SOURCE_SYSTEMS.OCP, section: sections[0], resolver }));
  }
  for (const row of selected.selectedHearings) {
    for (const section of selectedSectionForHearing(row, selected.selectedPins)) {
      if (!section.matched_epin) continue;
      records.push(materializeRecord({
        row,
        sourceSystem: SOURCE_SYSTEMS.CITY_RECORD,
        section,
        epin: section.matched_epin,
        resolver,
      }));
    }
  }
  records.sort((left, right) => left.record_id.localeCompare(right.record_id));
  const evidence = records.flatMap((record) => record.evidence);
  const doc = {
    schema: PROCUREMENT_SITE_EVIDENCE_SCHEMA,
    source_snapshot: sourceSnapshot,
    resolver: {
      method: PAD_RESOLVER_METHOD,
      version: resolver?.manifest?.source?.version || PAD_RESOLVER_VERSION,
      date: resolver?.manifest?.generated_at || null,
    },
    acquisition: selected.acquisition,
    population: {
      selected_award_ids: selected.selectedAwardIds.length,
      retained_records: records.length,
      evidence_items: evidence.length,
      accepted_sites: evidence.filter((item) => item.resolved_bbl).length,
      by_classification: countBy(records, (record) => record.classification),
      by_resolution_status: countBy(evidence, (item) => item.resolution.status),
      selected_award_coverage: selected.acquisition.award_rows_missing.length === 0 ? "complete" : "incomplete",
    },
    graph_edges: [],
    records,
  };
  return doc;
}

export function validateProcurementSiteEvidence(doc) {
  if (doc?.schema !== PROCUREMENT_SITE_EVIDENCE_SCHEMA) throw new Error("procurement site evidence schema mismatch");
  if (!Array.isArray(doc.records) || !Array.isArray(doc.graph_edges)) throw new Error("procurement site evidence shape mismatch");
  if (doc.graph_edges.length) throw new Error("site evidence must not emit production graph edges");
  for (const record of doc.records) {
    if (!record.record_id || !record.source_system || !record.classification) throw new Error("site evidence record missing identity or classification");
    if (record.source_system === SOURCE_SYSTEMS.CITY_RECORD && !record.epin) throw new Error("hearing evidence missing section EPIN");
    for (const item of record.evidence) {
      for (const required of ["source_url", "source_field", "passage_locator", "published_value", "evidence_role", "contract_scope", "provenance"]) {
        if (!item[required]) throw new Error(`site evidence item missing ${required}`);
      }
      if (item.resolution.status === "resolved" && !/^\d{10}$/.test(item.resolved_bbl || "")) throw new Error("resolved site evidence missing BBL");
      if (item.resolution.status !== "resolved" && item.resolved_bbl) throw new Error("unresolved site evidence has BBL");
    }
  }
  return doc;
}

export { cleanText, splitSections, extractAddressCandidates, resolveSite };
