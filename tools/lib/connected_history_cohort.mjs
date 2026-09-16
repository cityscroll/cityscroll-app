/**
 * Freeze a deterministic cross-board connected-history evaluation cohort.
 *
 * Selection follows the workstream specification algorithm:
 *   SHA-256(seed + source-qualified ID), up to two eligible non-demo subjects
 *   per board, stratified by parcel/proceeding vs corridor/component, with
 *   missing strata retained instead of substituted.
 *
 * Demo families from the fixed six-case dossier are excluded from held-out
 * counts. Judgments may use only already-retained source bundles.
 */

import { createHash } from "node:crypto";

export const CONNECTED_HISTORY_COHORT_SCHEMA =
  "cityscroll.connected_history_evaluation_cohort.v1";
export const CONNECTED_HISTORY_COHORT_VERSION = 1;
export const CONNECTED_HISTORY_EVALUATION_SEED =
  "connected-history-evaluation-2026-09-16";
export const CONNECTED_HISTORY_MAX_PER_BOARD = 2;

export const CONNECTED_HISTORY_STRATA = Object.freeze([
  "parcel_proceeding",
  "corridor_component",
]);

const BOROUGH_FROM_CD = Object.freeze({
  X: "bronx",
  K: "brooklyn",
  M: "manhattan",
  Q: "queens",
  R: "staten-island",
});

/**
 * Fixed six-case dossier families. These are development/release fixtures and
 * never enter held-out confirmation denominators.
 */
export const CONNECTED_HISTORY_DEMO_FAMILIES = Object.freeze([
  Object.freeze({
    family_id: "coyle",
    label: "Coyle",
    boards: Object.freeze(["brooklyn-cb-15"]),
    stratum: "parcel_proceeding",
    subject_ids: Object.freeze([
      "land:project:2020K0270",
      "land:application:C210239ZMK",
      "land:application:N210240ZRK",
      "council:matter:coyle-zmk",
      "council:matter:coyle-zrk",
      "parcel:3073670011",
      "parcel:3073670029",
      "procurement:notice:20241104015",
      "procurement:award:20241104015",
      "procurement:contract:CT107120258802303",
      "procurement:hearing-section:20230911014:coyle",
      "bsa:case:2025-54-A",
      "bsa:case:2026-09-A",
      "ceqr:21DCP123K",
    ]),
  }),
  Object.freeze({
    family_id: "franklin-avenue",
    label: "Franklin Avenue",
    boards: Object.freeze(["brooklyn-cb-09"]),
    stratum: "parcel_proceeding",
    subject_ids: Object.freeze([
      "land:application:C200184ZMK",
      "land:application:N200185ZRK",
      "land:application:C200186ZSK",
      "land:application:C200187ZSK",
      "land:application:C230356ZMK",
      "land:application:N230357ZRK",
      "land:application:N230357AZRK",
      "land:application:C230358ZSK",
      "parcel:3011920063",
      "parcel:3011920066",
    ]),
  }),
  Object.freeze({
    family_id: "kingsbridge-armory",
    label: "Kingsbridge Armory",
    boards: Object.freeze(["bronx-cb-07"]),
    stratum: "parcel_proceeding",
    subject_ids: Object.freeze([
      "land:project:2025X0262",
      "ceqr:08DME004X",
      "ceqr:13DME013X",
      "ceqr:25DME006X",
      "parcel:2032470010",
      "parcel:2032470002",
    ]),
  }),
  Object.freeze({
    family_id: "sixth-avenue",
    label: "Sixth Avenue",
    boards: Object.freeze([
      "manhattan-cb-02",
      "manhattan-cb-04",
      "manhattan-cb-05",
    ]),
    stratum: "corridor_component",
    subject_ids: Object.freeze([
      "dot:corridor:sixth-avenue-lispenard-w14",
      "dot:corridor:sixth-avenue-w14-w35",
      "dot:corridor:sixth-avenue-watts-w59",
    ]),
  }),
  Object.freeze({
    family_id: "thirty-first-avenue",
    label: "31st Avenue",
    boards: Object.freeze(["queens-cb-01"]),
    stratum: "corridor_component",
    subject_ids: Object.freeze([
      "dot:corridor:31st-avenue-vernon-51",
    ]),
  }),
  Object.freeze({
    family_id: "lighthouse-point",
    label: "Lighthouse Point",
    boards: Object.freeze(["staten-island-cb-01"]),
    stratum: "corridor_component",
    subject_ids: Object.freeze([
      "edc:project:lighthouse-point",
    ]),
  }),
]);

const DEMO_SUBJECT_IDS = new Set(
  CONNECTED_HISTORY_DEMO_FAMILIES.flatMap((family) => family.subject_ids),
);
const DEMO_FAMILY_BY_SUBJECT = new Map(
  CONNECTED_HISTORY_DEMO_FAMILIES.flatMap((family) =>
    family.subject_ids.map((subjectId) => [subjectId, family.family_id]),
  ),
);

function clean(value, max = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function day(value) {
  const raw = clean(value, 40);
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/** Map a ZAP community_district token such as K15 or X07 to a board id. */
export function communityDistrictTokenToBoardId(token) {
  const text = clean(token, 12).toUpperCase();
  const match = text.match(/^([KXMQR])(\d{2})$/);
  if (!match) return null;
  const borough = BOROUGH_FROM_CD[match[1]];
  return borough ? `${borough}-cb-${match[2]}` : null;
}

/** Split a publisher community_district field into canonical board ids. */
export function communityDistrictFieldToBoardIds(value) {
  const text = clean(value, 80);
  if (!text) return [];
  const boards = [];
  const seen = new Set();
  for (const part of text.split(/[,;/|\s]+/)) {
    const boardId = communityDistrictTokenToBoardId(part);
    if (!boardId || seen.has(boardId)) continue;
    seen.add(boardId);
    boards.push(boardId);
  }
  return boards;
}

export function isDemoSubjectId(subjectId) {
  return DEMO_SUBJECT_IDS.has(clean(subjectId, 160));
}

export function demoFamilyIdForSubject(subjectId) {
  return DEMO_FAMILY_BY_SUBJECT.get(clean(subjectId, 160)) || null;
}

export function selectionRank(seed, subjectId) {
  return sha256(`${clean(seed)}\0${clean(subjectId, 160)}`);
}

function dateSpan(dates) {
  const values = [...new Set((dates || []).map(day).filter(Boolean))].sort();
  if (!values.length) {
    return { earliest: null, latest: null, observed_dates: [], status: "unknown" };
  }
  return {
    earliest: values[0],
    latest: values[values.length - 1],
    observed_dates: values,
    status: "observed",
  };
}

/**
 * Build source-qualified subjects from already-retained inputs only.
 * Never invents board assignments or substitutes missing dossier families.
 */
export function buildConnectedHistoryPopulation(inputs = {}) {
  const boardIds = [...new Set((inputs.boardIds || []).map((id) => clean(id, 40)).filter(Boolean))].sort();
  const subjects = new Map();

  function upsert(subject) {
    const subjectId = clean(subject.subject_id, 160);
    if (!subjectId) return;
    const demoFamilyId = subject.demo_family_id || demoFamilyIdForSubject(subjectId);
    const existing = subjects.get(subjectId) || {
      subject_id: subjectId,
      stratum: subject.stratum,
      source_family: subject.source_family,
      boards: [],
      board_assignment: "unresolved",
      dates: [],
      retained_bundle_refs: [],
      rejection_reasons: [],
      demo_family_id: demoFamilyId,
    };
    if (!existing.demo_family_id && demoFamilyId) existing.demo_family_id = demoFamilyId;
    if (!CONNECTED_HISTORY_STRATA.includes(existing.stratum)) {
      existing.stratum = subject.stratum;
    }
    for (const boardId of subject.boards || []) {
      const id = clean(boardId, 40);
      if (id && !existing.boards.includes(id)) existing.boards.push(id);
    }
    existing.boards.sort();
    if (existing.boards.length) existing.board_assignment = "assigned";
    for (const date of subject.dates || []) {
      const d = day(date);
      if (d && !existing.dates.includes(d)) existing.dates.push(d);
    }
    existing.dates.sort();
    for (const ref of subject.retained_bundle_refs || []) {
      const value = clean(ref, 240);
      if (value && !existing.retained_bundle_refs.includes(value)) {
        existing.retained_bundle_refs.push(value);
      }
    }
    existing.retained_bundle_refs.sort();
    for (const reason of subject.rejection_reasons || []) {
      const value = clean(reason, 120);
      if (value && !existing.rejection_reasons.includes(value)) {
        existing.rejection_reasons.push(value);
      }
    }
    if (subject.board_assignment === "failed" && existing.board_assignment !== "assigned") {
      existing.board_assignment = "failed";
    }
    subjects.set(subjectId, existing);
  }

  for (const row of inputs.zapProjects || []) {
    const projectId = clean(row?.project_id, 40);
    if (!projectId) continue;
    const boards = communityDistrictFieldToBoardIds(row.community_district);
    const subjectId = `land:project:${projectId}`;
    upsert({
      subject_id: subjectId,
      stratum: "parcel_proceeding",
      source_family: "zap_project",
      boards,
      board_assignment: boards.length ? "assigned" : "failed",
      dates: [
        row.app_filed_date,
        row.certified_referred,
        row.noticed_date,
        row.approval_date,
        row.completed_date,
        row.current_milestone_date,
      ],
      retained_bundle_refs: [`zap_projects_warehouse_lookup#${projectId}`],
      rejection_reasons: boards.length ? [] : ["community_district_unmapped"],
    });
  }

  for (const [boardId, boardRow] of Object.entries(inputs.landPositionsByBoard || {})) {
    const board = clean(boardId, 40);
    for (const position of boardRow?.positions || []) {
      const projectId = clean(position?.project_id, 40);
      if (!projectId) continue;
      upsert({
        subject_id: `land:project:${projectId}`,
        stratum: "parcel_proceeding",
        source_family: "board_land_position",
        boards: board ? [board] : [],
        dates: [position.recorded_on],
        retained_bundle_refs: [
          `community_board_land_positions#${board}:${projectId}`,
        ],
      });
    }
  }

  for (const parcel of inputs.siteLifecycleParcels || []) {
    const parcelId = clean(parcel?.parcel_id, 40);
    if (!parcelId) continue;
    const parcelSubjectId = `parcel:${parcelId}`;
    const boards = [...new Set(
      (parcel.members || [])
        .flatMap((member) => member.boards || member.community_boards || [])
        .map((id) => clean(id, 40))
        .filter(Boolean),
    )].sort();
    const parcelDemoFamily = demoFamilyIdForSubject(parcelSubjectId);
    // Lifecycle retained rows currently cover the Coyle demo footprint only.
    const inferredBoards = boards.length
      ? boards
      : parcelDemoFamily === "coyle"
        ? ["brooklyn-cb-15"]
        : [];
    const relatedIds = new Set([parcelSubjectId]);
    for (const member of parcel.members || []) {
      const memberId = clean(member.subject_id, 160);
      if (memberId) relatedIds.add(memberId);
      for (const rel of member.relation_path || []) {
        const subjectId = clean(rel, 160);
        if (subjectId) relatedIds.add(subjectId);
      }
    }
    const familyId = parcelDemoFamily
      || [...relatedIds].map(demoFamilyIdForSubject).find(Boolean)
      || null;
    upsert({
      subject_id: parcelSubjectId,
      stratum: "parcel_proceeding",
      source_family: "site_lifecycle",
      boards: inferredBoards,
      board_assignment: inferredBoards.length ? "assigned" : "unresolved",
      dates: (parcel.members || []).map((member) => member.source_event_date),
      retained_bundle_refs: [`site_lifecycle#${parcelSubjectId}`],
      demo_family_id: familyId,
    });
    for (const member of parcel.members || []) {
      for (const rel of member.relation_path || []) {
        const subjectId = clean(rel, 160);
        if (!subjectId) continue;
        upsert({
          subject_id: subjectId,
          stratum: "parcel_proceeding",
          source_family: "site_lifecycle",
          boards: inferredBoards,
          dates: [member.source_event_date],
          retained_bundle_refs: [`site_lifecycle#${subjectId}`],
          demo_family_id: familyId || demoFamilyIdForSubject(subjectId),
        });
      }
      const memberId = clean(member.subject_id, 160);
      if (memberId) {
        upsert({
          subject_id: memberId,
          stratum: "parcel_proceeding",
          source_family: "site_lifecycle",
          boards: inferredBoards,
          dates: [member.source_event_date],
          retained_bundle_refs: [`site_lifecycle#${memberId}`],
          demo_family_id: familyId || demoFamilyIdForSubject(memberId),
        });
      }
    }
  }

  for (const meeting of inputs.bsaMeetings || []) {
    for (const item of meeting?.agenda_items || []) {
      const caseId = clean(item?.case_id, 40);
      if (!caseId) continue;
      const boards = [
        ...new Set(
          (item?.affected_area?.community_boards || [])
            .map((id) => clean(id, 40))
            .filter(Boolean),
        ),
      ].sort();
      upsert({
        subject_id: `bsa:case:${caseId}`,
        stratum: "parcel_proceeding",
        source_family: "bsa_case",
        boards,
        board_assignment: boards.length ? "assigned" : "unresolved",
        dates: [meeting.event_date, item?.disposition?.date],
        retained_bundle_refs: [`bsa_calendar#${caseId}`],
        rejection_reasons: boards.length ? [] : ["bsa_board_unassigned"],
      });
    }
  }

  // Bounded DOT/EDC tranche is named by the dossier but not yet retained.
  // Record the subjects as unavailable source rows so missing strata stay visible.
  const boundedCorridorSubjects = CONNECTED_HISTORY_DEMO_FAMILIES.filter(
    (family) => family.stratum === "corridor_component",
  );
  for (const family of boundedCorridorSubjects) {
    for (const subjectId of family.subject_ids) {
      upsert({
        subject_id: subjectId,
        stratum: "corridor_component",
        source_family: subjectId.startsWith("edc:") ? "edc_project" : "dot_corridor",
        boards: [...family.boards],
        dates: [],
        retained_bundle_refs: [],
        rejection_reasons: ["source_bundle_unavailable"],
      });
    }
  }

  const population = [...subjects.values()].map((subject) => {
    const available = subject.retained_bundle_refs.length > 0
      && !subject.rejection_reasons.includes("source_bundle_unavailable");
    return {
      ...subject,
      date_span: dateSpan(subject.dates),
      source_availability: available ? "retained" : "unavailable",
      eligible_for_held_out:
        available
        && subject.board_assignment === "assigned"
        && subject.boards.length > 0
        && !subject.demo_family_id
        && CONNECTED_HISTORY_STRATA.includes(subject.stratum),
    };
  }).sort((left, right) => left.subject_id.localeCompare(right.subject_id));

  return {
    board_ids: boardIds,
    subjects: population,
    counts: {
      subjects: population.length,
      eligible_held_out: population.filter((row) => row.eligible_for_held_out).length,
      demo_excluded: population.filter((row) => row.demo_family_id).length,
      unavailable_source: population.filter((row) => row.source_availability === "unavailable").length,
      unresolved_or_failed_board: population.filter((row) => row.board_assignment !== "assigned").length,
    },
  };
}

function selectForBoard(eligible, seed, maxPerBoard = CONNECTED_HISTORY_MAX_PER_BOARD) {
  const byStratum = Object.fromEntries(
    CONNECTED_HISTORY_STRATA.map((stratum) => [stratum, []]),
  );
  for (const subject of eligible) {
    byStratum[subject.stratum]?.push(subject);
  }
  for (const stratum of CONNECTED_HISTORY_STRATA) {
    byStratum[stratum].sort((left, right) => {
      const rank = selectionRank(seed, left.subject_id).localeCompare(
        selectionRank(seed, right.subject_id),
      );
      return rank || left.subject_id.localeCompare(right.subject_id);
    });
  }

  const strataAvailability = {};
  for (const stratum of CONNECTED_HISTORY_STRATA) {
    const rows = byStratum[stratum];
    if (!rows.length) {
      strataAvailability[stratum] = {
        status: "unavailable",
        reason: "no_eligible_retained_subjects",
        eligible_count: 0,
      };
    } else {
      strataAvailability[stratum] = {
        status: "available",
        reason: null,
        eligible_count: rows.length,
      };
    }
  }

  const selected = [];
  const selectedIds = new Set();

  // Prefer breadth across available strata before filling remaining seats.
  for (const stratum of CONNECTED_HISTORY_STRATA) {
    if (selected.length >= maxPerBoard) break;
    const candidate = byStratum[stratum][0];
    if (!candidate || selectedIds.has(candidate.subject_id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.subject_id);
  }

  const remainder = CONNECTED_HISTORY_STRATA.flatMap((stratum) => byStratum[stratum])
    .filter((subject) => !selectedIds.has(subject.subject_id))
    .sort((left, right) => {
      const rank = selectionRank(seed, left.subject_id).localeCompare(
        selectionRank(seed, right.subject_id),
      );
      return rank || left.subject_id.localeCompare(right.subject_id);
    });

  for (const candidate of remainder) {
    if (selected.length >= maxPerBoard) break;
    selected.push(candidate);
    selectedIds.add(candidate.subject_id);
  }

  return { selected, strataAvailability };
}

/**
 * Judge one subject using only an already-retained bundle.
 * Missing or thin bundles yield insufficient_evidence — never a search cue.
 */
export function judgeSubjectFromRetainedBundle(subject, bundle = {}) {
  const subjectId = clean(subject?.subject_id || bundle.subject_id, 160);
  if (!subjectId) {
    return {
      subject_id: null,
      judgment: "insufficient_evidence",
      relation: null,
      rationale: "subject_id_missing",
      evidence_refs: [],
    };
  }
  if (subject?.source_availability === "unavailable" || bundle.availability === "unavailable") {
    return {
      subject_id: subjectId,
      judgment: "source_unavailable",
      relation: null,
      rationale: "retained_source_bundle_unavailable",
      evidence_refs: [],
    };
  }
  const refs = [
    ...new Set([
      ...(subject?.retained_bundle_refs || []),
      ...(bundle.retained_bundle_refs || []),
    ].map((ref) => clean(ref, 240)).filter(Boolean)),
  ].sort();
  if (!refs.length) {
    return {
      subject_id: subjectId,
      judgment: "insufficient_evidence",
      relation: null,
      rationale: "no_retained_bundle_refs",
      evidence_refs: [],
    };
  }

  const explicitRelations = Array.isArray(bundle.explicit_relations)
    ? bundle.explicit_relations.filter((row) => row && row.from && row.to && row.relation)
    : [];
  if (!explicitRelations.length) {
    return {
      subject_id: subjectId,
      judgment: "insufficient_evidence",
      relation: null,
      rationale: "retained_bundle_lacks_decidable_relation",
      evidence_refs: refs,
    };
  }

  const relation = explicitRelations[0];
  return {
    subject_id: subjectId,
    judgment: "supported",
    relation: {
      from: clean(relation.from, 160),
      to: clean(relation.to, 160),
      relation: clean(relation.relation, 80),
    },
    rationale: "explicit_retained_relation",
    evidence_refs: refs,
  };
}

/**
 * Relabel a held-out sample that informed rule tuning so it cannot support
 * confirmation claims.
 */
export function relabelSampleAsDevelopment(sample, { reason, newSeed } = {}) {
  const rows = Array.isArray(sample) ? sample : [];
  return {
    label: "development",
    excluded_from_confirmation: true,
    reason: clean(reason || "held_out_failure_informed_rule_tuning", 200),
    confirmation_seed: clean(newSeed || "", 120) || null,
    subjects: rows.map((row) => ({
      ...row,
      sample_role: "development",
      confirmation_eligible: false,
    })),
  };
}

export function computeSelectionHash(parts) {
  return sha256(stableStringify(parts));
}

/**
 * Freeze population, per-board selection, judgments, and baseline denominators.
 */
export function freezeConnectedHistoryCohort(inputs = {}, options = {}) {
  const seed = clean(options.seed || CONNECTED_HISTORY_EVALUATION_SEED, 120)
    || CONNECTED_HISTORY_EVALUATION_SEED;
  const maxPerBoard = Number(options.maxPerBoard ?? CONNECTED_HISTORY_MAX_PER_BOARD);
  const population = buildConnectedHistoryPopulation(inputs);
  const boardIds = population.board_ids.length
    ? population.board_ids
    : [...new Set(population.subjects.flatMap((row) => row.boards))].sort();

  const subjectsById = new Map(population.subjects.map((row) => [row.subject_id, row]));
  const boardReports = [];
  const sample = [];
  const sampleIds = new Set();

  for (const boardId of boardIds) {
    const eligible = population.subjects.filter(
      (row) => row.eligible_for_held_out && row.boards.includes(boardId),
    );
    const { selected, strataAvailability } = selectForBoard(eligible, seed, maxPerBoard);
    for (const subject of selected) {
      if (sampleIds.has(subject.subject_id)) {
        // Multi-board subject already sampled citywide; still count locally.
        continue;
      }
      sampleIds.add(subject.subject_id);
      sample.push({
        subject_id: subject.subject_id,
        stratum: subject.stratum,
        boards: subject.boards,
        selection_rank: selectionRank(seed, subject.subject_id),
        sample_role: "held_out",
        confirmation_eligible: true,
      });
    }
    boardReports.push({
      board_id: boardId,
      eligible_count: eligible.length,
      selected_subject_ids: selected.map((row) => row.subject_id),
      strata: strataAvailability,
      unavailable_strata: CONNECTED_HISTORY_STRATA.filter(
        (stratum) => strataAvailability[stratum].status === "unavailable",
      ),
    });
  }

  sample.sort((left, right) => left.subject_id.localeCompare(right.subject_id));

  const retainedBundles = inputs.retainedBundles || {};
  const judgments = sample.map((row) => {
    const subject = subjectsById.get(row.subject_id);
    const bundle = retainedBundles[row.subject_id] || {
      retained_bundle_refs: subject?.retained_bundle_refs || [],
      availability: subject?.source_availability,
      explicit_relations: inputs.explicitRelationsBySubject?.[row.subject_id] || [],
    };
    return {
      ...judgeSubjectFromRetainedBundle(subject, bundle),
      judged_before_tuning: true,
      sample_role: row.sample_role,
    };
  });

  const judgmentCounts = judgments.reduce((acc, row) => {
    acc[row.judgment] = (acc[row.judgment] || 0) + 1;
    return acc;
  }, {});

  const supported = judgmentCounts.supported || 0;
  const judgedDenom = judgments.length;
  const baseline = {
    phase: "pre_tuning",
    discovery_precision: judgedDenom === 0
      ? { status: "not_estimable", numerator: 0, denominator: 0 }
      : {
        status: "bounded_sample",
        numerator: supported,
        denominator: judgedDenom,
        unresolved: (judgmentCounts.insufficient_evidence || 0)
          + (judgmentCounts.source_unavailable || 0),
      },
    discovery_recall: {
      status: "not_estimable",
      numerator: 0,
      denominator: 0,
      reason: "no_positive_held_out_relation_quota_before_tuning",
    },
    notes: [
      "Baseline frozen before extraction tuning.",
      "Insufficient-evidence and source-unavailable judgments remain in denominators.",
      "Source unavailability is distinct from zero retained records.",
    ],
  };

  const sourceVersions = {
    ...(inputs.sourceVersions || {}),
    eligibility_predicates: {
      requires_retained_bundle: true,
      requires_board_assignment: true,
      excludes_demo_families: true,
      strata: [...CONNECTED_HISTORY_STRATA],
      max_per_board: maxPerBoard,
      selection: "sha256(seed + source-qualified-id)",
    },
    demo_family_exclusions: CONNECTED_HISTORY_DEMO_FAMILIES.map((family) => ({
      family_id: family.family_id,
      boards: [...family.boards],
      stratum: family.stratum,
      subject_ids: [...family.subject_ids],
    })),
    seed,
  };

  const selectionHash = computeSelectionHash({
    schema: CONNECTED_HISTORY_COHORT_SCHEMA,
    version: CONNECTED_HISTORY_COHORT_VERSION,
    seed,
    max_per_board: maxPerBoard,
    source_versions: sourceVersions,
    board_selected: boardReports.map((row) => ({
      board_id: row.board_id,
      selected_subject_ids: row.selected_subject_ids,
      unavailable_strata: row.unavailable_strata,
    })),
    sample_subject_ids: sample.map((row) => row.subject_id),
    demo_family_ids: CONNECTED_HISTORY_DEMO_FAMILIES.map((family) => family.family_id),
  });

  const denominators = {
    registry_boards: boardIds.length,
    population_subjects: population.counts.subjects,
    eligible_held_out_subjects: population.counts.eligible_held_out,
    selected_held_out_subjects: sample.length,
    demo_excluded_subjects: population.counts.demo_excluded,
    unavailable_source_subjects: population.counts.unavailable_source,
    unresolved_or_failed_board_subjects: population.counts.unresolved_or_failed_board,
    boards_with_no_eligible_subjects: boardReports.filter((row) => row.eligible_count === 0).length,
    boards_missing_parcel_proceeding: boardReports.filter(
      (row) => row.strata.parcel_proceeding.status === "unavailable",
    ).length,
    boards_missing_corridor_component: boardReports.filter(
      (row) => row.strata.corridor_component.status === "unavailable",
    ).length,
  };

  return {
    schema: CONNECTED_HISTORY_COHORT_SCHEMA,
    version: CONNECTED_HISTORY_COHORT_VERSION,
    seed,
    selection_hash: selectionHash,
    source_versions: sourceVersions,
    denominators,
    population: {
      counts: population.counts,
      subjects: population.subjects,
    },
    boards: boardReports,
    sample,
    judgments,
    baseline,
  };
}
