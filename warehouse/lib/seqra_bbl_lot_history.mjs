/**
 * SEQRA-06: project geometry and BBL reconciliation across lot merges and
 * subdivisions (card acceptance A3).
 *
 * A project's `bbl_list` (warehouse/lib/seqra_ontology_spec.mjs) records
 * every BBL the project touches, but that list alone cannot answer "what
 * BBLs constituted this project's footprint on 2019-03-01" once a lot has
 * since been merged into a larger tax lot or subdivided into several. This
 * module models that as an explicit, dated timeline of lot-change events
 * (never a silent resolve-to-present-geometry step) so a historical cutoff
 * can be answered from the footprint that existed then, and a BBL retired by
 * a later merge or subdivision is never dropped from a project's history --
 * only superseded within its own window.
 */
import { normalizeBbl } from "../../site/bbl_mappluto_centroids.mjs";
import { buildProjectBblHistoryKey } from "./seqra_spatial_stable_keys.mjs";

export const SEQRA_BBL_LOT_HISTORY_SCHEMA = "cityscroll.seqra_project_bbl_history.v1";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOT_CHANGE_TYPES = Object.freeze(["merge", "subdivision"]);

export class SeqraBblLotHistoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeqraBblLotHistoryError";
  }
}

function requireDateOnly(value, field) {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) {
    throw new SeqraBblLotHistoryError(`${field} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireBbls(list, field) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new SeqraBblLotHistoryError(`${field} must be a non-empty array of BBLs`);
  }
  return list.map((raw) => {
    const bbl = normalizeBbl(raw);
    if (!bbl) throw new SeqraBblLotHistoryError(`${field}: ${JSON.stringify(raw)} is not a valid BBL`);
    return bbl;
  });
}

/**
 * Build the ordered, non-overlapping timeline of BBL-set snapshots for one
 * project from its initial footprint plus any dated lot-change events.
 *
 * `lotChangeEvents`: `{ event_type: "merge"|"subdivision", effective_date,
 * from_bbls, to_bbls, source_id, source_record_id }[]`, in any order --
 * they are sorted by `effective_date` here so caller ordering never matters.
 * A `merge` retires `from_bbls` and introduces `to_bbls` (usually one);
 * a `subdivision` retires `from_bbls` (usually one) and introduces
 * `to_bbls`. Every `from_bbls` entry must be present in the footprint
 * immediately before that event -- an event that tries to retire a BBL the
 * project's timeline does not currently hold is rejected rather than
 * silently applied, since that would describe a lot change that could not
 * have happened to this project.
 */
export function buildProjectBblHistory({ projectKey, initialBbls, initialDate, lotChangeEvents = [] } = {}) {
  if (typeof projectKey !== "string" || !projectKey.startsWith("project:")) {
    throw new SeqraBblLotHistoryError(`projectKey must be a project stable key, got ${JSON.stringify(projectKey)}`);
  }
  const startBbls = requireBbls(initialBbls, "initialBbls");
  requireDateOnly(initialDate, "initialDate");

  const events = [...lotChangeEvents].sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)));

  const snapshots = [{ effective_start: initialDate, effective_end: null, bbls: [...startBbls].sort() }];
  const lineage = []; // { from_bbl, to_bbl, event_type, effective_date }

  let current = new Set(startBbls);
  for (const rawEvent of events) {
    const eventType = rawEvent?.event_type;
    if (!LOT_CHANGE_TYPES.includes(eventType)) {
      throw new SeqraBblLotHistoryError(`lot-change event_type must be one of ${LOT_CHANGE_TYPES.join(", ")}, got ${JSON.stringify(eventType)}`);
    }
    const effectiveDate = requireDateOnly(rawEvent.effective_date, "lot-change effective_date");
    if (effectiveDate <= snapshots[snapshots.length - 1].effective_start) {
      throw new SeqraBblLotHistoryError(
        `lot-change events must strictly advance the timeline; ${effectiveDate} does not come after the current snapshot's start`,
      );
    }
    const fromBbls = requireBbls(rawEvent.from_bbls, "lot-change from_bbls");
    const toBbls = requireBbls(rawEvent.to_bbls, "lot-change to_bbls");
    for (const bbl of fromBbls) {
      if (!current.has(bbl)) {
        throw new SeqraBblLotHistoryError(
          `lot-change on ${effectiveDate} retires BBL ${bbl}, which is not in the project's footprint immediately before that date`,
        );
      }
    }
    const next = new Set(current);
    for (const bbl of fromBbls) next.delete(bbl);
    for (const bbl of toBbls) next.add(bbl);

    snapshots[snapshots.length - 1].effective_end = effectiveDate;
    snapshots.push({ effective_start: effectiveDate, effective_end: null, bbls: [...next].sort() });
    for (const fromBbl of fromBbls) {
      for (const toBbl of toBbls) {
        lineage.push({ event_type: eventType, effective_date: effectiveDate, from_bbl: fromBbl, to_bbl: toBbl });
      }
    }
    current = next;
  }

  const everyBblEverHeld = [...new Set(snapshots.flatMap((s) => s.bbls))].sort();

  return Object.freeze({
    schema: SEQRA_BBL_LOT_HISTORY_SCHEMA,
    history_key: buildProjectBblHistoryKey({ projectKey }),
    project_key: projectKey,
    snapshots: snapshots.map((s) => Object.freeze({ ...s, bbls: Object.freeze([...s.bbls]) })),
    lineage: Object.freeze(lineage.map((entry) => Object.freeze({ ...entry }))),
    every_bbl_ever_held: Object.freeze(everyBblEverHeld),
  });
}

/**
 * The BBL footprint in force at `cutoff`, tracing through merges and
 * subdivisions rather than resolving to the project's present geometry.
 * Refused (throws) when `cutoff` precedes the project's earliest known
 * snapshot -- there is no footprint to report before the project existed,
 * and returning the earliest-known footprint anyway would silently
 * backdate it.
 */
export function bblFootprintAsOf(history, cutoff) {
  requireDateOnly(cutoff, "cutoff");
  const snapshot = history.snapshots.find(
    (s) => cutoff >= s.effective_start && (s.effective_end == null || cutoff < s.effective_end),
  );
  if (!snapshot) {
    throw new SeqraBblLotHistoryError(
      `${cutoff} precedes ${history.project_key}'s earliest known BBL history (starts ${history.snapshots[0]?.effective_start})`,
    );
  }
  return {
    cutoff,
    bbls: [...snapshot.bbls],
    snapshot_effective_start: snapshot.effective_start,
    snapshot_effective_end: snapshot.effective_end,
  };
}

/**
 * Full lineage (merges and subdivisions this BBL participated in, in either
 * direction) for one BBL within a project's history -- lets a caller trace
 * a since-merged or since-subdivided lot's identity forward or backward.
 */
export function traceBblLineage(history, bbl) {
  const normalized = normalizeBbl(bbl);
  return history.lineage.filter((entry) => entry.from_bbl === normalized || entry.to_bbl === normalized);
}
