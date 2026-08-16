/**
 * Agency-scoped lifecycle conformance over bounded procurement event logs.
 *
 * The view compares a named expected process with source-backed traces and
 * mechanically aggregates evidence-relative deviation classes. It publishes
 * only when every included case has a stable identity and explicit clocks.
 */

import {
  PROCUREMENT_DEVIATION_CLASS,
  PROCUREMENT_EVENT_LOG_METHOD,
  PROCUREMENT_EVENT_LOG_SCHEMA,
  PROCUREMENT_EXPECTED_PROCESS,
} from "./procurement_event_log.mjs";
import { officialSourceLink } from "./affordance_grammar.mjs";

export const AGENCY_LIFECYCLE_CONFORMANCE_SCHEMA = "cityscroll.agency_lifecycle_conformance.v1";
export const AGENCY_LIFECYCLE_CONFORMANCE_METHOD = `${PROCUREMENT_EVENT_LOG_METHOD}+agency_aggregate_v1`;

const DEVIATION_ORDER = Object.freeze([
  PROCUREMENT_DEVIATION_CLASS.CONFORMING,
  PROCUREMENT_DEVIATION_CLASS.MISSING_OPEN_DATA,
  PROCUREMENT_DEVIATION_CLASS.OUT_OF_ORDER_TRACE,
]);

const DEVIATION_LABELS = Object.freeze({
  [PROCUREMENT_DEVIATION_CLASS.CONFORMING]: "Expected sequence observed",
  [PROCUREMENT_DEVIATION_CLASS.MISSING_OPEN_DATA]: "Some expected timestamps unavailable",
  [PROCUREMENT_DEVIATION_CLASS.OUT_OF_ORDER_TRACE]: "Different timestamp order observed",
});

const clean = (value, max = 240) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

function validDay(value) {
  const day = clean(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== day ? null : day;
}

function incompleteFields(cases) {
  const gaps = new Set();
  const identities = new Set();
  if (!cases.length) gaps.add("case_identity");
  for (const row of cases) {
    const caseId = clean(row?.case_id, 160);
    if (!caseId || identities.has(caseId) || row?.schema !== PROCUREMENT_EVENT_LOG_SCHEMA) {
      gaps.add("case_identity");
    }
    if (caseId) identities.add(caseId);
    if (!validDay(row?.data_as_of)) gaps.add("event_clock");
    if (!Array.isArray(row?.event_log) || row.event_log.some((event) => (
      clean(event?.case_id, 160) !== caseId
      || !clean(event?.clock, 40)
      || !validDay(event?.occurred_at)
    ))) {
      gaps.add("event_clock");
    }
  }
  return ["case_identity", "event_clock"].filter((field) => gaps.has(field));
}

function heldView(base, gaps) {
  return {
    ...base,
    status: "data_incomplete",
    incomplete_fields: gaps,
    data_as_of: null,
    case_count: null,
    cases: [],
    expected_stages: [],
    stage_completeness: null,
    deviation_counts: null,
  };
}

/**
 * Aggregate normalized procurement event-log envelopes for one named agency.
 */
export function buildAgencyLifecycleConformanceView({
  agency_id: agencyId,
  agency_name: agencyName,
  lifecycle_id: lifecycleId = "procurement",
  lifecycle_label: lifecycleLabel = "Procurement lifecycle",
  cases: rawCases = [],
} = {}) {
  const id = clean(agencyId, 120);
  const name = clean(agencyName, 200);
  const lifecycle = clean(lifecycleId, 80);
  const label = clean(lifecycleLabel, 160);
  const cases = Array.isArray(rawCases) ? rawCases : [];
  const base = {
    schema: AGENCY_LIFECYCLE_CONFORMANCE_SCHEMA,
    method: AGENCY_LIFECYCLE_CONFORMANCE_METHOD,
    source_method: PROCUREMENT_EVENT_LOG_METHOD,
    agency_id: id || null,
    agency_name: name || null,
    lifecycle_id: lifecycle || null,
    lifecycle_label: label || null,
    slice_label: name && label ? `${name} · ${label}` : null,
  };

  if (!id || !name || !lifecycle || !label) return heldView(base, ["case_identity"]);
  const gaps = incompleteFields(cases);
  if (gaps.length) return heldView(base, gaps);

  const expectedStages = PROCUREMENT_EXPECTED_PROCESS.map((stage) => ({ ...stage }));
  const deviationCounts = Object.fromEntries(DEVIATION_ORDER.map((key) => [key, 0]));
  for (const row of cases) {
    const deviationClass = clean(row?.deviation?.class, 80);
    if (!Object.prototype.hasOwnProperty.call(deviationCounts, deviationClass)) {
      return heldView(base, ["event_clock"]);
    }
    deviationCounts[deviationClass] += 1;
  }
  const stageCompleteness = expectedStages.map((stage) => {
    const observedCases = cases.filter((row) => row.observed_trace?.includes(stage.id)).length;
    return {
      id: stage.id,
      label: stage.label,
      observed_cases: observedCases,
      total_cases: cases.length,
      rate: cases.length ? observedCases / cases.length : null,
    };
  });
  const dataAsOf = cases.map((row) => row.data_as_of).sort()[0];

  return {
    ...base,
    status: "matched",
    incomplete_fields: [],
    data_as_of: dataAsOf,
    case_count: cases.length,
    cases: cases.map((row) => ({
      case_id: row.case_id,
      observed_trace: [...row.observed_trace],
      event_log: row.event_log.map((event) => ({ ...event, source: { ...event.source } })),
      deviation: { ...row.deviation },
    })),
    expected_stages: expectedStages,
    stage_completeness: stageCompleteness,
    deviation_counts: deviationCounts,
  };
}

function sourceLink(source) {
  const system = clean(source?.system, 120) || "Official record";
  const href = clean(source?.href, 500);
  if (!/^https:\/\//.test(href)) return esc(system);
  return officialSourceLink({ href, label: system, escape: esc });
}

function expectedStageList(view) {
  const completeness = new Map(view.stage_completeness.map((stage) => [stage.id, stage]));
  return `<ol class="agency-lifecycle-stages">${view.expected_stages.map((stage) => {
    const observed = completeness.get(stage.id);
    return `<li>
      <strong>${esc(stage.label)}</strong>
      <span>${esc(observed.observed_cases)} of ${esc(observed.total_cases)} cases · ${esc(stage.clock)} clock</span>
    </li>`;
  }).join("")}</ol>`;
}

function observedTraceList(view) {
  return `<ol class="agency-lifecycle-traces">${view.cases.map((row, index) => {
    const deviation = DEVIATION_LABELS[row.deviation.class] || "Trace compared";
    const events = row.event_log.map((event) => `<li>
      <strong>${esc(event.activity_label)}</strong>
      <span>${esc(event.occurred_at)} · ${sourceLink(event.source)}</span>
    </li>`).join("");
    return `<li class="agency-lifecycle-trace" data-case-id="${esc(row.case_id)}">
      <p><strong>Case ${index + 1}</strong> · ${esc(deviation)}</p>
      <ol>${events}</ol>
    </li>`;
  }).join("")}</ol>`;
}

/** Render the complete agency slice; held views remain non-public. */
export function renderAgencyLifecycleConformance(view) {
  if (view?.status !== "matched" || !view.case_count) return "";
  const deviationRows = DEVIATION_ORDER.map((key) => (
    `<li><span>${esc(DEVIATION_LABELS[key])}</span><strong>${esc(view.deviation_counts[key])}</strong></li>`
  )).join("");
  return `<section class="node-section agency-lifecycle-conformance" id="procurement-lifecycle-conformance" aria-labelledby="procurement-lifecycle-conformance-heading">
    <header class="node-section-heading">
      <p class="node-kicker">Agency lifecycle comparison</p>
      <h2 id="procurement-lifecycle-conformance-heading">${esc(view.slice_label)}</h2>
      <p class="node-muted muted">A bounded sample of ${esc(view.case_count)} joined cases compares the same five public-record stages.</p>
    </header>
    <div class="agency-lifecycle-compare">
      <section aria-labelledby="expected-lifecycle-heading">
        <h3 id="expected-lifecycle-heading">Expected stages</h3>
        ${expectedStageList(view)}
      </section>
      <section aria-labelledby="observed-lifecycle-heading">
        <h3 id="observed-lifecycle-heading">Observed traces</h3>
        ${observedTraceList(view)}
      </section>
    </div>
    <section class="agency-lifecycle-summary" aria-labelledby="lifecycle-deviations-heading">
      <h3 id="lifecycle-deviations-heading">Trace comparison</h3>
      <ul>${deviationRows}</ul>
      <p class="node-muted muted">Method: expected-stage replay of joined public timestamps · Data as of ${esc(view.data_as_of)}</p>
    </section>
  </section>`;
}

export const AGENCY_LIFECYCLE_CONFORMANCE_STYLE = `
.agency-lifecycle-compare {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}
.agency-lifecycle-compare > section,
.agency-lifecycle-summary {
  min-width: 0;
  padding: 1rem;
  border: 1px solid var(--color-border, #c8c8c8);
  border-radius: var(--radius-sm, 6px);
}
.agency-lifecycle-compare h3,
.agency-lifecycle-summary h3 {
  margin-top: 0;
}
.agency-lifecycle-stages,
.agency-lifecycle-traces,
.agency-lifecycle-trace ol,
.agency-lifecycle-summary ul {
  margin: 0;
  padding-left: 1.25rem;
}
.agency-lifecycle-stages li,
.agency-lifecycle-trace ol li {
  margin-block: 0.65rem;
}
.agency-lifecycle-stages span,
.agency-lifecycle-trace ol span {
  display: block;
  color: var(--color-text-muted, #555);
  font-size: 0.875rem;
}
.agency-lifecycle-trace + .agency-lifecycle-trace {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--color-border, #c8c8c8);
}
.agency-lifecycle-trace > p {
  margin: 0 0 0.35rem;
}
.agency-lifecycle-summary {
  margin-top: 1rem;
}
.agency-lifecycle-summary li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  max-width: 34rem;
}
@media (max-width: 700px) {
  .agency-lifecycle-compare { grid-template-columns: minmax(0, 1fr); }
}
`;
