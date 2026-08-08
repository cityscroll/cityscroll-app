import { officialSourceLink } from "./affordance_grammar.mjs";

/**
 * Mandates prediction-alerts (capstone): deadline/recurrence → expected civic event.
 *
 * Derives a predicted expected event and its window from mandate structure so
 * agency watchers receive an earlier-stage digest alert ahead of the deadline.
 * Scenario graph branch: mandate → predicted event E by deadline D → alert
 * ahead of D → (later) observed via process conformance.
 *
 * v1 method is deadline + cadence only (no ML). Seam for richer prediction
 * (process-conformance feedback, phase-duration models) is left open via
 * `basis.method` and `enrichment_pending`.
 *
 * Product term: mandates. Storage lens remains obligations. Upstream extract
 * vocabulary is not user-facing.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { agencyObligationsFollowHref } from "./agency_obligations.mjs";
import {
  DETECTABLE_DELIVERABLES,
  EXPECTED_EVENT_BY_DELIVERABLE,
  OBSERVATION_STATUS,
  expectedEventForDeliverable,
  isDetectableDeliverable,
} from "./process_conformance.mjs";

export const MANDATE_PREDICTION_SCHEMA = "cityscroll.mandate_prediction_alerts.v1";
export const MANDATE_PREDICTION_METHOD = "mandate_deadline_cadence_v1";
export const MANDATE_PREDICTION_ITERATION = "v1";

/** Deliverable types with a predictable public-record expected event in v1. */
export const PREDICTABLE_DELIVERABLES = Object.freeze([...DETECTABLE_DELIVERABLES]);

/** Reader lead — plain forward-looking expectation, no hedges. */
export const MANDATE_PREDICTION_COPY = Object.freeze({
  lead:
    "Expected public-record events for this agency’s rulemaking and report mandates, timed from each duty’s statutory deadline and recurrence.",
});

/** Alert bands aligned with cityscroll.prediction.v0 product vocabulary. */
export const PREDICTION_BANDS = Object.freeze({
  FAR: "far",
  APPROACHING: "approaching",
  IMMINENT: "imminent",
  OVERDUE: "overdue",
});

export const PREDICTION_BAND_LABELS = Object.freeze({
  [PREDICTION_BANDS.FAR]: "Later",
  [PREDICTION_BANDS.APPROACHING]: "Approaching",
  [PREDICTION_BANDS.IMMINENT]: "Due soon",
  [PREDICTION_BANDS.OVERDUE]: "Past statutory date",
});

const DAY_MS = 86_400_000;

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function validDate(value) {
  const date = clean(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date
    ? null
    : date;
}

function dayNumber(iso) {
  return Date.parse(`${iso}T12:00:00Z`) / DAY_MS;
}

export function addCalendarDays(iso, days) {
  const day = validDate(iso);
  if (!day || !Number.isFinite(days)) return null;
  return new Date((dayNumber(day) + days) * DAY_MS).toISOString().slice(0, 10);
}

function addUtcMonths(iso, months) {
  const day = validDate(iso);
  if (!day || !Number.isFinite(months)) return null;
  const d = new Date(`${day}T12:00:00Z`);
  const dayOfMonth = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dayOfMonth, last));
  return d.toISOString().slice(0, 10);
}

function addUtcYears(iso, years) {
  return addUtcMonths(iso, years * 12);
}

/** Normalize recurrence tokens from the enacted-law extract. */
export function normalizeRecurrence(raw) {
  const text = clean(raw, 80).toLowerCase();
  if (!text) return "one-time";
  if (/^one[- ]?time$|^once$|^single$/.test(text)) return "one-time";
  if (/^annual|^yearly|once a year|each year|every year/.test(text)) return "annual";
  if (/^quarter|^every 3 months|every three months/.test(text)) return "quarterly";
  if (/^month|every month|monthly/.test(text)) return "monthly";
  if (/^biennial|every 2 years|every two years/.test(text)) return "biennial";
  if (/every 5 years|every five years|quinquennial/.test(text)) return "every_5_years";
  if (/^ongoing|^standing|^continuous/.test(text)) return "ongoing";
  return text.replace(/\s+/g, "_").slice(0, 40);
}

/**
 * Project the next expected deadline from a past or future statutory date + cadence.
 * Returns null when no standable date can be derived (one-time past, undated, unknown cadence).
 *
 * @param {string|null} computedDate YYYY-MM-DD
 * @param {string|null} recurrence
 * @param {string} todayISO
 * @returns {{ expected_deadline: string, deadline_source: "as_stated"|"rolled_forward", recurrence: string }|null}
 */
export function projectExpectedDeadline(computedDate, recurrence, todayISO) {
  const today = validDate(todayISO) || new Date().toISOString().slice(0, 10);
  const stated = validDate(computedDate);
  const cadence = normalizeRecurrence(recurrence);

  if (!stated) {
    // Undated: never invent a calendar day. Cadence-only rows are handled separately.
    return null;
  }

  if (stated >= today) {
    return {
      expected_deadline: stated,
      deadline_source: "as_stated",
      recurrence: cadence,
    };
  }

  // Past stated date: roll forward only when recurrence is a known cycle.
  let stepMonths = null;
  if (cadence === "monthly") stepMonths = 1;
  else if (cadence === "quarterly") stepMonths = 3;
  else if (cadence === "annual") stepMonths = 12;
  else if (cadence === "biennial") stepMonths = 24;
  else if (cadence === "every_5_years") stepMonths = 60;
  else return null;

  let next = stated;
  // Cap iterations so pathological extract dates cannot loop forever.
  for (let i = 0; i < 400; i += 1) {
    const advanced = addUtcMonths(next, stepMonths);
    if (!advanced || advanced <= next) return null;
    next = advanced;
    if (next >= today) {
      return {
        expected_deadline: next,
        deadline_source: "rolled_forward",
        recurrence: cadence,
      };
    }
  }
  return null;
}

/**
 * Band for days until expected deadline (negative = past).
 * imminent ≤14, approaching ≤90, far >90, overdue <0.
 */
export function predictionBandFromDays(days) {
  if (!Number.isFinite(days)) return null;
  if (days < 0) return PREDICTION_BANDS.OVERDUE;
  if (days <= 14) return PREDICTION_BANDS.IMMINENT;
  if (days <= 90) return PREDICTION_BANDS.APPROACHING;
  return PREDICTION_BANDS.FAR;
}

export function isPredictableDeliverable(deliverableType) {
  return isDetectableDeliverable(deliverableType);
}

/**
 * Build one prediction row from a mandate obligation.
 * Returns null when the mandate is not a predictable deliverable or has no standable window.
 *
 * @param {object} row obligation row
 * @param {{ todayISO?: string, includeCadenceOnly?: boolean, observation?: object|null }} [opts]
 */
export function buildMandatePrediction(row = {}, opts = {}) {
  const deliverable = clean(row.deliverable_type, 40).toLowerCase() || "other";
  if (!isPredictableDeliverable(deliverable)) return null;

  const today = validDate(opts.todayISO) || new Date().toISOString().slice(0, 10);
  const expected = expectedEventForDeliverable(deliverable);
  const cadence = normalizeRecurrence(row.recurrence);
  const resolved = projectExpectedDeadline(
    row.deadline?.computed_date || row.deadline_date,
    row.recurrence,
    today,
  );

  const mandateId = clean(row.obligation_id || row.mandate_id, 80);
  if (!mandateId) return null;

  const duty = clean(row.duty_text || row.short_title, 500);
  if (!duty) return null;

  // Cadence-only: recurring predictable duty with no computable date — surface
  // the expected event + recurrence without inventing a calendar day.
  if (!resolved) {
    if (!opts.includeCadenceOnly) return null;
    if (cadence === "one-time" || cadence === "ongoing") return null;
    return {
      mandate_id: mandateId,
      obligation_id: mandateId,
      matter_id: clean(row.matter_id, 40) || null,
      agency_id: clean(row.agency_id, 120) || null,
      agency_name: clean(row.agency_name, 200) || null,
      duty_text: duty,
      deliverable_type: deliverable,
      citation: clean(row.citation, 200) || null,
      recurrence: cadence,
      source_href: clean(row.source?.legistar_url || row.legistar_url || row.href, 400) || null,
      expected_event: {
        kind: expected.kind,
        label: expected.label,
        signal: expected.signal,
      },
      predicted_window: null,
      expected_deadline: null,
      days_to_deadline: null,
      prediction_band: null,
      prediction_band_label: null,
      deadline_source: "cadence_only",
      basis: {
        method: MANDATE_PREDICTION_METHOD,
        recurrence: cadence,
        statute_deadline: validDate(row.deadline?.computed_date) || null,
        // Seam: later models may replace cadence-only with calibrated windows.
        enrichment: "pending_richer_prediction",
      },
      alert_id: `obligation:${mandateId}:cadence:${cadence}`,
      observation_status: opts.observation?.status || null,
      observed_record: opts.observation?.observed_record || null,
      compliance_verdict: null,
    };
  }

  const expectedDeadline = resolved.expected_deadline;
  const days = Math.round(dayNumber(expectedDeadline) - dayNumber(today));
  const band = predictionBandFromDays(days);
  // Predicted window: p50 = statutory/resolved deadline; p10/p90 bracket early notice.
  const window = {
    p10: addCalendarDays(expectedDeadline, -30),
    p50: expectedDeadline,
    p90: expectedDeadline,
  };

  return {
    mandate_id: mandateId,
    obligation_id: mandateId,
    matter_id: clean(row.matter_id, 40) || null,
    agency_id: clean(row.agency_id, 120) || null,
    agency_name: clean(row.agency_name, 200) || null,
    duty_text: duty,
    deliverable_type: deliverable,
    citation: clean(row.citation, 200) || null,
    recurrence: resolved.recurrence,
    source_href: clean(row.source?.legistar_url || row.legistar_url || row.href, 400) || null,
    expected_event: {
      kind: expected.kind,
      label: expected.label,
      signal: expected.signal,
    },
    predicted_window: window,
    expected_deadline: expectedDeadline,
    days_to_deadline: days,
    prediction_band: band,
    prediction_band_label: PREDICTION_BAND_LABELS[band] || null,
    deadline_source: resolved.deadline_source,
    basis: {
      method: MANDATE_PREDICTION_METHOD,
      recurrence: resolved.recurrence,
      statute_deadline: validDate(row.deadline?.computed_date) || expectedDeadline,
      enrichment: null,
    },
    // Cycle identity: each resolved deadline is one digest fire.
    alert_id: `obligation:${mandateId}:${expectedDeadline}`,
    observation_status: opts.observation?.status || null,
    observed_record: opts.observation?.observed_record || null,
    compliance_verdict: null,
  };
}

/**
 * Shareable constellation anchor for the Mandates prediction-alerts card.
 */
export function agencyMandatePredictionsPath(agencyIdOrName) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return "/agencies/";
  return `/agencies/${encodeURIComponent(identity.canonical_id)}/#mandates-predictions`;
}

/**
 * Build the agency prediction-alerts view for constellation embedding.
 *
 * @param {string} agencyIdOrName
 * @param {{
 *   obligationsLookup?: object,
 *   conformanceItems?: object[],
 *   todayISO?: string,
 *   limit?: number,
 *   includeCadenceOnly?: boolean,
 * }} sources
 */
export function buildAgencyMandatePredictionsView(agencyIdOrName, sources = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return null;

  const bucket = sources.obligationsLookup?.by_agency?.[identity.canonical_id] || null;
  const allMandates = Array.isArray(bucket?.obligations) ? bucket.obligations : [];
  const predictable = allMandates.filter((row) => isPredictableDeliverable(row?.deliverable_type));

  const confById = new Map();
  for (const item of sources.conformanceItems || []) {
    const mid = item?.mandate_id || item?.obligation_id;
    if (mid) confById.set(mid, item);
  }

  const today = validDate(sources.todayISO) || new Date().toISOString().slice(0, 10);
  const includeCadenceOnly = sources.includeCadenceOnly !== false;
  const predictions = [];
  for (const row of predictable) {
    const conf = confById.get(row.obligation_id) || null;
    const obs = conf?.observation || null;
    // Only attach a standable observed filing — other conformance statuses
    // belong on the expected-vs-observed surface, not the prediction branch.
    const standableObs = obs?.status === OBSERVATION_STATUS.OBSERVED && obs?.observed_record
      ? obs
      : null;
    const pred = buildMandatePrediction(row, {
      todayISO: today,
      includeCadenceOnly,
      observation: standableObs,
    });
    if (pred) predictions.push(pred);
  }

  // Dated first (soonest), then cadence-only. Observed fillings stay listed —
  // prediction is the forward branch; observation is a separate fact when present.
  predictions.sort((left, right) => {
    const leftDate = left.expected_deadline || "9999";
    const rightDate = right.expected_deadline || "9999";
    if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
    const bandRank = {
      [PREDICTION_BANDS.IMMINENT]: 0,
      [PREDICTION_BANDS.APPROACHING]: 1,
      [PREDICTION_BANDS.FAR]: 2,
      [PREDICTION_BANDS.OVERDUE]: 3,
    };
    const leftBand = bandRank[left.prediction_band] ?? 9;
    const rightBand = bandRank[right.prediction_band] ?? 9;
    if (leftBand !== rightBand) return leftBand - rightBand;
    return String(left.mandate_id).localeCompare(String(right.mandate_id));
  });

  const limit = Math.max(1, Math.min(Number(sources.limit) || 16, 40));
  const listed = predictions.slice(0, limit);
  const datedCount = predictions.filter((p) => p.expected_deadline).length;
  const approachingCount = predictions.filter((p) =>
    p.prediction_band === PREDICTION_BANDS.IMMINENT
    || p.prediction_band === PREDICTION_BANDS.APPROACHING).length;

  if (!predictions.length) {
    return {
      schema: MANDATE_PREDICTION_SCHEMA,
      method: MANDATE_PREDICTION_METHOD,
      iteration: MANDATE_PREDICTION_ITERATION,
      status: "empty",
      agency_id: identity.canonical_id,
      agency_name: identity.canonical_name,
      subject_ref: `agency:id:${identity.canonical_id}`,
      as_of: today,
      counts: {
        predictable_mandates: predictable.length,
        predictions: 0,
        dated_predictions: 0,
        approaching: 0,
      },
      predictions: [],
      copy: MANDATE_PREDICTION_COPY,
      share_path: agencyMandatePredictionsPath(identity.canonical_id),
      follow_href: agencyObligationsFollowHref(identity.canonical_id, { windowDays: 90 }),
      rulemaking_follow_href: agencyObligationsFollowHref(identity.canonical_id, {
        deliverableType: "rulemaking",
        windowDays: 90,
      }),
      report_follow_href: agencyObligationsFollowHref(identity.canonical_id, {
        deliverableType: "report",
        windowDays: 90,
      }),
    };
  }

  return {
    schema: MANDATE_PREDICTION_SCHEMA,
    method: MANDATE_PREDICTION_METHOD,
    iteration: MANDATE_PREDICTION_ITERATION,
    status: "matched",
    agency_id: identity.canonical_id,
    agency_name: identity.canonical_name,
    subject_ref: `agency:id:${identity.canonical_id}`,
    as_of: today,
    counts: {
      predictable_mandates: predictable.length,
      predictions: predictions.length,
      dated_predictions: datedCount,
      approaching: approachingCount,
    },
    predictions: listed,
    copy: MANDATE_PREDICTION_COPY,
    share_path: agencyMandatePredictionsPath(identity.canonical_id),
    follow_href: agencyObligationsFollowHref(identity.canonical_id, { windowDays: 90 }),
    rulemaking_follow_href: agencyObligationsFollowHref(identity.canonical_id, {
      deliverableType: "rulemaking",
      windowDays: 90,
    }),
    report_follow_href: agencyObligationsFollowHref(identity.canonical_id, {
      deliverableType: "report",
      windowDays: 90,
    }),
  };
}

/**
 * World-state digest rows: predicted mandate events inside the watch window.
 * Prefer resolved next cycle over raw past statute dates for recurring duties.
 * Never invents compliance.
 *
 * @param {object} lookup agency_obligations_lookup
 * @param {string} agencyId
 * @param {{ todayISO?: string, windowDays?: number, pastDays?: number, deliverableType?: string|null }} [opts]
 */
export function mandatePredictionDigestRowsForAgency(lookup, agencyId, {
  todayISO,
  windowDays = 90,
  pastDays = 14,
  deliverableType = null,
} = {}) {
  const identity = resolveAgencyIdentity(agencyId);
  const id = identity?.canonical_id || clean(agencyId, 120);
  const bucket = lookup?.by_agency?.[id];
  if (!bucket) return [];

  const today = validDate(todayISO) || new Date().toISOString().slice(0, 10);
  const window = Number.isFinite(Number(windowDays))
    ? Math.max(1, Math.min(365, Math.round(Number(windowDays))))
    : 90;
  const past = Number.isFinite(Number(pastDays))
    ? Math.max(0, Math.min(3650, Math.round(Number(pastDays))))
    : 14;
  const typeFilter = clean(deliverableType, 40).toLowerCase() || null;

  const rows = [];
  for (const row of bucket.obligations || []) {
    if (typeFilter && clean(row.deliverable_type, 40).toLowerCase() !== typeFilter) continue;
    if (!isPredictableDeliverable(row.deliverable_type)) continue;

    const pred = buildMandatePrediction(row, {
      todayISO: today,
      includeCadenceOnly: false,
    });
    if (!pred || !pred.expected_deadline) continue;

    const days = pred.days_to_deadline;
    if (!Number.isFinite(days)) continue;
    if (days > window || days < -past) continue;

    rows.push(digestRowFromPrediction(pred, today));
  }

  return rows.sort((left, right) => {
    const leftDate = left.deadline_date || left.expected_deadline || "9999";
    const rightDate = right.deadline_date || right.expected_deadline || "9999";
    return leftDate.localeCompare(rightDate);
  });
}

function digestRowFromPrediction(pred, today) {
  const days = pred.days_to_deadline;
  const band = pred.prediction_band === PREDICTION_BANDS.OVERDUE
    ? "past_date"
    : pred.prediction_band === PREDICTION_BANDS.IMMINENT
      ? "within_30_days"
      : pred.prediction_band === PREDICTION_BANDS.APPROACHING
        ? "within_window"
        : "within_window";

  return {
    alert_id: pred.alert_id,
    obligation_id: pred.obligation_id,
    mandate_id: pred.mandate_id,
    matter_id: pred.matter_id,
    agency_id: pred.agency_id,
    agency_name: pred.agency_name,
    short_title: pred.duty_text,
    duty_text: pred.duty_text,
    deliverable_type: pred.deliverable_type,
    recurrence: pred.recurrence,
    deadline_date: pred.expected_deadline,
    deadline_text: null,
    deadline_band: band,
    days_to_deadline: days,
    as_of: today,
    citation: pred.citation,
    legistar_url: pred.source_href,
    certification_status: null,
    observation_status: pred.observation_status || "not_adjudicated",
    compliance_verdict: null,
    start_date: pred.expected_deadline || today,
    // Prediction branch fields (digest + preview).
    predicted_event: true,
    expected_event_kind: pred.expected_event?.kind || null,
    expected_event_label: pred.expected_event?.label || null,
    predicted_window: pred.predicted_window,
    prediction_band: pred.prediction_band,
    prediction_band_label: pred.prediction_band_label,
    prediction_method: MANDATE_PREDICTION_METHOD,
    deadline_source: pred.deadline_source,
  };
}

/**
 * Merge prediction-aware rows into the free-watch digest set.
 * Dated predictable mandates use resolved next cycles; other mandates keep
 * the classic deadline / standing path from obligationDigestRowsForAgency.
 *
 * @param {object[]} baseRows from obligationDigestRowsForAgency
 * @param {object[]} predictionRows from mandatePredictionDigestRowsForAgency
 */
export function mergeObligationDigestWithPredictions(baseRows = [], predictionRows = []) {
  const byObligation = new Map();
  for (const row of baseRows) {
    const key = row.obligation_id || row.alert_id;
    if (key) byObligation.set(key, row);
  }
  for (const pred of predictionRows) {
    const key = pred.obligation_id || pred.alert_id;
    if (!key) continue;
    // Prediction branch replaces the same mandate's raw past/standing row when
    // a dated expected window is available for this cycle.
    byObligation.set(key, pred);
  }
  return [...byObligation.values()].sort((left, right) => {
    const leftDate = left.deadline_date || "9999";
    const rightDate = right.deadline_date || "9999";
    return leftDate.localeCompare(rightDate);
  });
}

/**
 * Compact HTML for constellation embedding (#mandates-predictions).
 * Omits entirely when empty — no absence disclaimers.
 */
export function renderMandatePredictionsSection(view) {
  if (!view || view.status !== "matched") return "";
  const counts = view.counts || {};
  const statusLine = [
    counts.predictions
      ? `${counts.predictions} expected event${counts.predictions === 1 ? "" : "s"}`
      : null,
    counts.approaching
      ? `${counts.approaching} approaching`
      : null,
  ].filter(Boolean).join(" · ");

  const list = (view.predictions || []).length
    ? `<ul class="node-record-list mandate-predictions-list" data-bridge-side="predicted-events">${
      view.predictions.map((item) => {
        const eventLabel = item.expected_event?.label || item.deliverable_type;
        const windowLine = item.expected_deadline
          ? (Number.isFinite(item.days_to_deadline) && item.days_to_deadline >= 0
            ? `expected by ${item.expected_deadline} · ${item.days_to_deadline} day${item.days_to_deadline === 1 ? "" : "s"}`
            : `expected by ${item.expected_deadline}`)
          : (item.recurrence && item.recurrence !== "one-time"
            ? `${item.recurrence.replace(/_/g, " ")} cycle`
            : null);
        const meta = [
          eventLabel,
          windowLine,
          item.prediction_band_label,
          item.deliverable_type,
          item.citation,
        ].filter(Boolean).map(esc).join(" · ");
        const chip = item.prediction_band_label
          ? `<span class="mandate-pred-chip mandate-pred-${esc(item.prediction_band || "far")}" data-prediction-band="${esc(item.prediction_band || "")}">${esc(item.prediction_band_label)}</span>`
          : (item.deadline_source === "cadence_only"
            ? `<span class="mandate-pred-chip mandate-pred-cadence" data-prediction-band="cadence">Recurring</span>`
            : "");
        const source = item.source_href
          ? ` · ${officialSourceLink({ href: item.source_href, label: "Source law", className: "agency-source-link", escape: esc })}`
          : "";
        return `<li class="node-record mandate-prediction" data-mandate-id="${esc(item.mandate_id)}" data-deliverable-type="${esc(item.deliverable_type)}" data-expected-event-kind="${esc(item.expected_event?.kind || "")}"${item.expected_deadline ? ` data-expected-deadline="${esc(item.expected_deadline)}"` : ""}${item.prediction_band ? ` data-prediction-band="${esc(item.prediction_band)}"` : ""}>
          <div class="node-record-main">${chip}${esc(item.duty_text)}</div>
          <span class="muted node-muted">${meta}${source}</span>
        </li>`;
      }).join("")
    }</ul>`
    : "";

  const actions = [
    view.follow_href
      ? `<a class="node-action civic-object-action" href="${esc(view.follow_href)}">Watch expected mandate events</a>`
      : "",
    view.report_follow_href
      ? `<a class="node-action civic-object-action" href="${esc(view.report_follow_href)}">Watch report mandates</a>`
      : "",
    view.rulemaking_follow_href
      ? `<a class="node-action civic-object-action" href="${esc(view.rulemaking_follow_href)}">Watch rulemaking mandates</a>`
      : "",
    view.share_path
      ? `<a class="node-action civic-object-action" href="${esc(view.share_path)}">Share this view</a>`
      : "",
  ].filter(Boolean).join("");

  const copy = view.copy || MANDATE_PREDICTION_COPY;
  return `<section id="mandates-predictions" class="node-section node-card civic-object-section mandate-prediction-alerts" data-agency-constellation-card="mandates-predictions" data-method="${esc(view.method || MANDATE_PREDICTION_METHOD)}" data-status="${esc(view.status)}" data-export-class="object_members" data-as-of="${esc(view.as_of || "")}">
    <h2>Expected mandate events <span class="muted node-muted">(${esc(statusLine || "linked")})</span></h2>
    <p class="node-muted muted">${esc(copy.lead || MANDATE_PREDICTION_COPY.lead)}</p>
    ${list}
    ${actions ? `<p class="node-inline-actions civic-object-inline-actions">${actions}</p>` : ""}
  </section>`;
}

/** Minimal CSS for prediction band chips on the card. */
export const MANDATE_PREDICTION_STYLE = `
.mandate-prediction-alerts .mandate-pred-chip {
  display: inline-block;
  margin-inline-end: 0.5rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  border: 1px solid var(--color-border, #c8c8c8);
  font: 600 0.75rem/1.3 var(--font-body, system-ui, sans-serif);
  letter-spacing: 0.01em;
  vertical-align: 0.05em;
  white-space: nowrap;
  background: color-mix(in srgb, var(--color-action, #0b57d0) 10%, transparent);
  border-color: color-mix(in srgb, var(--color-action, #0b57d0) 30%, var(--color-border, #c8c8c8));
}
.mandate-prediction-alerts .mandate-pred-imminent {
  background: color-mix(in srgb, #b06000 14%, transparent);
  border-color: color-mix(in srgb, #b06000 40%, var(--color-border, #c8c8c8));
}
.mandate-prediction-alerts .mandate-pred-approaching {
  background: color-mix(in srgb, var(--color-action, #0b57d0) 14%, transparent);
}
.mandate-prediction-alerts .mandate-pred-overdue {
  background: color-mix(in srgb, #666 12%, transparent);
}
`;

// Re-export expected-event map for callers that want the full table without
// importing process_conformance.
export { EXPECTED_EVENT_BY_DELIVERABLE, expectedEventForDeliverable };
