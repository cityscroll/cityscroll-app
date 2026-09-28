import { createHash } from "node:crypto";

import {
  CONNECTED_HISTORY_DEMO_FAMILIES,
} from "./lib/connected_history_cohort.mjs";

export const CONNECTED_HISTORY_COVERAGE_SCHEMA = "cityscroll.connected_history_coverage.v1";
export const CONNECTED_HISTORY_COVERAGE_RECEIPT_SCHEMA = "cityscroll.connected_history_coverage_receipt.v1";
export const CONNECTED_HISTORY_COVERAGE_EXTENSION_VERSION = 1;
export const CONNECTED_HISTORY_COVERAGE_STAGES = Object.freeze([
  "registered",
  "acquired",
  "extractable",
  "admitted",
  "discoverable",
]);

const SOURCE_POLICY = "fixed-six-case-dossier-and-frozen-retained-inputs-only";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function subjectIdsFromRelation(row) {
  return [row?.from, row?.to].map(clean).filter(Boolean);
}

function subjectIdsFromTime(row) {
  return [row?.subject_ref].map(clean).filter(Boolean);
}

function subjectIdsFromRole(row) {
  // The actor is source-qualified participant evidence, not a geographic
  // history subject. Count the proceeding or project the role describes.
  return [row?.subject || row?.to].map(clean).filter(Boolean);
}

function dateValue(value) {
  const text = clean(value);
  if (!text || !/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(text)) return null;
  return text;
}

function addDate(map, subjectId, value) {
  const date = dateValue(value);
  if (!subjectId || !date) return;
  if (!map.has(subjectId)) map.set(subjectId, new Set());
  map.get(subjectId).add(date);
}

function normalizedDateBounds(value) {
  if (!value) return null;
  if (/^\d{4}$/.test(value)) return { start: `${value}-01-01`, end: `${value}-12-31` };
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { start: `${value}-01`, end: `${value}-${String(last).padStart(2, "0")}` };
  }
  return { start: value, end: value };
}

function dateSpan(subjectIds, datesBySubject) {
  const dates = sorted(subjectIds.flatMap((id) => [...(datesBySubject.get(id) || [])]));
  const knownSubjects = subjectIds.filter((id) => (datesBySubject.get(id)?.size || 0) > 0).length;
  if (!dates.length) {
    return {
      state: "unknown",
      earliest: null,
      latest: null,
      subjects_with_dates: 0,
      subjects_without_dates: subjectIds.length,
    };
  }
  const byStart = [...dates].sort((left, right) => normalizedDateBounds(left).start.localeCompare(normalizedDateBounds(right).start));
  const byEnd = [...dates].sort((left, right) => normalizedDateBounds(left).end.localeCompare(normalizedDateBounds(right).end));
  return {
    state: knownSubjects === subjectIds.length ? "observed" : "partial",
    earliest: byStart[0],
    latest: byEnd.at(-1),
    subjects_with_dates: knownSubjects,
    subjects_without_dates: subjectIds.length - knownSubjects,
  };
}

function stage(subjectIds, unknownIds, datesBySubject) {
  const ids = sorted(subjectIds);
  const unknown = sorted(unknownIds).filter((id) => !ids.includes(id));
  let state = "observed";
  if (!ids.length) state = unknown.length ? "unknown" : "measured_zero";
  else if (unknown.length) state = "partial";
  return {
    state,
    unique_subjects: ids.length,
    unknown_subjects: unknown.length,
    date_span: dateSpan(ids, datesBySubject),
  };
}

function boardIndex(cohort, artifactRows) {
  const boardsBySubject = new Map();
  const familyBoards = new Map(CONNECTED_HISTORY_DEMO_FAMILIES.map((family) => [family.family_id, [...family.boards]]));
  const add = (subjectId, boards) => {
    const id = clean(subjectId);
    if (!id) return;
    if (!boardsBySubject.has(id)) boardsBySubject.set(id, new Set());
    for (const board of boards || []) if (board) boardsBySubject.get(id).add(board);
  };
  for (const subject of cohort?.population?.subjects || []) add(subject.subject_id, subject.boards);
  for (const family of CONNECTED_HISTORY_DEMO_FAMILIES) {
    for (const subjectId of family.subject_ids) add(subjectId, family.boards);
  }
  for (const { row, ids } of artifactRows) {
    const boards = familyBoards.get(row?.family_id) || [];
    for (const id of ids(row)) add(id, boards);
  }
  return boardsBySubject;
}

function boardSubjects(boardId, subjects, boardsBySubject) {
  return sorted([...subjects].filter((id) => boardsBySubject.get(id)?.has(boardId)));
}

function metric(numerator, denominator, extra = {}) {
  if (denominator === 0) {
    return { status: "not_estimable", numerator, denominator, ...extra };
  }
  return { status: "bounded_held_out_sample", numerator, denominator, value: numerator / denominator, ...extra };
}

function evaluationSnapshot(cohort, discovered) {
  const sampleIds = new Set((cohort?.sample || []).filter((row) => row.sample_role === "held_out").map((row) => row.subject_id));
  const judgments = (cohort?.judgments || []).filter((row) => sampleIds.has(row.subject_id));
  const supported = judgments.filter((row) => row.judgment === "supported");
  const decisive = judgments.filter((row) => ["supported", "not_supported"].includes(row.judgment));
  const discoveredDecisive = decisive.filter((row) => discovered.has(row.subject_id));
  const truePositive = discoveredDecisive.filter((row) => row.judgment === "supported").length;
  const discoveredSupported = supported.filter((row) => discovered.has(row.subject_id)).length;
  const judgmentCounts = {};
  for (const row of judgments) judgmentCounts[row.judgment] = (judgmentCounts[row.judgment] || 0) + 1;
  return {
    evidence_class: "module_oracle_over_frozen_source_judgments",
    sample_role: "held_out",
    sample_denominator: judgments.length,
    source_judgment: {
      artifact: "site/data/connected_history_evaluation_cohort.json",
      json_pointer: "/judgments",
      counts: Object.fromEntries(Object.entries(judgmentCounts).sort()),
    },
    precision: metric(truePositive, discoveredDecisive.length, {
      limit: "Only independently decisive held-out source judgments enter the denominator.",
    }),
    recall: metric(discoveredSupported, supported.length, {
      limit: "No positive-example quota is used; a zero positive denominator remains not estimable.",
    }),
    unresolved_judgments: judgments.filter((row) => !["supported", "not_supported"].includes(row.judgment)).map((row) => row.subject_id).sort(),
    example_search_triggered: false,
  };
}

function admissionCounts(relations, time, roles) {
  // These retained artifacts are outputs of explicit admission functions. No
  // reviewed/manual admission field exists in their contracts, so zero manual
  // rows is a measured value rather than an inferred allocation.
  return {
    manual: 0,
    rule: (relations?.relations || []).length + (time?.observations || []).length + (roles?.observations || []).length,
    unknown: 0,
    basis: "retained relation, temporal, and role admission projectors",
  };
}

function buildSnapshot({
  phase,
  boardIds,
  cohort,
  boardsBySubject,
  registered,
  acquired,
  extractable,
  admitted,
  discoverable,
  datesBySubject,
  admissions,
}) {
  const boardReportById = new Map((cohort?.boards || []).map((row) => [row.board_id, row]));
  const judgmentBySubject = new Map((cohort?.judgments || []).map((row) => [row.subject_id, row]));
  const sampleBySubject = new Map((cohort?.sample || []).map((row) => [row.subject_id, row]));
  const rows = boardIds.map((boardId) => {
    const registeredLocal = boardSubjects(boardId, registered, boardsBySubject);
    const acquiredLocal = boardSubjects(boardId, acquired, boardsBySubject);
    const extractableLocal = boardSubjects(boardId, extractable, boardsBySubject);
    const admittedLocal = boardSubjects(boardId, admitted, boardsBySubject);
    const discoverableLocal = boardSubjects(boardId, discoverable, boardsBySubject);
    const boardReport = boardReportById.get(boardId) || { eligible_count: 0, selected_subject_ids: [], unavailable_strata: [] };
    const selected = sorted(boardReport.selected_subject_ids || []);
    const judgments = selected.map((id) => judgmentBySubject.get(id)).filter(Boolean);
    const contaminated = selected.filter((id) => {
      const sample = sampleBySubject.get(id);
      return sample?.sample_role === "development" || sample?.confirmation_eligible === false;
    });
    return {
      board_id: boardId,
      stages: {
        registered: stage(registeredLocal, [], datesBySubject),
        acquired: stage(acquiredLocal, registeredLocal.filter((id) => !acquired.has(id)), datesBySubject),
        extractable: stage(extractableLocal, registeredLocal.filter((id) => !extractable.has(id)), datesBySubject),
        admitted: stage(admittedLocal, registeredLocal.filter((id) => !admitted.has(id)), datesBySubject),
        discoverable: stage(discoverableLocal, registeredLocal.filter((id) => !discoverable.has(id)), datesBySubject),
      },
      sample: {
        eligible_subjects: boardReport.eligible_count || 0,
        selected_subjects_local: selected.length,
        decisive_source_judgments: judgments.filter((row) => ["supported", "not_supported"].includes(row.judgment)).length,
        unresolved_source_judgments: judgments.filter((row) => !["supported", "not_supported"].includes(row.judgment)).length,
        contaminated_subjects: contaminated.length,
      },
      unavailable_strata: sorted(boardReport.unavailable_strata || []),
    };
  });
  const totals = {};
  for (const name of CONNECTED_HISTORY_COVERAGE_STAGES) {
    const source = { registered, acquired, extractable, admitted, discoverable }[name];
    totals[name] = {
      unique_subjects: source.size,
      local_scope_subjects: rows.reduce((sum, row) => sum + row.stages[name].unique_subjects, 0),
    };
  }
  return {
    phase,
    board_count: rows.length,
    boards: rows,
    citywide: {
      stages: totals,
      multiboard_policy: "A subject is counted in every relevant board scope and once in each citywide unique-subject total.",
      admission_mode: admissions,
    },
  };
}

export function buildConnectedHistoryCoverage({ cohort, documents, relations, time, roles } = {}) {
  if (cohort?.schema !== "cityscroll.connected_history_evaluation_cohort.v1") throw new TypeError("connected-history cohort is required");
  if (documents?.schema !== "cityscroll.connected_history_documents.v1") throw new TypeError("connected-history documents are required");
  if (relations?.schema !== "cityscroll.connected_history_relations.v1") throw new TypeError("connected-history relations are required");
  if (time?.schema !== "cityscroll.connected_history_time_artifact.v1") throw new TypeError("connected-history time artifact is required");
  if (roles?.schema !== "cityscroll.connected_history_roles.v1") throw new TypeError("connected-history roles are required");

  const relationRows = relations.relations || [];
  const timeRows = time.observations || [];
  const roleRows = roles.observations || [];
  const artifactRows = [
    ...relationRows.map((row) => ({ row, ids: subjectIdsFromRelation })),
    ...timeRows.map((row) => ({ row, ids: subjectIdsFromTime })),
    ...roleRows.map((row) => ({ row, ids: subjectIdsFromRole })),
  ];
  const boardsBySubject = boardIndex(cohort, artifactRows);
  const boardIds = sorted((cohort.boards || []).map((row) => row.board_id));
  const datesBySubject = new Map();
  const baselineRegistered = new Set();
  const baselineAcquired = new Set();
  const baselineExtractable = new Set();
  for (const row of cohort.population?.subjects || []) {
    baselineRegistered.add(row.subject_id);
    for (const value of row.date_span?.observed_dates || []) addDate(datesBySubject, row.subject_id, value);
    if (row.source_availability === "retained") baselineAcquired.add(row.subject_id);
    if (row.source_availability === "retained" && row.date_span?.status === "observed") baselineExtractable.add(row.subject_id);
  }

  const registered = new Set(baselineRegistered);
  const acquired = new Set(baselineAcquired);
  const extractable = new Set(baselineExtractable);
  const admitted = new Set();
  const discoverable = new Set();

  for (const observation of documents.observations || []) {
    for (const id of observation.subject_ids || []) {
      registered.add(id);
      if (observation.retained === true) acquired.add(id);
      if (observation.retained === true && observation.source_span?.located === true) extractable.add(id);
      addDate(datesBySubject, id, observation.publication?.value);
      for (const date of observation.internal_dates || []) addDate(datesBySubject, id, date.value);
    }
  }
  for (const row of relationRows) {
    for (const id of subjectIdsFromRelation(row)) {
      registered.add(id); acquired.add(id); extractable.add(id); admitted.add(id); discoverable.add(id);
    }
  }
  for (const row of timeRows) {
    for (const id of subjectIdsFromTime(row)) {
      registered.add(id); acquired.add(id); extractable.add(id); admitted.add(id); discoverable.add(id);
      addDate(datesBySubject, id, row.event_time?.value);
    }
  }
  for (const row of roleRows) {
    for (const id of subjectIdsFromRole(row)) {
      registered.add(id); acquired.add(id); extractable.add(id); admitted.add(id);
      addDate(datesBySubject, id, row.role_date?.value);
    }
  }

  const baselineAdmitted = new Set(
    (cohort.judgments || []).filter((row) => row.judgment === "supported").flatMap((row) => [row.subject_id, row.relation?.to]).filter(Boolean),
  );
  const admissions = admissionCounts(relations, time, roles);
  const baseline = buildSnapshot({
    phase: "frozen_pre_tuning_baseline",
    boardIds,
    cohort,
    boardsBySubject,
    registered: baselineRegistered,
    acquired: baselineAcquired,
    extractable: baselineExtractable,
    admitted: baselineAdmitted,
    discoverable: baselineAdmitted,
    datesBySubject,
    admissions: { manual: 0, rule: 0, unknown: baselineAdmitted.size, basis: "frozen cohort source judgments" },
  });
  const post = buildSnapshot({
    phase: "retained_post_change_measurement",
    boardIds,
    cohort,
    boardsBySubject,
    registered,
    acquired,
    extractable,
    admitted,
    discoverable,
    datesBySubject,
    admissions,
  });
  const contaminated = (cohort.sample || []).filter((row) => row.sample_role === "development" || row.confirmation_eligible === false);
  const artifact = {
    schema: CONNECTED_HISTORY_COVERAGE_SCHEMA,
    version: 1,
    source_policy: SOURCE_POLICY,
    population: {
      canonical_boards: boardIds.length,
      board_registry: "site/data/community_board_constellation_lookup.json",
      frozen_cohort: "site/data/connected_history_evaluation_cohort.json",
      fixed_dossier_families: CONNECTED_HISTORY_DEMO_FAMILIES.map((row) => row.family_id),
    },
    snapshots: { baseline, post_change: post },
    evaluation: {
      baseline: cohort.baseline,
      post_change: evaluationSnapshot(cohort, discoverable),
      contaminated_samples: contaminated.map((row) => ({ subject_id: row.subject_id, sample_role: row.sample_role })),
    },
    interpretation: {
      missingness: "Coverage states describe retained acquisition and discovery, never the level of civic activity in a community.",
      zero: "measured_zero means the named retained stage produced zero subjects; unknown and partial remain distinct.",
      insufficient_evidence: "Missing strata and unresolved judgments remain outcomes and never trigger an example search.",
    },
    repair_lineage: {
      owner: "cityscroll.repair_queue.v1",
      created_issue_keys: [],
      duplicate_repair_cards_created: 0,
      policy: "Coverage gaps remain observations until the existing repair producer classifies a repairable condition.",
    },
    input_vintages: {
      cohort_selection_hash: cohort.selection_hash,
      documents_generated_at: documents.generated_at || null,
      relations_generated_at: relations.generated_at || null,
      time_generated_at: time.generated_at || null,
      roles_generated_at: roles.generated_at || null,
    },
  };
  artifact.selection_hash = sha256(stableStringify(artifact));
  return artifact;
}

const PROTECTED_FIELDS = Object.freeze([
  "schema",
  "version",
  "source_policy",
  "population",
  "snapshots",
  "evaluation",
  "interpretation",
  "repair_lineage",
  "input_vintages",
  "selection_hash",
]);

export function verifyConnectedHistoryCoverage(artifact, inputs) {
  const expected = buildConnectedHistoryCoverage(inputs);
  const findings = [];
  for (const field of PROTECTED_FIELDS) {
    if (stableStringify(artifact?.[field]) !== stableStringify(expected[field])) findings.push(field);
  }
  return {
    state: findings.length ? "failed" : "passed",
    valid: findings.length === 0,
    findings,
    protected_fields: [...PROTECTED_FIELDS],
  };
}

export function buildConnectedHistoryCoverageReceipt(artifact, inputs) {
  const verification = verifyConnectedHistoryCoverage(artifact, inputs);
  return {
    schema: CONNECTED_HISTORY_COVERAGE_RECEIPT_SCHEMA,
    version: 1,
    artifact: "site/data/connected_history_coverage.json",
    selection_hash: artifact?.selection_hash || null,
    board_count: artifact?.snapshots?.post_change?.board_count ?? null,
    stage_counts: artifact?.snapshots?.post_change?.citywide?.stages || null,
    evaluation: artifact?.evaluation?.post_change || null,
    source_policy: artifact?.source_policy || null,
    verification,
  };
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stageCell(value) {
  const span = value.date_span?.earliest
    ? `${value.date_span.earliest}–${value.date_span.latest}`
    : "dates unknown";
  return `<td data-stage-state="${esc(value.state)}"><strong>${value.unique_subjects}</strong><small>${esc(value.state)} · ${value.unknown_subjects} unknown · ${esc(span)}</small></td>`;
}

export function renderConnectedHistoryCoverageSection(coverage) {
  if (coverage?.schema !== CONNECTED_HISTORY_COVERAGE_SCHEMA) {
    return '<section id="historyCoverageView" hidden><h2>History coverage unavailable</h2><p data-coverage-status="unavailable">The retained census could not be read; this is not an all-clear.</p></section>';
  }
  const post = coverage.snapshots.post_change;
  const rows = post.boards.map((row) => `<tr data-coverage-board="${esc(row.board_id)}"><th scope="row">${esc(row.board_id)}</th>${CONNECTED_HISTORY_COVERAGE_STAGES.map((name) => stageCell(row.stages[name])).join("")}<td><strong>${row.sample.selected_subjects_local}</strong><small>${row.sample.unresolved_source_judgments} unresolved · ${row.sample.contaminated_subjects} contaminated</small></td></tr>`).join("");
  const score = coverage.evaluation.post_change;
  const summary = CONNECTED_HISTORY_COVERAGE_STAGES.map((name) => {
    const value = post.citywide.stages[name];
    return `<span class="pill" data-coverage-total="${esc(name)}">${esc(name)} ${value.unique_subjects} unique / ${value.local_scope_subjects} local</span>`;
  }).join("");
  return `<section class="history-coverage-view" id="historyCoverageView" hidden aria-labelledby="historyCoverageHeading">
<h2 id="historyCoverageHeading">Connected-history coverage</h2>
<p class="queue-lede">All ${post.board_count} community boards are enumerated. These are source and product coverage measurements, not measures of civic activity.</p>
<div class="meta">${summary}</div>
<p><strong>Held-out precision:</strong> ${esc(score.precision.status)} (${score.precision.numerator}/${score.precision.denominator}). <strong>Recall:</strong> ${esc(score.recall.status)} (${score.recall.numerator}/${score.recall.denominator}).</p>
<p><small>${esc(coverage.interpretation.missingness)} ${esc(coverage.interpretation.insufficient_evidence)}</small></p>
<div class="history-coverage-table"><table><thead><tr><th>Board</th>${CONNECTED_HISTORY_COVERAGE_STAGES.map((name) => `<th>${esc(name)}</th>`).join("")}<th>Held-out sample</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
}
