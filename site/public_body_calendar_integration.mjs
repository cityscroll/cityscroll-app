import {
  PUBLIC_BODY_CALENDAR_CONTRACT_IDS,
  PUBLIC_BODY_CALENDAR_SOURCE_SYSTEM,
  buildPublicBodyCalendarCoverage,
  normalizePublicBodyCalendarMeeting,
} from "./public_body_calendar_contract.mjs";

export const PUBLIC_BODY_CALENDAR_INTEGRATION_SCHEMA = "cityscroll.public_body_calendar_integration.v1";

const SOURCE_KEYS = Object.freeze([
  "nycps_pep",
  "ccrb_board",
  "brooklyn_borough_board",
  "brooklyn_bp_ulurp",
  "hplus_h_cab",
]);
const ALIAS_EVIDENCE = new Set([
  "exact_publisher_identifier",
  "exact_permalink_identity",
  "publisher_identifier",
  "permalink",
]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function sourceFor(sources, contractId) {
  if (!sources || typeof sources !== "object") return null;
  return sources[contractId]
    || sources[`${contractId}Index`]
    || sources[contractId.replaceAll("_", "-")]
    || null;
}

function sourceRows(source) {
  return Array.isArray(source?.rows)
    ? source.rows
    : Array.isArray(source?.records) ? source.records : [];
}

function sourceObservation(source, contractId) {
  const coverage = Array.isArray(source?.coverage)
    ? source.coverage.find((entry) => entry?.source_contract_id === contractId)
    : null;
  const observation = source?.observation || source?.observed || null;
  if (observation) return { ...observation, source_contract_id: contractId };
  if (coverage?.status === "failed") {
    return { source_contract_id: contractId, status: "failed", observed_at: coverage.observed_at || null };
  }
  if (coverage?.observed_at || source?.generated_at) {
    return {
      source_contract_id: contractId,
      observed_at: coverage?.observed_at || source.generated_at,
      row_count: coverage?.row_count ?? sourceRows(source).length,
    };
  }
  return null;
}

function directRows(sourceMap) {
  return Array.isArray(sourceMap?.rows)
    ? sourceMap.rows
    : Array.isArray(sourceMap?.meetings) ? sourceMap.meetings : [];
}

function normalizeObservationList(input, sources) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    if (Array.isArray(input.observations)) return input.observations;
    if (Array.isArray(input.coverage)) return input.coverage;
    return Object.entries(input).map(([source_contract_id, observation]) => ({
      ...(observation || {}),
      source_contract_id,
    }));
  }
  return SOURCE_KEYS.map((contractId) => sourceObservation(sourceFor(sources, contractId), contractId))
    .filter(Boolean);
}

function aliasEndpoints(alias) {
  if (Array.isArray(alias?.meeting_ids) && alias.meeting_ids.length === 2) return alias.meeting_ids;
  return [
    alias?.left_meeting_id || alias?.left || alias?.from,
    alias?.right_meeting_id || alias?.right || alias?.to,
  ];
}

function aliasEvidence(alias) {
  const evidence = alias?.evidence && typeof alias.evidence === "object" ? alias.evidence : {};
  const kind = text(evidence.kind || alias?.evidence_kind);
  const value = text(evidence.value || evidence.identifier || evidence.permalink);
  if (!kind || !ALIAS_EVIDENCE.has(kind) || evidence.exact !== true || !value) {
    throw new TypeError("public body calendar aliases require exact evidence");
  }
  return { kind, value, exact: true, source_url: text(evidence.source_url) };
}

function evidenceMatches(row, evidence) {
  if (evidence.kind === "publisher_identifier" || evidence.kind === "exact_publisher_identifier") {
    return row.publisher_identifier === evidence.value
      || row.source_raw_values?.publisher_identifier === evidence.value;
  }
  return [
    row.source_url,
    row.official_source_url,
    row.source_raw_values?.publisher_permalink,
    row.source_raw_values?.publisher_url,
  ].includes(evidence.value);
}

function relationFor(ids, evidence) {
  return {
    status: "matched",
    method: evidence.kind,
    meeting_ids: [...ids].sort(),
    evidence,
  };
}

function applyAliases(rows, aliases) {
  const byId = new Map(rows.map((row) => [row.meeting_id, row]));
  const memberships = new Map();
  const relations = [];
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const ids = [...new Set(aliasEndpoints(alias).map(text).filter(Boolean))];
    if (ids.length !== 2 || ids.some((id) => !byId.has(id))) {
      throw new TypeError("public body calendar alias must name two known meeting ids");
    }
    const evidence = aliasEvidence(alias);
    if (ids.some((id) => !evidenceMatches(byId.get(id), evidence))) {
      throw new TypeError("public body calendar alias evidence does not match both meeting identities");
    }
    const relation = relationFor(ids, evidence);
    relations.push(relation);
    const group = new Set(ids);
    for (const id of ids) {
      const prior = memberships.get(id);
      if (prior) for (const priorId of prior) group.add(priorId);
    }
    for (const id of group) memberships.set(id, group);
  }
  const linkedRows = rows.map((row) => {
    const group = memberships.get(row.meeting_id);
    if (!group) return row;
    const evidence = relations.find((relation) => relation.meeting_ids.includes(row.meeting_id))?.evidence;
    return {
      ...row,
      delivery_aliases: [...group].sort(),
      same_proceeding: relationFor(group, evidence),
    };
  });
  return { rows: linkedRows, relations };
}

function applySupersessions(rows, supersessions) {
  const byId = new Map(rows.map((row) => [row.meeting_id, row]));
  const retired = new Set();
  const relations = [];
  for (const entry of Array.isArray(supersessions) ? supersessions : []) {
    const supersededId = text(entry?.superseded_meeting_id || entry?.superseded);
    const replacementId = text(entry?.replacement_meeting_id || entry?.replacement);
    const superseded = byId.get(supersededId);
    const replacement = byId.get(replacementId);
    if (!superseded || !replacement) throw new TypeError("public body calendar supersession must name known meetings");
    if (superseded.temporal_basis !== "published_recurrence" || replacement.temporal_basis !== "explicit_instance") {
      throw new TypeError("public body calendar supersession must replace a recurrence with an explicit instance");
    }
    retired.add(supersededId);
    relations.push({
      superseded_meeting_id: supersededId,
      replacement_meeting_id: replacementId,
      relation: "explicit_instance_supersedes_published_recurrence",
      evidence: entry.evidence || { source_url: replacement.source_url || null },
    });
  }
  return {
    rows: rows.filter((row) => !retired.has(row.meeting_id)),
    relations,
  };
}

/**
 * Compose the five adapter indexes into the one bounded public-body source.
 * Similar titles, dates, venues, and clocks are deliberately never identity
 * evidence. Cross-posting is opt-in through an exact publisher id or permalink.
 */
export function buildPublicBodyCalendarIndex({
  sources = null,
  observations = null,
  aliases = [],
  supersessions = [],
  now = new Date().toISOString(),
  ...direct
} = {}) {
  const sourceMap = sources || direct;
  const rows = [];
  const seenIds = new Set();
  const sourceEntries = directRows(sourceMap).length
    ? [[null, directRows(sourceMap)]]
    : SOURCE_KEYS.map((contractId) => [contractId, sourceRows(sourceFor(sourceMap, contractId))]);
  for (const [contractId, sourceRecords] of sourceEntries) {
    for (const rawRow of sourceRecords) {
      const row = normalizePublicBodyCalendarMeeting(rawRow);
      if (contractId && row.source_contract_id !== contractId) {
        throw new TypeError(`public body calendar source contract mismatch: ${contractId}`);
      }
      if (seenIds.has(row.meeting_id)) throw new TypeError(`public body calendar identity collision: ${row.meeting_id}`);
      seenIds.add(row.meeting_id);
      rows.push({
        ...row,
        ...(Array.isArray(rawRow.delivery_aliases) ? { delivery_aliases: rawRow.delivery_aliases } : {}),
        ...(rawRow.same_proceeding && typeof rawRow.same_proceeding === "object"
          ? { same_proceeding: rawRow.same_proceeding } : {}),
      });
    }
  }
  const superseded = applySupersessions(rows, supersessions);
  const linked = applyAliases(superseded.rows, aliases);
  const observed = normalizeObservationList(observations || sourceMap, sourceMap);
  const coverage = buildPublicBodyCalendarCoverage({ observations: observed, now });
  return {
    schema: PUBLIC_BODY_CALENDAR_INTEGRATION_SCHEMA,
    family: PUBLIC_BODY_CALENDAR_SOURCE_SYSTEM,
    contract_ids: [...PUBLIC_BODY_CALENDAR_CONTRACT_IDS],
    generated_at: now,
    rows: linked.rows,
    meetings: linked.rows,
    documents: linked.rows.flatMap((row) => row.meeting_documents || []),
    observations: observed,
    coverage: coverage.contracts,
    aliases: linked.relations,
    supersessions: superseded.relations,
  };
}

export const integratePublicBodyCalendars = buildPublicBodyCalendarIndex;
