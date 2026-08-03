/**
 * Transparent layer-2 zoning statistics over materialized ZAP project rows.
 *
 * Unconditioned cohorts: action type + borough, then a deterministic n>=20
 * back-off. Applicant-conditioned outcome rates (cs-pred-11) reuse the same
 * cohort summarizer and floor, joined through entity-resolution stems —
 * never a second, forked cohort engine. The unconditioned base rate always
 * ships beside any conditioned figure.
 */

import {
  agencyCanonicalId,
  canonicalAgency,
  vendorStem,
} from "../../../entity_resolution/normalizers/index.mjs";
import {
  publicEntityLinkConfidence,
  readerLabelForLinkConfidence,
} from "../../../entity_resolution/publication/link_confidence.mjs";
import { buildPrediction } from "./prediction_contract.mjs";
import { evaluatePredictionBacktest } from "./prediction_calibration.mjs";

export const MIN_ZONING_COHORT = 20;
export const MAX_ZONING_DURATION_DAYS = 730;
export const ZONING_STATISTICS_SCHEMA_VERSION = 1;
export const ZONING_STATISTICS_MODEL_NAME = "zap_disposition_duration";
export const ZONING_STATISTICS_MODEL_VERSION = "1.0.0";
export const APPLICANT_OUTCOME_MODEL_NAME = "zap_applicant_outcome_rate";
export const APPLICANT_OUTCOME_MODEL_VERSION = "1.0.0";

const DAY_MS = 86_400_000;
const TERMINAL_APPROVED = "approved";
const TERMINAL_DISAPPROVED = "disapproved";
const OUTCOMES = Object.freeze(["approved", "modified", "disapproved"]);
const ACTION_LABELS = Object.freeze({
  HA: "urban development action area",
  HG: "urban renewal designation",
  MM: "city map change",
  PC: "site acquisition",
  PQ: "property acquisition",
  ZA: "zoning authorization",
  ZC: "zoning certification",
  ZM: "zoning map amendment",
  ZR: "zoning text amendment",
  ZS: "zoning special permit",
});

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function day(value) {
  const match = clean(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === match[1]
    ? match[1]
    : null;
}

function dayNumber(value) {
  return Date.parse(`${value}T00:00:00Z`) / DAY_MS;
}

function addDays(value, days) {
  return new Date((dayNumber(value) + days) * DAY_MS).toISOString().slice(0, 10);
}

function round4(value) {
  return Math.round(Number(value) * 10_000) / 10_000;
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

export function actionTypes(value) {
  const raw = Array.isArray(value) ? value : clean(value).split(/[;,|]/);
  return [...new Set(raw.map((item) => clean(item).toUpperCase()).filter(Boolean))];
}

export function primaryActionType(value) {
  return actionTypes(value)[0] || "ALL";
}

function normalizeBorough(value) {
  const borough = clean(value);
  return borough || "Citywide";
}

/**
 * Project-level outcome from ZAP project-action dispositions.
 *
 * A mix of approved and non-approved terminal actions is "modified". Pure
 * withdrawals and administrative terminations are excluded rather than being
 * mislabeled as a government disapproval.
 */
export function classifyProjectOutcome(row = {}) {
  const explicit = clean(row.outcome).toLowerCase();
  if (OUTCOMES.includes(explicit)) return explicit;

  const statuses = (Array.isArray(row.action_statuses)
    ? row.action_statuses
    : Array.isArray(row.actions_detailed)
      ? row.actions_detailed.map((action) => action?.status)
      : [])
    .map((status) => clean(status).toLowerCase())
    .filter(Boolean);
  const approved = statuses.includes(TERMINAL_APPROVED);
  const disapproved = statuses.includes(TERMINAL_DISAPPROVED);
  const otherTerminal = statuses.some((status) => status === "withdrawn" || status === "terminated");
  if (approved && (disapproved || otherTerminal)) return "modified";
  if (approved) return "approved";
  if (disapproved) return "disapproved";
  return null;
}

function dispositionDate(row, outcome) {
  const explicit = day(row.disposition_date);
  if (explicit) return explicit;
  const approval = day(row.approval_date);
  if (approval) return approval;
  if (outcome === "modified" || outcome === "disapproved") {
    return day(row.completed_date) || day(row.current_milestone_date);
  }
  return null;
}

/**
 * ZAP often stores bare agency acronyms (HPD, LPC) that the City Record alias
 * map does not rewrite. Map those to the preferred agency surface before
 * canonicalAgency so applicant cohorts do not split on the same agency.
 */
const ZAP_APPLICANT_AGENCY_ALIASES = Object.freeze({
  HPD: "Housing Preservation and Development",
  LPC: "Landmarks Preservation Commission",
  DCP: "City Planning",
  DPR: "Parks and Recreation",
  DEP: "Environmental Protection",
  DOT: "Transportation",
  DCAS: "Citywide Administrative Services",
  DSNY: "Sanitation",
  HRA: "Homeless Services",
  ACS: "Administration for Children's Services",
  NYCHA: "NYCHA",
  EDC: "Economic Development Corporation",
  SCA: "School Construction Authority",
  DOB: "Buildings",
  FDNY: "Fire Department",
  NYPD: "Police Department",
});

function expandZapApplicantAlias(raw) {
  const upper = raw.toUpperCase();
  // Bare acronym or "HPD - …" / "HPD/…" lead-in.
  const lead = upper.match(/^([A-Z]{2,6})(?:\s*[-/]|\s*$)/);
  if (lead && ZAP_APPLICANT_AGENCY_ALIASES[lead[1]]) {
    return ZAP_APPLICANT_AGENCY_ALIASES[lead[1]];
  }
  // "NYC LPC" and similar.
  const tokens = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    if (ZAP_APPLICANT_AGENCY_ALIASES[token] && tokens.length <= 3) {
      return ZAP_APPLICANT_AGENCY_ALIASES[token];
    }
  }
  return raw;
}

function applicantVendorStem(name) {
  // Collapse ASSOC / ASSOCIATES so firm names that alternate the suffix join.
  let stem = vendorStem(name);
  stem = stem
    .replace(/\bASSOCIATES\b/g, "ASSOC")
    .replace(/\bASSOCIATION\b/g, "ASSOC")
    .replace(/\s+/g, " ")
    .trim();
  return stem;
}

/**
 * Resolve a ZAP primary_applicant string to a stable entity handle.
 * Mirrors land-domain rootsForObservation: agency first when government-shaped,
 * otherwise a vendor stem. Public confidence uses the publication band only.
 */
export function resolveZoningApplicant(name) {
  const raw = clean(name);
  if (!raw) return null;

  const expanded = expandZapApplicantAlias(raw);
  const agency = canonicalAgency(expanded);
  const agencyId = agencyCanonicalId(expanded);
  const preferred = clean(agency?.canonical_name);
  const looksAgency = Boolean(agencyId) && (
    expanded !== raw
    || (preferred && preferred.toLowerCase() !== raw.toLowerCase())
    || /\b(department|dept|commission|authority|office of|borough president|district attorney|board of|city planning|housing preservation|citywide administrative|parks and recreation|transportation|sanitation|education|police|fire department|landmarks|nycha)\b/i.test(raw)
    || /^(HPD|DPR|DCP|DOT|DEP|DCAS|SBS|HRA|ACS|NYCHA|EDC|SCA|LPC|DSNY|PDC|HDA|DOB|FDNY|NYPD)\b/i.test(raw)
  );
  if (looksAgency && agencyId) {
    // Prefer the GROUPS preferred name when the alias map rewrote the surface.
    const display = preferred && preferred.toLowerCase() !== agencyId
      ? preferred
      : (ZAP_APPLICANT_AGENCY_ALIASES[raw.toUpperCase()] || preferred || raw);
    return {
      entity_kind: "agency",
      entity_key: `agency:${agencyId}`,
      entity_ref: `agency:id:${agencyId}`,
      display_name: display,
      raw_name: raw,
      link_confidence: publicEntityLinkConfidence(0.97),
    };
  }

  const stem = applicantVendorStem(raw);
  if (!stem || stem.length < 3) return null;
  return {
    entity_kind: "vendor",
    entity_key: `vendor:${stem}`,
    entity_ref: `vendor:stem:${encodeURIComponent(stem)}`,
    display_name: raw,
    raw_name: raw,
    stem,
    link_confidence: publicEntityLinkConfidence(0.9),
  };
}

function normalizeObservation(row) {
  const certified = day(row.certified_referred || row.certified_date);
  const outcome = classifyProjectOutcome(row);
  const disposed = dispositionDate(row, outcome);
  const durationDays = certified && disposed ? dayNumber(disposed) - dayNumber(certified) : null;
  const applicant = resolveZoningApplicant(
    row.primary_applicant || row.applicant || row.applicant_name,
  );
  return {
    project_id: clean(row.project_id),
    action_type: primaryActionType(row.actions || row.action_types),
    borough: normalizeBorough(row.borough),
    certified_date: certified,
    disposition_date: disposed,
    duration_days: Number.isSafeInteger(durationDays)
      && durationDays >= 0
      && durationDays <= MAX_ZONING_DURATION_DAYS
      ? durationDays
      : null,
    outcome,
    applicant_entity_key: applicant?.entity_key || null,
    applicant_entity_ref: applicant?.entity_ref || null,
    applicant_entity_kind: applicant?.entity_kind || null,
    applicant_display_name: applicant?.display_name || null,
    applicant_raw_name: applicant?.raw_name || null,
    applicant_link_confidence: applicant?.link_confidence || null,
  };
}

function cohortId(level, actionType, borough) {
  return [level, actionType || "all", borough || "citywide"]
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, "-");
}

function summarizeCohort(rows, {
  level,
  actionType = null,
  borough = null,
  applicantEntityKey = null,
  applicantMeta = null,
}) {
  const outcomes = rows.filter((row) => OUTCOMES.includes(row.outcome));
  const durations = rows
    .map((row) => row.duration_days)
    .filter((value) => Number.isSafeInteger(value) && value >= 0)
    .sort((left, right) => left - right);
  const outcomeCounts = Object.fromEntries(
    OUTCOMES.map((outcome) => [outcome, outcomes.filter((row) => row.outcome === outcome).length]),
  );
  const n = outcomes.length;
  const dates = rows.flatMap((row) => [row.certified_date, row.disposition_date]).filter(Boolean).sort();
  const durationDays = {
    p10: quantile(durations, 0.1),
    p25: quantile(durations, 0.25),
    p50: quantile(durations, 0.5),
    p75: quantile(durations, 0.75),
    p90: quantile(durations, 0.9),
  };
  const summary = {
    cohort_id: applicantEntityKey
      ? `applicant:${applicantEntityKey.replace(/[^a-z0-9:]+/gi, "-").toLowerCase()}`
      : cohortId(level, actionType, borough),
    level,
    action_type: actionType,
    action_label: actionType ? (ACTION_LABELS[actionType] || actionType) : "land-use",
    borough,
    n,
    duration_n: durations.length,
    train_from: dates[0] || null,
    train_to: dates.at(-1) || null,
    outcome_counts: outcomeCounts,
    outcome_rates: Object.fromEntries(
      OUTCOMES.map((outcome) => [outcome, n ? round4(outcomeCounts[outcome] / n) : null]),
    ),
    duration_days: durationDays,
    typical_months: {
      low: durationDays.p25 == null ? null : round1(durationDays.p25 / 30.4375),
      high: durationDays.p75 == null ? null : round1(durationDays.p75 / 30.4375),
    },
  };
  if (applicantEntityKey) {
    summary.applicant_entity_key = applicantEntityKey;
    summary.applicant_entity_ref = applicantMeta?.entity_ref || null;
    summary.applicant_entity_kind = applicantMeta?.entity_kind || null;
    summary.applicant_display_name = applicantMeta?.display_name || null;
    summary.link_confidence = applicantMeta?.link_confidence || null;
  }
  return summary;
}

function group(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

/**
 * Build reusable cohort tables. Additional dimensions can be layered later;
 * v1 intentionally emits only public-record action and borough aggregates.
 */
export function buildZoningCohortModel(inputRows = [], opts = {}) {
  const minN = opts.minN ?? MIN_ZONING_COHORT;
  if (!Number.isSafeInteger(minN) || minN < 1) throw new TypeError("minN must be positive");
  const rows = (Array.isArray(inputRows) ? inputRows : []).map(normalizeObservation)
    .filter((row) => row.project_id && (row.outcome || row.duration_days != null));
  const cohorts = [];

  for (const [key, members] of group(rows, (row) => `${row.action_type}\u0000${row.borough}`)) {
    const [actionType, borough] = key.split("\u0000");
    cohorts.push(summarizeCohort(members, {
      level: "action_type_borough",
      actionType,
      borough,
    }));
  }
  for (const [actionType, members] of group(rows, (row) => row.action_type)) {
    cohorts.push(summarizeCohort(members, {
      level: "action_type_citywide",
      actionType,
    }));
  }
  for (const [borough, members] of group(rows, (row) => row.borough)) {
    cohorts.push(summarizeCohort(members, {
      level: "all_actions_borough",
      borough,
    }));
  }
  cohorts.push(summarizeCohort(rows, { level: "citywide" }));

  const eligible = cohorts.filter((cohort) => cohort.n >= minN && cohort.duration_n >= minN);
  const dates = rows.flatMap((row) => [row.certified_date, row.disposition_date]).filter(Boolean).sort();
  return {
    schema_version: ZONING_STATISTICS_SCHEMA_VERSION,
    model_name: ZONING_STATISTICS_MODEL_NAME,
    model_version: ZONING_STATISTICS_MODEL_VERSION,
    minimum_cohort_n: minN,
    train_from: opts.trainFrom || dates[0] || null,
    train_to: opts.trainTo || dates.at(-1) || null,
    source_row_count: rows.length,
    dimensions: ["action_type", "borough"],
    conditioned_on_applicant: false,
    cohorts: eligible.sort((left, right) => left.cohort_id.localeCompare(right.cohort_id)),
  };
}

/** n>=20 back-off: action+borough → action citywide → borough → citywide. */
export function chooseZoningCohort(model, subject = {}) {
  if (!model || !Array.isArray(model.cohorts)) return null;
  const actionType = primaryActionType(subject.actions || subject.action_types);
  const borough = normalizeBorough(subject.borough);
  const candidates = [
    ["action_type_borough", actionType, borough],
    ["action_type_citywide", actionType, null],
    ["all_actions_borough", null, borough],
    ["citywide", null, null],
  ];
  for (const [level, candidateAction, candidateBorough] of candidates) {
    const match = model.cohorts.find((cohort) => cohort.level === level
      && cohort.action_type === candidateAction
      && cohort.borough === candidateBorough);
    if (match) return match;
  }
  return null;
}

export function zoningStatisticCopy(cohort) {
  if (!cohort || !cohort.n || cohort.outcome_rates?.approved == null) return "";
  const year = String(cohort.train_from || "").slice(0, 4) || "—";
  const approved = Math.round(cohort.outcome_rates.approved * 100);
  const low = cohort.typical_months?.low;
  const high = cohort.typical_months?.high;
  return `Based on ${cohort.n} past ${cohort.action_label} cases since ${year}. `
    + `${approved}% were approved. Final action usually came ${low}–${high} months after certification.`;
}

export function emitZoningStatisticalPrediction(record = {}, cohort, opts = {}) {
  if (!cohort || cohort.duration_n < MIN_ZONING_COHORT) return null;
  const source = record.open_data || record;
  const projectId = clean(record.project_id || source.project_id);
  const certified = day(record.certified_referred || source.certified_referred);
  if (!projectId || !certified) return null;
  const duration = cohort.duration_days || {};
  if (![duration.p10, duration.p50, duration.p90].every(Number.isSafeInteger)) return null;
  const generatedAt = opts.generatedAt || record.generated_at || new Date().toISOString();
  const evidenceEventIds = Array.isArray(opts.evidenceEventIds) && opts.evidenceEventIds.length
    ? opts.evidenceEventIds
    : [`zap-zoning-cohort:${cohort.cohort_id}:${cohort.train_to}`];
  return buildPrediction({
    subject_ref: `project:${projectId}`,
    predicted_event_kind: "land.zap_disposition",
    claim: "timing",
    predicted_window: {
      p10: addDays(certified, duration.p10),
      p50: addDays(certified, duration.p50),
      p90: addDays(certified, duration.p90),
    },
    probability: 1,
    basis: {
      method: "phase_duration_ecdf",
      n: cohort.duration_n,
      train_from: opts.trainFrom || cohort.train_from,
      train_to: opts.trainTo || cohort.train_to,
      cohort: cohort.cohort_id,
      evidence_event_ids: evidenceEventIds,
      statute_ref: null,
    },
    model_name: ZONING_STATISTICS_MODEL_NAME,
    model_version: ZONING_STATISTICS_MODEL_VERSION,
    generated_at: generatedAt,
    supersedes_prediction_id: null,
    status: "open",
    resolved_by_event_id: null,
  });
}

/**
 * Build applicant-entity outcome cohorts from the same observation normalizer.
 * Only entities with n >= minN appear — the verify gate for public render.
 */
export function buildApplicantConditionedCohorts(inputRows = [], opts = {}) {
  const minN = opts.minN ?? MIN_ZONING_COHORT;
  if (!Number.isSafeInteger(minN) || minN < 1) throw new TypeError("minN must be positive");
  const rows = (Array.isArray(inputRows) ? inputRows : []).map(normalizeObservation)
    .filter((row) => row.project_id && row.outcome && row.applicant_entity_key);

  const metaByKey = new Map();
  for (const row of rows) {
    if (!metaByKey.has(row.applicant_entity_key)) {
      metaByKey.set(row.applicant_entity_key, {
        entity_key: row.applicant_entity_key,
        entity_ref: row.applicant_entity_ref,
        entity_kind: row.applicant_entity_kind,
        display_name: row.applicant_display_name,
        link_confidence: row.applicant_link_confidence,
      });
    }
  }

  const cohorts = [];
  for (const [entityKey, members] of group(rows, (row) => row.applicant_entity_key)) {
    cohorts.push(summarizeCohort(members, {
      level: "applicant_entity",
      applicantEntityKey: entityKey,
      applicantMeta: metaByKey.get(entityKey),
    }));
  }

  const eligible = cohorts
    .filter((cohort) => cohort.n >= minN)
    .sort((left, right) => left.cohort_id.localeCompare(right.cohort_id));
  const dates = rows.flatMap((row) => [row.certified_date, row.disposition_date]).filter(Boolean).sort();
  return {
    model_name: APPLICANT_OUTCOME_MODEL_NAME,
    model_version: APPLICANT_OUTCOME_MODEL_VERSION,
    minimum_cohort_n: minN,
    train_from: opts.trainFrom || dates[0] || null,
    train_to: opts.trainTo || dates.at(-1) || null,
    source_row_count: rows.length,
    dimensions: ["applicant_entity"],
    conditioned_on_applicant: true,
    entity_resolution: {
      method: "agency_preferred_then_vendor_stem",
      confidence_surface: "public_link_confidence_v1",
    },
    cohorts: eligible,
  };
}

/** Look up an n>=20 applicant cohort by resolved entity key or raw name. */
export function chooseApplicantCohort(applicantModel, subject = {}) {
  if (!applicantModel || !Array.isArray(applicantModel.cohorts)) return null;
  const resolved = subject.applicant_entity_key
    ? {
      entity_key: subject.applicant_entity_key,
      entity_ref: subject.applicant_entity_ref || null,
    }
    : resolveZoningApplicant(
      subject.primary_applicant || subject.applicant || subject.applicant_name,
    );
  if (!resolved?.entity_key) return null;
  return applicantModel.cohorts.find((cohort) => cohort.applicant_entity_key === resolved.entity_key)
    || applicantModel.cohorts.find((cohort) => cohort.applicant_entity_ref === resolved.entity_ref)
    || null;
}

/**
 * One-line pattern attribution: conditioned rate always with unconditioned base.
 * Never ships the conditioned number alone.
 */
export function applicantConditionedCopy(conditioned, base, opts = {}) {
  if (!conditioned || conditioned.n < MIN_ZONING_COHORT) return "";
  if (!base || base.outcome_rates?.approved == null) return "";
  const year = String(conditioned.train_from || "").slice(0, 4) || "—";
  const p = Math.round(Number(conditioned.outcome_rates.approved || 0) * 100);
  const p0 = Math.round(Number(base.outcome_rates.approved || 0) * 100);
  const conf = conditioned.link_confidence?.status;
  const confLabel = conf && conf !== "not_scored"
    ? readerLabelForLinkConfidence(conf)
    : "";
  const predictive = opts.publicProjection !== "descriptive_history"
    && opts.publicProjection !== "cohort_statistic_only";
  const lead = predictive ? "Predicted based on" : "Based on";
  const line = `${lead} ${conditioned.n} applications by this applicant since ${year}: `
    + `${p}% approved, vs ${p0}% overall.`;
  return confLabel ? `${line} (${confLabel}.)` : line;
}

/**
 * Occurrence claim: P(approval | applicant entity) for an open application
 * that has an n>=20 conditioned cohort. Window uses unconditioned duration
 * quantiles when available so band delivery stays on the contract.
 */
export function emitApplicantOutcomePrediction(record = {}, conditioned, base, opts = {}) {
  if (!conditioned || conditioned.n < MIN_ZONING_COHORT) return null;
  if (conditioned.outcome_rates?.approved == null) return null;
  if (!base || base.outcome_rates?.approved == null) return null;
  // Honesty gate: when out-of-sample conditioning does not beat the base rate,
  // do not emit a predictive assertion — UI still shows descriptive history.
  if (opts.publicProjection === "descriptive_history"
    || opts.publicProjection === "cohort_statistic_only") {
    return null;
  }
  const source = record.open_data || record;
  const projectId = clean(record.project_id || source.project_id);
  const certified = day(record.certified_referred || source.certified_referred);
  if (!projectId || !certified) return null;

  const duration = base.duration_days || {};
  const p10Days = Number.isSafeInteger(duration.p10) ? duration.p10 : 90;
  const p50Days = Number.isSafeInteger(duration.p50) ? duration.p50 : 180;
  const p90Days = Number.isSafeInteger(duration.p90) ? duration.p90 : 365;
  const generatedAt = opts.generatedAt || record.generated_at || new Date().toISOString();
  const evidenceEventIds = Array.isArray(opts.evidenceEventIds) && opts.evidenceEventIds.length
    ? opts.evidenceEventIds
    : [`zap-applicant-cohort:${conditioned.cohort_id}:${conditioned.train_to}`];

  return buildPrediction({
    subject_ref: `project:${projectId}`,
    predicted_event_kind: "land.zap_disposition",
    claim: "occurrence",
    predicted_window: {
      p10: addDays(certified, p10Days),
      p50: addDays(certified, p50Days),
      p90: addDays(certified, p90Days),
    },
    probability: conditioned.outcome_rates.approved,
    basis: {
      method: "base_rate",
      n: conditioned.n,
      train_from: opts.trainFrom || conditioned.train_from,
      train_to: opts.trainTo || conditioned.train_to,
      cohort: conditioned.cohort_id,
      evidence_event_ids: evidenceEventIds,
      statute_ref: null,
    },
    model_name: APPLICANT_OUTCOME_MODEL_NAME,
    model_version: APPLICANT_OUTCOME_MODEL_VERSION,
    generated_at: generatedAt,
    supersedes_prediction_id: null,
    status: "open",
    resolved_by_event_id: null,
  });
}

function brierScore(rows) {
  if (!rows.length) return null;
  let sum = 0;
  for (const row of rows) {
    const p = Number(row.probability);
    const y = row.realized ? 1 : 0;
    sum += (p - y) ** 2;
  }
  return round4(sum / rows.length);
}

/**
 * Out-of-sample comparison: conditioned approval rates vs unconditioned base.
 * Lower Brier wins. When conditioning does not beat the base rate, public
 * surfaces treat the figure as descriptive history only.
 */
export function scoreApplicantConditioning(rows = [], opts = {}) {
  const splitDate = day(opts.splitDate || "2024-01-01");
  const minN = opts.minN ?? MIN_ZONING_COHORT;
  const normalized = (Array.isArray(rows) ? rows : []).map(normalizeObservation)
    .filter((row) => row.project_id && row.outcome && row.applicant_entity_key && row.disposition_date);

  const training = normalized.filter((row) => row.disposition_date < splitDate);
  const evaluation = normalized.filter((row) => row.disposition_date >= splitDate
    && row.certified_date
    && row.certified_date < splitDate);

  const trainModel = buildApplicantConditionedCohorts(training, {
    minN,
    trainTo: day(opts.trainTo) || "2023-12-31",
  });
  const unconditioned = buildZoningCohortModel(training, {
    minN,
    trainTo: day(opts.trainTo) || "2023-12-31",
  });

  const conditionedRows = [];
  const baseRows = [];
  const predictions = [];
  const events = [];

  for (const row of evaluation) {
    const conditioned = chooseApplicantCohort(trainModel, {
      applicant_entity_key: row.applicant_entity_key,
      applicant_entity_ref: row.applicant_entity_ref,
    });
    if (!conditioned) continue;
    const base = chooseZoningCohort(unconditioned, {
      actions: row.action_type,
      borough: row.borough,
    });
    if (!base) continue;

    const realizedApproval = row.outcome === "approved";
    conditionedRows.push({
      probability: conditioned.outcome_rates.approved,
      realized: realizedApproval,
    });
    baseRows.push({
      probability: base.outcome_rates.approved,
      realized: realizedApproval,
    });

    const record = {
      project_id: row.project_id,
      certified_referred: row.certified_date,
      primary_applicant: row.applicant_raw_name,
    };
    const prediction = emitApplicantOutcomePrediction(record, conditioned, base, {
      generatedAt: `${splitDate}T00:00:00Z`,
      trainFrom: trainModel.train_from,
      trainTo: trainModel.train_to || "2023-12-31",
      publicProjection: "per_matter_projection",
      evidenceEventIds: [`cte:zap-applicant-train:${conditioned.cohort_id}`],
    });
    if (prediction) {
      predictions.push(prediction);
      // Occurrence of disposition always resolves; calibration uses probability
      // vs realized approval via conditionedRows. Event kind match keeps the
      // contract harness wired for resolution counts.
      events.push({
        event_id: `cte:zap-disposition:${row.project_id}`,
        subject_ref: prediction.subject_ref,
        event_kind: "land.zap_disposition",
        valid_at: row.disposition_date,
      });
    }
  }

  const conditionedBrier = brierScore(conditionedRows);
  const unconditionedBrier = brierScore(baseRows);
  const beatsBaseRate = conditionedBrier != null
    && unconditionedBrier != null
    && conditionedRows.length >= minN
    && conditionedBrier < unconditionedBrier - Number.EPSILON;

  let contractBacktest = null;
  if (predictions.length) {
    contractBacktest = evaluatePredictionBacktest({
      domain: "land",
      split_date: splitDate,
      grace_days: 0,
      open_event_kinds: ["land.zap_milestone"],
      terminal_event_kinds: ["land.zap_disposition"],
      predictions,
      events,
    });
    delete contractBacktest.public_projection;
  }

  return {
    split_date: splitDate,
    evaluation_n: conditionedRows.length,
    minimum_evaluation_n: minN,
    conditioned_brier: conditionedBrier,
    unconditioned_brier: unconditionedBrier,
    beats_base_rate: beatsBaseRate,
    public_projection: beatsBaseRate ? "per_matter_projection" : "descriptive_history",
    contract_backtest: contractBacktest,
    note: beatsBaseRate
      ? "Applicant-conditioned rates beat the unconditioned base rate out of sample (lower Brier)."
      : "Applicant-conditioned rates do not beat the unconditioned base rate out of sample; public surfaces show them as descriptive history only.",
  };
}

/** Attach cohort context and, only after a passing backtest, its timing assertion. */
export function attachZoningStatistics(record, model, opts = {}) {
  if (!record || typeof record !== "object") return record;
  const source = { ...(record.open_data || {}), ...record };
  const cohort = chooseZoningCohort(model, source);
  if (!cohort) return { ...record, zoning_statistics: null };
  const shipBarPassed = model?.backtest?.ship_bar?.status === "pass"
    || opts.requirePassingBacktest === false;
  const prediction = shipBarPassed
    ? emitZoningStatisticalPrediction(record, cohort, opts)
    : null;

  const applicantModel = model?.applicant_conditioning || opts.applicantModel || null;
  const conditioned = chooseApplicantCohort(applicantModel, source);
  const publicProjection = applicantModel?.backtest?.public_projection
    || applicantModel?.public_projection
    || "descriptive_history";
  let applicantView = null;
  let applicantPrediction = null;
  if (conditioned && conditioned.n >= MIN_ZONING_COHORT) {
    applicantView = {
      ...conditioned,
      base_rate: {
        n: cohort.n,
        approved: cohort.outcome_rates.approved,
        outcome_rates: cohort.outcome_rates,
        train_from: cohort.train_from,
        cohort_id: cohort.cohort_id,
        level: cohort.level,
      },
      copy: applicantConditionedCopy(conditioned, cohort, { publicProjection }),
      public_projection: publicProjection,
      formula_url: "about.html#applicant-conditioned-ulurp",
      display_mode: publicProjection === "per_matter_projection"
        ? "conditioned_with_base_rate"
        : "descriptive_history_with_base_rate",
    };
    applicantPrediction = emitApplicantOutcomePrediction(record, conditioned, cohort, {
      ...opts,
      publicProjection,
    });
  }

  const predictions = [
    ...(Array.isArray(record.predictions) ? record.predictions : []),
    ...(prediction ? [prediction] : []),
    ...(applicantPrediction ? [applicantPrediction] : []),
  ];

  return {
    ...record,
    zoning_statistics: {
      ...cohort,
      copy: zoningStatisticCopy(cohort),
      display_mode: shipBarPassed && prediction
        ? "cohort_statistic_and_timing"
        : "cohort_statistic_only",
      formula_url: "about.html#zoning-base-rates",
      applicant_conditioned: applicantView,
    },
    predictions,
  };
}
