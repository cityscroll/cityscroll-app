/**
 * Resident renderer for the bounded "Application filings" and "Filing
 * history" sections (LDP-27). Accepts a precomputed `land_filing_evidence_summary.v1`
 * record only -- it does not resolve an obligation, extract a report, or
 * fetch a publisher. Placed near, but never inside, the "Where this stands"
 * authority panel (`land_authority_summary_view.mjs`): this module renders
 * only filing evidence and never touches environmental review, authority/
 * decision, or the final Commission outcome.
 *
 * The full structured report (every RER section with page citations) is
 * deliberately not built here -- it stays behind `ensureLandFilingReportRuntime()`
 * (`app/land_filing_report_runtime.mjs`), fetched only when a reader asks to
 * see it, so a full report never enters the first-paint payload (A6, A7).
 */
import { officialSourceLink } from "./affordance_grammar.mjs";
import {
  landFilingApplicabilityExplanationKey,
  landFilingFulfillmentExplanationKey,
} from "./land_filing_evidence_facet.mjs";

export const LAND_FILING_EVIDENCE_URL = "data/land_filing_evidence_summary.json";
export const LAND_FILING_REPORT_TRIGGER_ATTR = "data-land-filing-report-trigger";

let landFilingEvidenceLookup = null;

export function rememberLandFilingEvidence(payload) {
  landFilingEvidenceLookup = payload?.summaries && typeof payload.summaries === "object" ? payload.summaries : {};
  return landFilingEvidenceLookup;
}

export function attachLandFilingEvidenceSummaries(target, payload) {
  if (payload) rememberLandFilingEvidence(payload);
  const lookup = landFilingEvidenceLookup;
  const rows = Array.isArray(target) ? target : target?.projects;
  if (lookup && Array.isArray(rows)) {
    for (const row of rows) {
      const summary = lookup[row?.project_id];
      if (summary) row.filing_evidence = summary;
    }
  }
  return target;
}

export function landFilingEvidenceFor(row) {
  return row?.filing_evidence || landFilingEvidenceLookup?.[row?.project_id] || null;
}

export function loadLandFilingEvidenceLookup() {
  return fetch(LAND_FILING_EVIDENCE_URL, { cache: "force-cache", credentials: "omit" })
    .then((response) => response.ok ? response.json() : null)
    .then((payload) => rememberLandFilingEvidence(payload))
    .catch(() => rememberLandFilingEvidence(null));
}

function fmtDate(value) {
  return value ? String(value).slice(0, 10) : null;
}

function extractionQualityLabel(quality, translate) {
  return translate(`land_filing_extraction_quality_${quality || "unknown"}`);
}

function originalDocumentLinkHTML(original, translate, esc) {
  const href = original?.canonical_public_url || original?.discovery_endpoint;
  if (!href) return `<span data-land-filing-source="unavailable">${esc(translate("land_filing_source_unavailable"))}</span>`;
  return officialSourceLink({
    href,
    label: original.original_name || translate("land_outcomes_document_lbl"),
    className: "land-filing-source",
    escape: esc,
    newTabLabel: translate("ext_link_new_tab_sr"),
  });
}

/**
 * The compact "Application filings" section (A1, A2, A3, A9): applicability
 * state + evidence, fulfilment state, preparation date where available, the
 * first-observed/publication clock, the original document, and extraction
 * quality. Renders nothing when there is no filing-evidence record at all --
 * an older or out-of-scope project keeps its generic document rendering and
 * gets no extra, synthesized section (A9).
 */
export function landFilingEvidenceSummaryHTML(summary, { t, escape } = {}) {
  if (!summary || summary.schema !== "cityscroll.land_filing_evidence_summary.v1") return "";
  const translate = typeof t === "function" ? t : (key) => key;
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");

  const applicabilityState = summary.applicability?.state || "unknown";
  const applicabilityCopy = translate(landFilingApplicabilityExplanationKey(applicabilityState));
  const fulfillmentState = summary.fulfillment?.state || "not_checked";
  const fulfillmentCopy = translate(landFilingFulfillmentExplanationKey(fulfillmentState));

  const report = summary.report;
  const prepDate = fmtDate(report?.report_preparation_date);
  const clockLabel = report?.first_observed_at
    ? translate("land_filing_first_observed_on", { date: fmtDate(report.first_observed_at) })
    : null;

  const reportRowsHTML = report
    ? `
      ${prepDate ? `<div><dt>${esc(translate("land_filing_preparation_date"))}</dt><dd data-land-filing-preparation-date="${esc(prepDate)}">${esc(prepDate)}</dd></div>` : ""}
      <div><dt>${esc(translate("land_filing_clock"))}</dt><dd data-land-filing-first-observed="${esc(report.first_observed_at || "")}">${esc(clockLabel || translate("land_authority_unknown"))}</dd></div>
      <div><dt>${esc(translate("land_filing_original_document"))}</dt><dd data-land-filing-original-document="1">${originalDocumentLinkHTML(report.original_document, translate, esc)}</dd></div>
      <div><dt>${esc(translate("land_filing_extraction_quality"))}</dt><dd data-land-filing-extraction-quality="${esc(report.extraction_quality || "unknown")}">${esc(extractionQualityLabel(report.extraction_quality, translate))}</dd></div>
    `
    : "";

  const viewFullReportHTML = report
    ? `<button type="button" class="act" ${LAND_FILING_REPORT_TRIGGER_ATTR}="1" data-document-ref="${esc(report.document_ref)}">${esc(translate("land_filing_view_full_report"))}</button>`
    : "";

  return `<section class="land-filing-evidence" id="land-filing-evidence" data-land-filing-evidence="1" data-project-ref="${esc(summary.project_ref || "")}" data-applicability-state="${esc(applicabilityState)}" data-fulfillment-state="${esc(fulfillmentState)}">
    <h3 class="land-filing-kicker">${esc(translate("land_filing_heading"))}</h3>
    <dl class="land-filing-facts">
      <div><dt>${esc(translate("land_filing_applicability"))}</dt><dd data-land-filing-applicability="${esc(applicabilityState)}">${esc(applicabilityCopy)}</dd></div>
      <div><dt>${esc(translate("land_filing_fulfillment"))}</dt><dd data-land-filing-fulfillment="${esc(fulfillmentState)}">${esc(fulfillmentCopy)}</dd></div>
      ${reportRowsHTML}
    </dl>
    ${viewFullReportHTML}
    <div class="land-filing-report-detail" data-land-filing-report-detail-root="1" hidden></div>
  </section>`;
}

/**
 * The neutral "Filing history" section (LDP-26's own digest, relabelled for
 * residents only -- never re-derived, never re-ordered). Bounded to the
 * digest's own limit; a truncation notice is shown rather than silently
 * dropping later events.
 */
export function landFilingHistoryHTML(digest, { t, escape } = {}) {
  if (!digest || !Array.isArray(digest.events) || digest.events.length === 0) return "";
  const translate = typeof t === "function" ? t : (key) => key;
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  const rows = digest.events.map((event) => {
    const label = translate(`land_filing_event_${event.event_kind}`);
    const date = fmtDate(event.observed_at);
    const conflictBadge = event.conflict_state && event.conflict_state !== "none"
      ? ` <span class="land-filing-conflict" data-land-filing-conflict="${esc(event.conflict_state)}">${esc(translate(`land_filing_conflict_${event.conflict_state}`))}</span>`
      : "";
    return `<li data-land-filing-event="${esc(event.event_kind)}" data-observed-at="${esc(event.observed_at || "")}">${esc(label)}${date ? ` — ${esc(date)}` : ""}${conflictBadge}</li>`;
  }).join("");
  const truncatedNote = digest.truncated
    ? `<p class="land-filing-history-truncated" data-land-filing-history-truncated="1">${esc(translate("land_filing_history_truncated", { total: digest.total_ordered_event_count }))}</p>`
    : "";
  return `<section class="land-filing-history" id="land-filing-history" data-land-filing-history="1">
    <h3 class="land-filing-kicker">${esc(translate("land_filing_history_heading"))}</h3>
    <ul>${rows}</ul>
    ${truncatedNote}
  </section>`;
}

/**
 * Wires the "View full report" trigger inside an already-rendered detail
 * container. Kept here (not in `land.mjs`) so the click-to-lazy-load
 * mechanics live beside the markup they operate on -- `land.mjs` gets one
 * call site, preserving the headroom the Land route split (LM-04) requires.
 * Calls the global `ensureLandFilingReportRuntime()` registered by
 * `main.mjs` -- never imports the runtime module directly, so this stays a
 * plain function until a reader actually clicks.
 */
export function wireLandFilingReportTrigger(container, { t, escape } = {}) {
  const trigger = container?.querySelector(`[${LAND_FILING_REPORT_TRIGGER_ATTR}]`);
  if (!trigger) return;
  trigger.addEventListener("click", async () => {
    const root = container.querySelector("[data-land-filing-report-detail-root]");
    const documentRef = trigger.dataset.documentRef;
    trigger.disabled = true;
    try {
      const runtime = await ensureLandFilingReportRuntime();
      await runtime.mountLandFilingReportDetail(root, documentRef, { t, escape });
      trigger.hidden = true;
    } catch {
      trigger.disabled = false;
    }
  });
}

/** Both compact sections for one project row, concatenated -- land.mjs's one call site. */
export function landFilingEvidenceSectionsHTML(row, { t, escape } = {}) {
  const evidence = landFilingEvidenceFor(row);
  return landFilingEvidenceSummaryHTML(evidence, { t, escape })
    + landFilingHistoryHTML(evidence?.filing_history_digest, { t, escape });
}
