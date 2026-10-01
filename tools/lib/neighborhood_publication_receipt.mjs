/**
 * Bounded before/after receipt for publishing recovered venue membership into
 * exact neighborhood lists while keeping host districts broader.
 *
 * The 792 / 281 / 54 / 25 / 201 / 1 figures are the frozen diagnostic baseline
 * observed before venue-street recovery. They are regression controls for the
 * receipt, not ongoing release quotas.
 */

import { BACKFILL_OUTCOME } from "../../site/meeting_geography_backfill.mjs";

export const NEIGHBORHOOD_PUBLICATION_RECEIPT_SCHEMA =
  "cityscroll.neighborhood_publication_receipt.v1";

/** Frozen diagnostic baseline from the pre-recovery 792-row backfill. */
export const FROZEN_NEIGHBORHOOD_PUBLICATION_BASELINE = Object.freeze({
  canonical_meeting_count: 792,
  broad_jurisdiction: 281,
  address_candidate_classes: Object.freeze({
    not_full_address: 54,
    not_covered: 25,
    no_candidate: 201,
    matched_bbl_missing_parcel: 1,
  }),
  by_outcome: Object.freeze({
    physical_venue: 31,
    subject: 1,
    broad_jurisdiction: 281,
    virtual: 63,
    no_source_address: 203,
    unresolved_evidence: 213,
  }),
});

export const NEIGHBORHOOD_PUBLICATION_ANCHORS = Object.freeze({
  cb15_sept29: Object.freeze({
    meeting_id:
      "meeting:community_board:nyc-calendar:brooklyn-cb-15:2026-09-29:general-board-meeting-in-person",
    expected_bbl: "3087600060",
    expected_nta2020: "BK1503",
    expected_community_district: "K15",
    expected_role: "venue",
  }),
  forest_hills: Object.freeze({
    // Publisher calendar UIDs can look like mailbox addresses; resolve this
    // anchor from the shared corpus by venue text instead of embedding the UID.
    venue_address: "104-01 Metropolitan Ave, Forest Hills, NY 11375, USA",
    event_date_prefix: "2026-09-08",
    board_id: "queens-cb-06",
    expected_bbl: "4032400041",
    expected_nta2020: "QN0602",
    expected_community_district: "Q06",
    expected_role: "venue",
  }),
  worth_street: Object.freeze({
    meeting_id: "meeting:city_record:20260106034",
    expected_bbl: "1001680032",
    expected_nta2020: "MN0102",
    expected_community_district: "M01",
    expected_role: "venue",
  }),
  bronx_missing_parcel: Object.freeze({
    meeting_id:
      "meeting:community_board:https://cbbronx.cityofnewyork.us/cb6/event/general-board-meeting-11-2/",
    matched_bbl: "2030511001",
    expected_exact_nta2020: null,
  }),
});

/** Resolve an anchor to a corpus meeting_id without embedding publisher UIDs. */
export function resolveNeighborhoodPublicationAnchorId(anchor, rows = []) {
  if (!anchor) return null;
  if (anchor.meeting_id) return anchor.meeting_id;
  const list = Array.isArray(rows) ? rows : [];
  const needle = String(anchor.venue_address || "").trim().toLowerCase();
  const datePrefix = String(anchor.event_date_prefix || "").trim();
  const boardId = String(anchor.board_id || "").trim();
  const hit = list.find((row) => {
    if (needle && String(row?.venue?.address || "").trim().toLowerCase() !== needle) {
      return false;
    }
    if (datePrefix && !String(row?.event_date || "").startsWith(datePrefix)) {
      return false;
    }
    if (boardId && String(row?.board_id || "").trim() !== boardId) {
      return false;
    }
    return Boolean(row?.meeting_id);
  });
  return hit?.meeting_id || null;
}

/** Public receipts omit publisher calendar UIDs that look like mailbox addresses. */
export function publicMeetingIdForReceipt(meetingId) {
  const text = String(meetingId || "");
  if (!text) return null;
  if (/@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) {
    return {
      redacted: true,
      kind: "publisher_calendar_uid",
      suffix: text.includes("::") ? text.slice(text.lastIndexOf("::")) : null,
    };
  }
  return text;
}

export function countOutcomesByClass(outcomes = []) {
  const byOutcome = {
    [BACKFILL_OUTCOME.PHYSICAL_VENUE]: 0,
    [BACKFILL_OUTCOME.SUBJECT]: 0,
    [BACKFILL_OUTCOME.BROAD_JURISDICTION]: 0,
    [BACKFILL_OUTCOME.VIRTUAL]: 0,
    [BACKFILL_OUTCOME.NO_SOURCE_ADDRESS]: 0,
    [BACKFILL_OUTCOME.UNRESOLVED_EVIDENCE]: 0,
  };
  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    const key = outcome?.outcome;
    if (key && Object.prototype.hasOwnProperty.call(byOutcome, key)) {
      byOutcome[key] += 1;
    }
  }
  return byOutcome;
}

/**
 * Classify one address-resolution entry (and optional parcel bundle) into the
 * bounded candidate classes used by the frozen baseline receipt.
 */
export function classifyAddressCandidateClass({
  addressCandidateCount = 0,
  resolution = null,
  parcelBundle = null,
} = {}) {
  if (!Number(addressCandidateCount)) return "no_candidate";
  if (!resolution || resolution.status !== "matched" || !resolution.bbl) {
    const reason = resolution?.reason || null;
    if (reason === "not_full_address") return "not_full_address";
    if (reason === "not_covered") return "not_covered";
    if (reason === "contradictory_locality") return "contradictory_locality";
    if (reason === "unsupported_zip") return "unsupported_zip";
    if (reason === "ambiguous") return "ambiguous";
    return reason || "unresolved";
  }
  if (!parcelBundle) return "matched_bbl_missing_parcel";
  return "matched";
}

export function summarizeAddressCandidateClasses(rows = []) {
  const counts = {
    not_full_address: 0,
    not_covered: 0,
    no_candidate: 0,
    matched_bbl_missing_parcel: 0,
    matched: 0,
    contradictory_locality: 0,
    unsupported_zip: 0,
    ambiguous: 0,
    unresolved: 0,
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = classifyAddressCandidateClass(row);
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
    else counts.unresolved += 1;
  }
  return counts;
}

function venueMembership(outcome) {
  return (outcome?.memberships || []).find((membership) => membership?.role === "venue") || null;
}

function anchorObservation(outcomesById, anchor, { meetingId = null } = {}) {
  const id = meetingId || anchor.meeting_id || null;
  const outcome = id ? outcomesById.get(id) || null : null;
  const venue = venueMembership(outcome);
  return {
    meeting_id: publicMeetingIdForReceipt(id),
    outcome: outcome?.outcome || null,
    venue_bbl: venue?.bbl || null,
    venue_nta2020: venue?.memberships?.nta2020 || null,
    venue_community_district: venue?.memberships?.community_district || null,
    host_community_district: (outcome?.memberships || []).find(
      (membership) => membership?.role === "host_jurisdiction",
    )?.memberships?.community_district || null,
  };
}

/**
 * Build the bounded before/after publication receipt.
 *
 * @param {object} args
 * @param {object[]} args.beforeOutcomes
 * @param {object[]} args.afterOutcomes
 * @param {object} [args.frozenBaseline]
 * @param {string|null} [args.beforeGeneration]
 * @param {string|null} [args.afterGeneration]
 * @param {string|null} [args.builtAt]
 */
export function buildNeighborhoodPublicationReceipt({
  beforeOutcomes = [],
  afterOutcomes = [],
  frozenBaseline = FROZEN_NEIGHBORHOOD_PUBLICATION_BASELINE,
  beforeGeneration = null,
  afterGeneration = null,
  builtAt = null,
  beforeAddressCandidateClasses = null,
  afterAddressCandidateClasses = null,
  sharedRows = [],
} = {}) {
  const beforeById = new Map(
    (Array.isArray(beforeOutcomes) ? beforeOutcomes : [])
      .filter((row) => row?.meeting_id)
      .map((row) => [row.meeting_id, row]),
  );
  const afterById = new Map(
    (Array.isArray(afterOutcomes) ? afterOutcomes : [])
      .filter((row) => row?.meeting_id)
      .map((row) => [row.meeting_id, row]),
  );

  const beforeCounts = countOutcomesByClass(beforeOutcomes);
  const afterCounts = countOutcomesByClass(afterOutcomes);
  const resolvedIds = Object.fromEntries(
    Object.entries(NEIGHBORHOOD_PUBLICATION_ANCHORS).map(([key, anchor]) => [
      key,
      resolveNeighborhoodPublicationAnchorId(anchor, sharedRows)
        || anchor.meeting_id
        || [...afterById.keys(), ...beforeById.keys()].find((meetingId) => {
          if (anchor.venue_address) {
            const row = sharedRows.find((candidate) => candidate?.meeting_id === meetingId);
            return row && String(row?.venue?.address || "") === anchor.venue_address;
          }
          return false;
        })
        || null,
    ]),
  );

  return {
    schema: NEIGHBORHOOD_PUBLICATION_RECEIPT_SCHEMA,
    built_at: builtAt,
    frozen_baseline: {
      canonical_meeting_count: frozenBaseline.canonical_meeting_count,
      broad_jurisdiction: frozenBaseline.broad_jurisdiction,
      address_candidate_classes: { ...frozenBaseline.address_candidate_classes },
      by_outcome: { ...frozenBaseline.by_outcome },
      note: "Frozen diagnostic controls from the pre-recovery 792-row backfill; not release quotas.",
    },
    before: {
      generation: beforeGeneration,
      canonical_meeting_count: Array.isArray(beforeOutcomes) ? beforeOutcomes.length : 0,
      by_outcome: beforeCounts,
      address_candidate_classes: beforeAddressCandidateClasses,
      anchors: {
        cb15_sept29: anchorObservation(
          beforeById,
          NEIGHBORHOOD_PUBLICATION_ANCHORS.cb15_sept29,
          { meetingId: resolvedIds.cb15_sept29 },
        ),
        forest_hills: anchorObservation(
          beforeById,
          NEIGHBORHOOD_PUBLICATION_ANCHORS.forest_hills,
          { meetingId: resolvedIds.forest_hills },
        ),
        worth_street: anchorObservation(
          beforeById,
          NEIGHBORHOOD_PUBLICATION_ANCHORS.worth_street,
          { meetingId: resolvedIds.worth_street },
        ),
        bronx_missing_parcel: anchorObservation(
          beforeById,
          NEIGHBORHOOD_PUBLICATION_ANCHORS.bronx_missing_parcel,
          { meetingId: resolvedIds.bronx_missing_parcel },
        ),
      },
    },
    after: {
      generation: afterGeneration,
      canonical_meeting_count: Array.isArray(afterOutcomes) ? afterOutcomes.length : 0,
      by_outcome: afterCounts,
      address_candidate_classes: afterAddressCandidateClasses,
      anchors: {
        cb15_sept29: anchorObservation(
          afterById,
          NEIGHBORHOOD_PUBLICATION_ANCHORS.cb15_sept29,
          { meetingId: resolvedIds.cb15_sept29 },
        ),
        forest_hills: anchorObservation(
          afterById,
          NEIGHBORHOOD_PUBLICATION_ANCHORS.forest_hills,
          { meetingId: resolvedIds.forest_hills },
        ),
        worth_street: anchorObservation(
          afterById,
          NEIGHBORHOOD_PUBLICATION_ANCHORS.worth_street,
          { meetingId: resolvedIds.worth_street },
        ),
        bronx_missing_parcel: anchorObservation(
          afterById,
          NEIGHBORHOOD_PUBLICATION_ANCHORS.bronx_missing_parcel,
          { meetingId: resolvedIds.bronx_missing_parcel },
        ),
      },
    },
    deltas: {
      physical_venue: afterCounts.physical_venue - beforeCounts.physical_venue,
      broad_jurisdiction: afterCounts.broad_jurisdiction - beforeCounts.broad_jurisdiction,
      subject: afterCounts.subject - beforeCounts.subject,
      virtual: afterCounts.virtual - beforeCounts.virtual,
      no_source_address: afterCounts.no_source_address - beforeCounts.no_source_address,
      unresolved_evidence: afterCounts.unresolved_evidence - beforeCounts.unresolved_evidence,
    },
  };
}

export function assertFrozenNeighborhoodBaseline(outcomes, {
  baseline = FROZEN_NEIGHBORHOOD_PUBLICATION_BASELINE,
} = {}) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  if (list.length !== baseline.canonical_meeting_count) {
    throw new Error(
      `frozen baseline meeting count ${list.length} != ${baseline.canonical_meeting_count}`,
    );
  }
  const byOutcome = countOutcomesByClass(list);
  for (const [key, expected] of Object.entries(baseline.by_outcome)) {
    if (byOutcome[key] !== expected) {
      throw new Error(`frozen baseline ${key}=${byOutcome[key]} != ${expected}`);
    }
  }
  const broad = list.filter((row) => row.outcome === BACKFILL_OUTCOME.BROAD_JURISDICTION);
  if (broad.length !== baseline.broad_jurisdiction) {
    throw new Error(
      `frozen broad_jurisdiction ${broad.length} != ${baseline.broad_jurisdiction}`,
    );
  }
  const noCandidate = broad.filter((row) => !(row.address_candidate_count > 0)).length;
  if (noCandidate !== baseline.address_candidate_classes.no_candidate) {
    throw new Error(
      `frozen no_candidate ${noCandidate} != ${baseline.address_candidate_classes.no_candidate}`,
    );
  }
  return {
    by_outcome: byOutcome,
    address_candidate_classes: {
      ...baseline.address_candidate_classes,
      observed_no_candidate_among_broad: noCandidate,
    },
  };
}
