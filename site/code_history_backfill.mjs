/**
 * Prioritized historical backfill for the NYC Administrative Code.
 *
 * Historical coverage grows where measurement says it explains the most: the
 * sections other provisions cite most often and the sections the publisher
 * records as changed most often. A batch is bounded by an explicit cutoff, and
 * every period without retained historical evidence stays an explicit unknown
 * interval. Missing or conflicting evidence is retained as such; no interval is
 * filled by interpolation and no secondary source stands in for the official
 * record.
 */

import backfillReadModel from "./data/code_history_backfill.json" with { type: "json" };
import { codeChange, normalizeCodeChangeOperation } from "../ontology/legal_change.mjs";
import { normalizeAdminCodeCitation } from "./admin_code_search.mjs";
import { codeVersionRecord } from "./code_version_materialization.mjs";

export const HISTORY_OBSERVATION_SCHEMA = "cityscroll.code_history_observation.v1";
export const BACKFILL_RANKING_SCHEMA = "cityscroll.code_history_backfill_ranking.v1";
export const BACKFILL_BATCH_SCHEMA = "cityscroll.code_history_backfill_batch.v1";
export const BACKFILL_COVERAGE_SCHEMA = "cityscroll.code_history_backfill_coverage.v1";
export const BACKFILL_CONFLICT_SCHEMA = "cityscroll.code_history_conflict.v1";

export const ADMIN_CODE_CORPUS_ID = "nyc-administrative-code";

/** Deterministic ranking weights. Changing one changes the batch fingerprint. */
export const BACKFILL_RANKING_WEIGHTS = Object.freeze({
  inbound_reference: 3,
  retained_change: 12,
  distinct_instrument: 4,
  mandate_join: 4,
  authority_citation: 4,
});

export const OBSERVATION_STATUSES = Object.freeze(["retained", "unparsed"]);
export const INSTRUMENT_KINDS = Object.freeze(["local_law", "state_law", "unknown"]);

const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const LOCAL_LAW = /\bL\.?\s?L\.?\s*(\d{4})\s*\/\s*(\d{1,4})\b/i;
const STATE_LAW = /\b(\d{4})\s+N\.?\s?Y\.?\s+Laws\s+Ch(?:\.|apter)?\s*(\d{1,4})\b/i;
const FORMER_CITATION = /\bfrom\s+former\s+§?\s*(\d+[A-Za-z]?-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)/i;
const HISTORY_NOTE = /\(([^()]{0,900}?(?:L\.?\s?L\.?\s*\d{4}\s*\/\s*\d{1,4}|N\.?\s?Y\.?\s+Laws\s+Ch)[^()]{0,900}?)\)\s*$/;

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
}

function clean(value, max = 2_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isoDate(value) {
  const match = clean(value, 40).match(MDY);
  if (!match) return null;
  const [, month, day, year] = match;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

function isoDay(value) {
  const text = clean(value, 40);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/** Natural citation order so section 20-9 sorts before section 20-10. */
export function compareCitations(left, right) {
  const a = String(left ?? "").replace(/^§\s*/, "").split(/[-.]/);
  const b = String(right ?? "").replace(/^§\s*/, "").split(/[-.]/);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? "";
    const y = b[index] ?? "";
    const nx = Number.parseInt(x, 10);
    const ny = Number.parseInt(y, 10);
    if (Number.isFinite(nx) && Number.isFinite(ny) && nx !== ny) return nx - ny;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function operationFromFragment(fragment, { first = false } = {}) {
  const text = clean(fragment, 400);
  if (/^re-?numbered\s+and\s+amended\b/i.test(text)) {
    return { operations: ["redesignate", "amend"], basis: "source_stated" };
  }
  if (/^re-?numbered\b/i.test(text) || /\brenumbered\s+from\s+former\b/i.test(text)) {
    return { operations: ["redesignate"], basis: "source_stated" };
  }
  if (/^repealed[.,]?(?=[\s,]|$)/i.test(text)) return { operations: ["repeal"], basis: "source_stated" };
  if (/^am(?:ended|\.)?(?=[\s,])/i.test(text)) return { operations: ["amend"], basis: "source_stated" };
  if (/^added(?=[\s,]|$)/i.test(text)) return { operations: ["add"], basis: "source_stated" };
  if (first) return { operations: ["add"], basis: "publisher_note_convention" };
  return { operations: [], basis: "unresolved" };
}

function instrumentFromFragment(fragment) {
  const localLaw = LOCAL_LAW.exec(fragment);
  if (localLaw) {
    const year = localLaw[1];
    const number = String(Number.parseInt(localLaw[2], 10));
    return {
      instrument_kind: "local_law",
      instrument_ref: `local-law:${number}-${year}`,
      instrument_label: `Local Law ${number} of ${year}`,
      local_law_number: `${year}/${localLaw[2]}`,
    };
  }
  const stateLaw = STATE_LAW.exec(fragment);
  if (stateLaw) {
    const year = stateLaw[1];
    const chapter = String(Number.parseInt(stateLaw[2], 10));
    return {
      instrument_kind: "state_law",
      instrument_ref: `ny-laws:${year}:ch-${chapter}`,
      instrument_label: `${year} New York Laws chapter ${chapter}`,
      local_law_number: null,
    };
  }
  return { instrument_kind: "unknown", instrument_ref: null, instrument_label: null, local_law_number: null };
}

/**
 * Read the publisher's trailing amendment note.
 *
 * The note is the publisher's own statement about which instrument changed the
 * section and when it took effect. Fragments that yield no instrument or no
 * operation are retained verbatim as unparsed rather than guessed.
 */
export function parseHistoryNote(text) {
  const body = String(text ?? "");
  const note = HISTORY_NOTE.exec(body.trim());
  if (!note) return freeze({ note_text: null, entries: [], unparsed: [] });
  const noteText = clean(note[1], 900);
  const entries = [];
  const unparsed = [];
  const fragments = noteText.split(";").map((fragment) => clean(fragment, 400)).filter(Boolean);
  fragments.forEach((fragment, index) => {
    const instrument = instrumentFromFragment(fragment);
    const { operations, basis } = operationFromFragment(fragment, { first: index === 0 });
    const effectiveMatch = /\b(retro\.\s*)?eff\.\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(fragment);
    const effectiveAt = effectiveMatch ? isoDate(effectiveMatch[2]) : null;
    const dates = [...fragment.matchAll(/(\d{1,2}\/\d{1,2}\/\d{4})/g)].map((match) => isoDate(match[1]));
    const signedAt = dates.find((date) => date && date !== effectiveAt) || (effectiveAt ? null : dates[0] || null);
    const formerCitation = FORMER_CITATION.exec(fragment);
    if (!instrument.instrument_ref || !operations.length) {
      unparsed.push(freeze({
        sequence: index,
        raw: fragment,
        instrument_kind: instrument.instrument_kind,
        instrument_ref: instrument.instrument_ref,
        reason: instrument.instrument_ref ? "no stated operation" : "no stated instrument",
      }));
      return;
    }
    for (const operation of operations) {
      entries.push(freeze({
        sequence: index,
        operation,
        operation_basis: basis,
        ...instrument,
        signed_at: signedAt,
        effective_at: effectiveAt,
        effective_basis: effectiveAt
          ? (effectiveMatch?.[1] ? "retroactive" : "stated")
          : "unknown",
        former_citation: formerCitation ? normalizeAdminCodeCitation(formerCitation[1]) : null,
        raw: fragment,
      }));
    }
  });
  return freeze({ note_text: noteText, entries, unparsed });
}

/**
 * Turn one provision's publisher note into retained historical observations.
 * Every observation keeps corpus, provision identity, source document, source
 * URL, observed time, and the legal effective time when the source states one.
 */
export function historicalObservations(provision, { note = null } = {}) {
  if (!provision?.id) return freeze([]);
  const parsed = note || parseHistoryNote(provision.current_text || provision.text || "");
  const source = provision.source || {};
  const base = {
    schema: HISTORY_OBSERVATION_SCHEMA,
    corpus_id: provision.corpus_id || ADMIN_CODE_CORPUS_ID,
    provision_id: provision.id,
    citation: provision.citation || null,
    source_system: source.system || null,
    source_ref: source.source_ref || null,
    source_url: source.url || null,
    observed_at: source.observed_at || null,
    content_hash: source.content_hash || null,
  };
  const retained = parsed.entries.map((entry) => freeze({
    ...base,
    status: "retained",
    id: `${provision.id}:${entry.sequence}:${entry.operation}:${entry.instrument_ref}`,
    ...entry,
  }));
  const unresolved = parsed.unparsed.map((entry) => freeze({
    ...base,
    status: "unparsed",
    id: `${provision.id}:${entry.sequence}:unparsed`,
    sequence: entry.sequence,
    operation: null,
    operation_basis: "unresolved",
    instrument_kind: entry.instrument_kind,
    instrument_ref: entry.instrument_ref,
    instrument_label: null,
    signed_at: null,
    effective_at: null,
    effective_basis: "unknown",
    former_citation: null,
    reason: entry.reason,
    raw: entry.raw,
  }));
  return freeze([...retained, ...unresolved]);
}

/**
 * Project retained observations onto the existing CodeChange contract so a
 * historical change stays traversable from the instrument that made it.
 * A state chapter law keeps its own instrument identity and never claims a
 * Local Law edge.
 */
export function historicalCodeChanges(observations = [], { provision = null } = {}) {
  const changes = [];
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (observation?.status !== "retained") continue;
    const operation = normalizeCodeChangeOperation(observation.operation);
    if (!operation || !observation.instrument_ref) continue;
    const citation = String(observation.citation || provision?.citation || "").replace(/^§\s*/, "");
    const redesignation = operation === "redesignate" && observation.former_citation
      ? {
        former_citation: `§ ${observation.former_citation}`,
        former_label: `§ ${observation.former_citation}`,
        successor_citation: observation.citation || null,
        successor_provision_id: observation.provision_id,
      }
      : null;
    changes.push(codeChange({
      id: `${observation.instrument_ref}:${operation}:${observation.provision_id}:note-${observation.sequence}`,
      operation,
      legal_instrument_id: observation.instrument_ref,
      state: "enacted",
      effective_at: observation.effective_at,
      effective_date_text: observation.effective_basis === "retroactive"
        ? `Publisher states a retroactive effective date of ${observation.effective_at}.`
        : null,
      target: {
        corpus_id: observation.corpus_id || ADMIN_CODE_CORPUS_ID,
        citation: citation ? `§ ${citation}` : null,
        id: observation.provision_id,
        resolution: "exact_citation",
        heading: provision?.heading || null,
      },
      redesignation,
      source: {
        instruction_text: observation.raw,
        source_ref: observation.source_ref,
        url: observation.source_url,
        source_system: observation.source_system,
        observed_at: observation.observed_at,
        document_id: observation.source_ref,
        locator: `publisher amendment note, entry ${observation.sequence + 1}`,
      },
      materialization_status: "unresolved",
      materialization_confidence: observation.operation_basis === "source_stated" ? "high" : "medium",
    }));
  }
  return freeze(changes);
}

/**
 * Retain conflicting evidence instead of choosing between sources.
 *
 * Two shapes are detected: one instrument stated more than once for the same
 * provision with different effective dates, and more than one publisher record
 * published under the same citation.
 */
export function historicalConflicts(observations = [], { duplicate_records: duplicateRecords = [] } = {}) {
  const conflicts = [];
  const byInstrument = new Map();
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (observation?.status !== "retained" || !observation.instrument_ref) continue;
    const key = `${observation.provision_id}|${observation.instrument_ref}|${observation.operation}`;
    if (!byInstrument.has(key)) byInstrument.set(key, []);
    byInstrument.get(key).push(observation);
  }
  for (const [key, group] of [...byInstrument.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const dates = [...new Set(group.map((item) => item.effective_at || "unknown"))].sort();
    if (dates.length < 2) continue;
    conflicts.push(freeze({
      schema: BACKFILL_CONFLICT_SCHEMA,
      kind: "effective_date_disagreement",
      provision_id: group[0].provision_id,
      instrument_ref: group[0].instrument_ref,
      key,
      stated_effective_dates: dates,
      resolution: "unresolved",
      observations: group.map((item) => item.id),
    }));
  }
  for (const record of Array.isArray(duplicateRecords) ? duplicateRecords : []) {
    if (!record?.provision_id) continue;
    conflicts.push(freeze({
      schema: BACKFILL_CONFLICT_SCHEMA,
      kind: "duplicate_publisher_record",
      provision_id: record.provision_id,
      instrument_ref: null,
      key: `${record.provision_id}|duplicate-record`,
      stated_effective_dates: [],
      resolution: "unresolved",
      observations: Array.isArray(record.records) ? record.records.map((item) => clean(item, 240)) : [],
    }));
  }
  return freeze(conflicts);
}

/**
 * Retain a historical version only when an acquired observation carries both
 * the text and a source-stated validity start. Everything else stays an
 * unknown interval.
 */
export function retainHistoricalVersions(provision, acquired = []) {
  const versions = [];
  const rejected = [];
  for (const item of Array.isArray(acquired) ? acquired : []) {
    const provisionId = item?.provision_id || null;
    const validFrom = isoDay(item?.valid_from);
    const text = String(item?.text ?? "");
    if (!provision?.id || provisionId !== provision.id) {
      rejected.push(freeze({ id: item?.id || null, reason: "observation carries a different provision identity" }));
      continue;
    }
    if (!validFrom) {
      rejected.push(freeze({ id: item?.id || null, reason: "source states no legal validity start" }));
      continue;
    }
    if (!text.trim()) {
      rejected.push(freeze({ id: item?.id || null, reason: "source carries no historical text" }));
      continue;
    }
    if (!item?.source_ref && !item?.source_url) {
      rejected.push(freeze({ id: item?.id || null, reason: "source reference is absent" }));
      continue;
    }
    versions.push(freeze({
      ...codeVersionRecord({
        id: item.id || null,
        provision_id: provisionId,
        valid_from: validFrom,
        valid_to: isoDay(item.valid_to),
        text,
        source_ref: item.source_ref || item.source_url,
        observed_at: item.observed_at || null,
        content_hash: item.content_hash || null,
        status: clean(item.status, 40) || "current",
      }),
      change_basis: "source_stated",
      materialization_status: "materialized",
      materialization_confidence: clean(item.materialization_confidence, 40) || "high",
      backfill_batch_id: clean(item.batch_id, 120) || null,
    }));
  }
  const ordered = versions.sort((left, right) => String(left.valid_from).localeCompare(String(right.valid_from)));
  return freeze({ versions: ordered, rejected });
}

/**
 * Split the provision's timeline at every source-stated change date and label
 * each segment by what CityScroll actually holds for it. Interval edges come
 * only from dates a source stated; a segment with no retained text stays
 * unknown instead of borrowing text from a neighbouring segment.
 */
export function coverageIntervals({
  observations = [],
  versions = [],
  observed_at: observedAt = null,
  current_text_status: currentTextStatus = "retained",
} = {}) {
  const boundaries = [...new Set(
    (Array.isArray(observations) ? observations : [])
      .filter((item) => item?.status === "retained" && item.effective_at)
      .map((item) => item.effective_at),
  )].sort();
  const covered = (Array.isArray(versions) ? versions : [])
    .map((version) => ({ from: isoDay(version?.valid_from), to: isoDay(version?.valid_to) }))
    .filter((interval) => interval.from);
  const coveringVersion = (from, to) => covered.find((interval) => (
    from !== null && interval.from <= from && Boolean(to) && (!interval.to || interval.to >= to)
  )) || null;
  const addedAt = (Array.isArray(observations) ? observations : [])
    .filter((item) => item?.status === "retained" && item.operation === "add" && item.effective_at)
    .map((item) => item.effective_at)
    .sort()[0] || null;
  const horizon = isoDay(observedAt);
  if (!boundaries.length) {
    return freeze([{
      from: null,
      to: horizon,
      status: "unknown",
      basis: "source_stated",
      reason: "the publisher records no change date for this section, so the start of the current text is open",
    }]);
  }
  const currentFrom = horizon ? [...boundaries].filter((edge) => edge <= horizon).at(-1) || null : boundaries.at(-1);
  const edges = [null, ...new Set([...boundaries, horizon].filter(Boolean))]
    .filter((edge, index) => index === 0 || edge)
    .sort((left, right) => (left === null ? -1 : right === null ? 1 : left.localeCompare(right)));
  const intervals = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const from = edges[index];
    const to = edges[index + 1];
    if (from === to) continue;
    const version = coveringVersion(from, to);
    if (version) {
      intervals.push({
        from,
        to,
        status: "covered_by_retained_version",
        basis: "source_stated",
        reason: "a retained historical version covers this period",
      });
      continue;
    }
    const currentApplies = Boolean(currentFrom) && from !== null && from >= currentFrom;
    if (currentApplies && currentTextStatus === "retained") {
      intervals.push({
        from,
        to,
        status: "covered_by_current_snapshot",
        basis: "derived",
        reason: "the retained current text applies from the last change the publisher records",
      });
      continue;
    }
    if (from === null && addedAt && addedAt === to) {
      intervals.push({
        from: null,
        to,
        status: "before_enactment",
        basis: "source_stated",
        reason: "the publisher records this section as added on this date",
      });
      continue;
    }
    intervals.push({
      from,
      to,
      status: "unknown",
      basis: "source_stated",
      reason: from === null
        ? "no retained evidence before the earliest recorded change"
        : "change recorded from the publisher note, historical text not acquired",
    });
  }
  return freeze(intervals);
}

/** The subset of coverage intervals CityScroll still holds nothing for. */
export function unknownIntervals(options = {}) {
  return freeze(coverageIntervals(options).filter((interval) => interval.status === "unknown"));
}

/** One provision's measured backfill state. */
export function provisionBackfillCoverage({
  provision = null,
  observations = [],
  changes = [],
  versions = [],
  conflicts = [],
  batch_id: batchId = null,
  rank = null,
  observed_at: observedAt = null,
} = {}) {
  const rows = Array.isArray(observations) ? observations : [];
  const retained = rows.filter((item) => item?.status === "retained");
  const unresolvedObservations = rows.filter((item) => item?.status === "unparsed");
  const changeRows = Array.isArray(changes) ? changes : [];
  const versionRows = Array.isArray(versions) ? versions : [];
  const instrumentIndex = new Map();
  for (const item of retained) {
    if (!item.instrument_ref) continue;
    if (!instrumentIndex.has(item.instrument_ref)) {
      instrumentIndex.set(item.instrument_ref, {
        instrument_ref: item.instrument_ref,
        instrument_kind: item.instrument_kind,
        instrument_label: item.instrument_label,
        operations: [],
        effective_at: null,
        effective_basis: item.effective_basis,
      });
    }
    const entry = instrumentIndex.get(item.instrument_ref);
    if (!entry.operations.includes(item.operation)) entry.operations.push(item.operation);
    if (item.effective_at && (!entry.effective_at || item.effective_at < entry.effective_at)) {
      entry.effective_at = item.effective_at;
      entry.effective_basis = item.effective_basis;
    }
  }
  const instruments = [...instrumentIndex.values()]
    .map((entry) => ({ ...entry, operations: [...entry.operations].sort() }))
    .sort((left, right) => (
      String(left.effective_at || "9999-12-31").localeCompare(String(right.effective_at || "9999-12-31"))
      || left.instrument_ref.localeCompare(right.instrument_ref)
    ));
  const localLaws = instruments.filter((entry) => entry.instrument_kind === "local_law").map((entry) => entry.instrument_ref);
  const stateLaws = instruments.filter((entry) => entry.instrument_kind === "state_law").map((entry) => entry.instrument_ref);
  const horizon = observedAt || provision?.source?.observed_at || null;
  const intervals = coverageIntervals({
    observations: rows,
    versions: versionRows,
    observed_at: horizon,
    current_text_status: String(provision?.current_text ?? "").trim() ? "retained" : "absent",
  });
  const effectiveDates = retained.map((item) => item.effective_at).filter(Boolean).sort();
  return freeze({
    schema: BACKFILL_COVERAGE_SCHEMA,
    provision_id: provision?.id || null,
    citation: provision?.citation || null,
    heading: provision?.heading || null,
    batch_id: batchId,
    rank,
    corpus_id: provision?.corpus_id || ADMIN_CODE_CORPUS_ID,
    source_url: provision?.source?.url || null,
    observed_at: horizon,
    retained_change_count: retained.length,
    unresolved_observation_count: unresolvedObservations.length,
    instruments,
    instrument_refs: instruments.map((entry) => entry.instrument_ref),
    local_law_refs: localLaws,
    state_law_refs: stateLaws,
    earliest_recorded_change: effectiveDates[0] || null,
    latest_recorded_change: effectiveDates.at(-1) || null,
    historical_version_count: versionRows.length,
    materialization: {
      materialized: versionRows.length,
      partially_materialized: changeRows.filter((change) => change.materialization_status === "partially_materialized").length,
      unresolved: changeRows.filter((change) => change.materialization_status === "unresolved").length,
    },
    intervals,
    unknown_intervals: intervals.filter((interval) => interval.status === "unknown"),
    conflicts: Array.isArray(conflicts) ? conflicts : [],
    complete_history: false,
  });
}

/**
 * Rank candidates by measured value. Inputs stay on the record so a reviewer
 * can recompute the order without rerunning the builder.
 */
export function rankBackfillCandidates(candidates = [], { weights = BACKFILL_RANKING_WEIGHTS } = {}) {
  const scored = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const inputs = {
      inbound_reference_count: Number(candidate?.inbound_reference_count) || 0,
      retained_change_count: Number(candidate?.retained_change_count) || 0,
      distinct_instrument_count: Number(candidate?.distinct_instrument_count) || 0,
      mandate_join_count: Number(candidate?.mandate_join_count) || 0,
      authority_citation_count: Number(candidate?.authority_citation_count) || 0,
    };
    const score = (inputs.inbound_reference_count * weights.inbound_reference)
      + (inputs.retained_change_count * weights.retained_change)
      + (inputs.distinct_instrument_count * weights.distinct_instrument)
      + (inputs.mandate_join_count * weights.mandate_join)
      + (inputs.authority_citation_count * weights.authority_citation);
    return {
      provision_id: candidate?.provision_id || null,
      citation: candidate?.citation || null,
      heading: candidate?.heading || null,
      inputs,
      score,
      conflict_count: Number(candidate?.conflict_count) || 0,
    };
  }).filter((candidate) => candidate.provision_id);
  scored.sort((left, right) => (
    right.score - left.score
    || right.inputs.inbound_reference_count - left.inputs.inbound_reference_count
    || right.inputs.retained_change_count - left.inputs.retained_change_count
    || compareCitations(left.citation, right.citation)
  ));
  return freeze({
    schema: BACKFILL_RANKING_SCHEMA,
    weights,
    tie_break: "score, then inbound references, then recorded changes, then citation order",
    candidate_count: scored.length,
    candidates: scored.map((candidate, index) => ({ ...candidate, rank: index + 1 })),
  });
}

/**
 * Cut a bounded batch. The cutoff is explicit and the first excluded candidate
 * is recorded so widening the batch stays a decision rather than a drift.
 */
export function selectBackfillBatch(ranking, {
  batch_id: batchId = "batch-1",
  limit = 24,
  minimum_score: minimumScore = 0,
  minimum_recorded_changes: minimumRecordedChanges = 1,
  sources = [],
  corpus_id: corpusId = ADMIN_CODE_CORPUS_ID,
} = {}) {
  const candidates = Array.isArray(ranking?.candidates) ? ranking.candidates : [];
  const recoverable = candidates.filter((candidate) => candidate.inputs.retained_change_count >= minimumRecordedChanges);
  const withoutRecordedChange = candidates.filter((candidate) => candidate.inputs.retained_change_count < minimumRecordedChanges);
  const eligible = recoverable.filter((candidate) => candidate.score >= minimumScore);
  const selected = eligible.slice(0, limit);
  const nextExcluded = eligible[limit] || null;
  return freeze({
    schema: BACKFILL_BATCH_SCHEMA,
    batch_id: batchId,
    corpus_id: corpusId,
    eligibility: {
      rule: "a section joins a backfill batch only when a source already records at least one change to it",
      minimum_recorded_changes: minimumRecordedChanges,
      recoverable_count: recoverable.length,
      without_recorded_change_count: withoutRecordedChange.length,
      highest_ranked_without_recorded_change: withoutRecordedChange.slice(0, 5).map((candidate) => ({
        provision_id: candidate.provision_id,
        citation: candidate.citation,
        score: candidate.score,
        inbound_reference_count: candidate.inputs.inbound_reference_count,
        reason: "no source in this repository records a change to this section, so no historical interval can be bounded yet",
      })),
    },
    cutoff: {
      rule: "highest measured score first among recoverable sections, bounded by limit and minimum score",
      limit,
      minimum_score: minimumScore,
      lowest_selected_score: selected.at(-1)?.score ?? null,
      next_excluded: nextExcluded
        ? { provision_id: nextExcluded.provision_id, citation: nextExcluded.citation, score: nextExcluded.score }
        : null,
    },
    weights: ranking?.weights || BACKFILL_RANKING_WEIGHTS,
    candidate_count: candidates.length,
    selected_count: selected.length,
    scope: "prioritized sections only",
    complete_history: false,
    sources: sources.map((source) => ({
      id: clean(source?.id, 120),
      name: clean(source?.name, 240),
      url: clean(source?.url, 2_000) || null,
      role: clean(source?.role, 160),
      acquisition_status: clean(source?.acquisition_status, 60) || "not_acquired",
      acquisition_note: clean(source?.acquisition_note, 600) || null,
      observed_at: clean(source?.observed_at, 80) || null,
    })),
    selected: selected.map((candidate) => ({
      rank: candidate.rank,
      provision_id: candidate.provision_id,
      citation: candidate.citation,
      heading: candidate.heading,
      score: candidate.score,
      inputs: candidate.inputs,
    })),
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function intervalCopy(interval) {
  if (!interval.from && interval.to) return `Up to ${interval.to}`;
  if (interval.from && interval.to) return `${interval.from} to ${interval.to}`;
  if (interval.from) return `From ${interval.from}`;
  return "Whole period";
}

function intervalStatusCopy(interval) {
  switch (interval.status) {
    case "covered_by_retained_version":
      return "Historical text kept";
    case "covered_by_current_snapshot":
      return "Current text applies";
    case "before_enactment":
      return "Section not yet added";
    default:
      return "Open";
  }
}

function conflictCopy(conflict) {
  if (conflict.kind === "duplicate_publisher_record") {
    return "The publisher snapshot carries more than one record under this citation. CityScroll keeps every record.";
  }
  const law = conflict.instrument_ref || "one law";
  return `Sources state more than one effective date for ${law}: ${conflict.stated_effective_dates.join(", ")}. CityScroll keeps every stated date.`;
}

/** Reader-visible historical coverage for one provision page. */
export function renderProvisionBackfillCoverage(coverage) {
  if (!coverage?.provision_id) return "";
  const batchLine = coverage.batch_id
    ? `<p class="admin-code-backfill-batch">Historical backfill ${escapeHtml(coverage.batch_id)}, priority rank ${escapeHtml(String(coverage.rank ?? "unranked"))}.</p>`
    : "";
  const counts = `<dl class="admin-code-backfill-counts"><dt>Recorded changes kept</dt><dd>${coverage.retained_change_count}</dd><dt>Historical texts kept</dt><dd>${coverage.historical_version_count}</dd><dt>Laws named by the publisher</dt><dd>${coverage.instrument_refs.length}</dd></dl>`;
  const period = coverage.earliest_recorded_change
    ? `<p class="admin-code-backfill-period">Recorded changes run from ${escapeHtml(coverage.earliest_recorded_change)} to ${escapeHtml(coverage.latest_recorded_change || coverage.earliest_recorded_change)}.</p>`
    : "";
  const instruments = coverage.instruments?.length
    ? `<h4>Laws the publisher names</h4><ul class="legal-change-list admin-code-backfill-instruments">${coverage.instruments.map((entry) => `<li data-legal-instrument-id="${escapeHtml(entry.instrument_ref)}" data-instrument-kind="${escapeHtml(entry.instrument_kind)}"><strong>${escapeHtml(entry.instrument_label || entry.instrument_ref)}</strong> · ${escapeHtml(entry.operations.join(", "))} · effective ${escapeHtml(entry.effective_at || "date open")}${entry.effective_basis === "retroactive" ? " (stated as retroactive)" : ""}</li>`).join("")}</ul>`
    : "";
  const intervals = coverage.intervals?.length
    ? `<h4>What CityScroll holds for each period</h4><ul class="legal-change-list admin-code-coverage-intervals">${coverage.intervals.map((interval) => `<li data-coverage-interval="${escapeHtml(`${interval.from || ""}..${interval.to || ""}`)}" data-coverage-status="${escapeHtml(interval.status)}"><strong>${escapeHtml(intervalCopy(interval))}</strong> · ${escapeHtml(intervalStatusCopy(interval))} · ${escapeHtml(interval.reason)}</li>`).join("")}</ul>`
    : "";
  const conflicts = coverage.conflicts.length
    ? `<h4>Where sources disagree</h4><ul class="legal-change-list admin-code-source-conflicts">${coverage.conflicts.map((conflict) => `<li data-conflict-kind="${escapeHtml(conflict.kind)}">${escapeHtml(conflictCopy(conflict))}</li>`).join("")}</ul>`
    : "";
  const unresolved = coverage.unresolved_observation_count
    ? `<p class="admin-code-backfill-unresolved">${coverage.unresolved_observation_count} publisher note entr${coverage.unresolved_observation_count === 1 ? "y stays" : "ies stay"} open for review.</p>`
    : "";
  return `<section class="history" aria-labelledby="historical-coverage"><h3 id="historical-coverage">Historical coverage</h3>${batchLine}${counts}${period}${unresolved}${instruments}${intervals}${conflicts}</section>`;
}

/** Look up one provision's coverage inside a built backfill lookup. */
export function coverageForProvision(lookup, provisionId) {
  const rows = lookup?.coverage;
  if (!rows || !provisionId) return null;
  const row = Array.isArray(rows)
    ? rows.find((item) => item?.provision_id === provisionId)
    : rows[provisionId];
  return row || null;
}

/** The published batch this repository ships. */
export function backfillBatch(lookup = backfillReadModel) {
  return lookup?.batch || null;
}

/** Published coverage for one provision, or null when the batch omits it. */
export function provisionBackfill(provisionId, lookup = backfillReadModel) {
  return coverageForProvision(lookup, provisionId);
}

/** Published historical changes for one provision. */
export function provisionHistoricalChanges(provisionId, lookup = backfillReadModel) {
  const rows = lookup?.changes?.[provisionId];
  return Array.isArray(rows) ? rows : [];
}

export { backfillReadModel as CODE_HISTORY_BACKFILL };
