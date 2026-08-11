import { constellationLink } from "./affordance_grammar.mjs";

/**
 * Mandates → Required Reports receipt card (first iteration).
 *
 * Connects report-type statutory mandates (deliverable_type = report) to the
 * observed City Record filing when process-conformance topic join hits — a
 * filing receipt that the required report appeared in the public record.
 * Where no filing is observed yet, show the mandate and deadline only, with
 * co-located graph neighbors (source law + agency Contracts/Rules/Meetings).
 *
 * Product term: mandates. Upstream extract vocabulary is not user-facing.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { agencyObligationsFollowHref } from "./agency_obligations.mjs";
import {
  mandateMatterEdgeFromRow,
  mandateReportsSectionTitle,
  mandateReportsStatusParts,
  normalizeMandateGraphNeighbors,
  renderMandateRowGraphActions,
  renderMandateSectionNeighborActions,
} from "./mandate_graph_neighbors.mjs";
import { OBSERVATION_LABELS, OBSERVATION_STATUS } from "./process_conformance.mjs";

export const MANDATE_REPORTS_RECEIPT_SCHEMA = "cityscroll.mandate_reports_receipt.v1";
export const MANDATE_REPORTS_RECEIPT_METHOD = "mandate_report_filing_receipt_v1";
export const MANDATE_REPORTS_RECEIPT_ITERATION = "v1";

/** Reader lead — plain connection, no hedging. */
export const MANDATE_REPORTS_RECEIPT_COPY = Object.freeze({
  lead:
    "Statutory duties that require this agency to publish or file a report, with a City Record filing receipt when that report appears.",
});

/** Reader label for a matched filing receipt (standable observation only). */
export const FILING_RECEIPT_LABEL = "Filing receipt";

const REPORT_DELIVERABLES = new Set(["report", "required-report", "required_report"]);

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

export function isReportDeliverable(deliverableType) {
  return REPORT_DELIVERABLES.has(clean(deliverableType, 40).toLowerCase());
}

/** Shareable constellation anchor for the Required Reports receipt card. */
export function agencyMandateReportsPath(agencyIdOrName) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return "/agencies/";
  return `/agencies/${encodeURIComponent(identity.canonical_id)}/#mandates-reports`;
}

/**
 * Build the Mandates → Required Reports receipt view for one agency.
 *
 * @param {string} agencyIdOrName
 * @param {{
 *   obligationsLookup?: object,
 *   conformanceItems?: object[],
 *   rulesBrowseHref?: string,
 *   meetingsBrowseHref?: string,
 *   contractsBrowseHref?: string,
 *   graphNeighbors?: object,
 *   limit?: number,
 * }} sources
 */
export function buildMandateReportsReceiptView(agencyIdOrName, sources = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return null;

  const bucket = sources.obligationsLookup?.by_agency?.[identity.canonical_id] || null;
  const allMandates = Array.isArray(bucket?.obligations) ? bucket.obligations : [];
  const reportRows = allMandates.filter((row) => isReportDeliverable(row?.deliverable_type));

  const confById = new Map();
  for (const item of sources.conformanceItems || []) {
    const mid = item?.mandate_id || item?.obligation_id;
    if (mid) confById.set(mid, item);
  }

  const graphNeighbors = normalizeMandateGraphNeighbors({
    rules_browse_href: sources.rulesBrowseHref || sources.graphNeighbors?.rules_browse_href,
    meetings_browse_href: sources.meetingsBrowseHref
      || sources.graphNeighbors?.meetings_browse_href,
    contracts_browse_href: sources.contractsBrowseHref
      || sources.graphNeighbors?.contracts_browse_href,
  });

  const limit = Math.max(1, Math.min(Number(sources.limit) || 12, 40));
  // Prefer rows that already have a filing receipt so demos scan the matched ones first.
  const ranked = [...reportRows].sort((left, right) => {
    const leftObs = confById.get(left.obligation_id)?.observation;
    const rightObs = confById.get(right.obligation_id)?.observation;
    const leftHit = leftObs?.status === OBSERVATION_STATUS.OBSERVED && leftObs?.observed_record ? 0 : 1;
    const rightHit = rightObs?.status === OBSERVATION_STATUS.OBSERVED && rightObs?.observed_record ? 0 : 1;
    if (leftHit !== rightHit) return leftHit - rightHit;
    const leftDate = left.deadline?.computed_date || "9999";
    const rightDate = right.deadline?.computed_date || "9999";
    return String(leftDate).localeCompare(String(rightDate));
  });

  const mandates = ranked.slice(0, limit).map((row) => {
    const conf = confById.get(row.obligation_id) || null;
    const obs = conf?.observation || null;
    const receipt = obs?.status === OBSERVATION_STATUS.OBSERVED && obs?.observed_record
      ? {
        request_id: clean(obs.observed_record.request_id, 40) || null,
        label: clean(obs.observed_record.label, 240) || null,
        when: clean(obs.observed_record.when, 40) || null,
        href: clean(obs.observed_record.href, 240)
          || (obs.observed_record.request_id
            ? `#notice/${encodeURIComponent(obs.observed_record.request_id)}`
            : null),
        signal_kind: clean(obs.observed_record.signal_kind, 40) || "report_or_study",
      }
      : null;
    const matter = mandateMatterEdgeFromRow(row);
    return {
      mandate_id: row.obligation_id,
      duty_text: clean(row.duty_text, 500),
      deliverable_type: "report",
      citation: clean(row.citation, 200) || null,
      deadline_date: clean(row.deadline?.computed_date, 20) || null,
      deadline_text: clean(row.deadline?.text || row.deadline_text, 240) || null,
      recurrence: clean(row.recurrence, 40) || null,
      matter_id: matter?.matter_id || null,
      source_href: matter?.href || null,
      source_law_relation: matter ? "source_law" : null,
      // Only surface standable observed status on the public card — no "expected not yet" chips.
      observation_status: receipt ? OBSERVATION_STATUS.OBSERVED : null,
      observation_label: receipt
        ? (OBSERVATION_LABELS[OBSERVATION_STATUS.OBSERVED] || "Observed in City Record")
        : null,
      filing_receipt: receipt,
      // Alias kept for callers that already read observed_record on mandate bridges.
      observed_record: receipt,
    };
  });

  const mandateTotal = reportRows.length;
  const receiptCount = mandates.filter((m) => m.filing_receipt).length;

  if (!mandateTotal) {
    return {
      schema: MANDATE_REPORTS_RECEIPT_SCHEMA,
      method: MANDATE_REPORTS_RECEIPT_METHOD,
      iteration: MANDATE_REPORTS_RECEIPT_ITERATION,
      status: "empty",
      agency_id: identity.canonical_id,
      agency_name: identity.canonical_name,
      subject_ref: `agency:id:${identity.canonical_id}`,
      counts: {
        report_mandates: 0,
        filing_receipts: 0,
      },
      mandates: [],
      copy: MANDATE_REPORTS_RECEIPT_COPY,
      share_path: agencyMandateReportsPath(identity.canonical_id),
      report_mandates_follow_href: agencyObligationsFollowHref(identity.canonical_id, {
        deliverableType: "report",
      }),
      graph_neighbors: graphNeighbors,
      section_title: mandateReportsSectionTitle({ filing_receipts: 0 }),
    };
  }

  const counts = {
    report_mandates: mandateTotal,
    filing_receipts: receiptCount,
  };
  return {
    schema: MANDATE_REPORTS_RECEIPT_SCHEMA,
    method: MANDATE_REPORTS_RECEIPT_METHOD,
    iteration: MANDATE_REPORTS_RECEIPT_ITERATION,
    status: "matched",
    agency_id: identity.canonical_id,
    agency_name: identity.canonical_name,
    subject_ref: `agency:id:${identity.canonical_id}`,
    counts,
    mandates,
    copy: MANDATE_REPORTS_RECEIPT_COPY,
    share_path: agencyMandateReportsPath(identity.canonical_id),
    report_mandates_follow_href: agencyObligationsFollowHref(identity.canonical_id, {
      deliverableType: "report",
    }),
    graph_neighbors: graphNeighbors,
    section_title: mandateReportsSectionTitle(counts),
  };
}

/**
 * Compact HTML for constellation embedding (#mandates-reports).
 * Omits entirely when empty — no absence disclaimers.
 * Unmatched mandates list duty + deadline only (no "not yet filed" copy).
 */
export function renderMandateReportsReceiptSection(view) {
  if (!view || view.status !== "matched") return "";
  const counts = view.counts || {};
  const statusLine = mandateReportsStatusParts(counts).join(" · ");
  const sectionTitle = view.section_title || mandateReportsSectionTitle(counts);
  const graphNeighbors = normalizeMandateGraphNeighbors(view.graph_neighbors || {
    rules_browse_href: view.rules_browse_href,
    meetings_browse_href: view.meetings_browse_href,
    contracts_browse_href: view.contracts_browse_href,
  });

  const mandateList = (view.mandates || []).length
    ? `<ul class="node-record-list mandate-reports-mandates" data-bridge-side="report-mandates">${
      view.mandates.map((item) => {
        const meta = [
          "report",
          item.deadline_date
            ? `deadline ${item.deadline_date}`
            : (item.deadline_text ? `deadline: ${item.deadline_text}` : null),
          item.recurrence,
          item.citation,
        ].filter(Boolean).map(esc).join(" · ");
        const receipt = item.filing_receipt || item.observed_record || null;
        const receiptLine = receipt?.href
          ? ` · ${constellationLink({ href: receipt.href, label: `${FILING_RECEIPT_LABEL}: ${receipt.label || receipt.request_id}`, className: "mandate-filing-receipt-link agency-edge-link", attributes: { "data-filing-receipt": "1" }, escape: esc })}${receipt.when ? ` <span class="muted">(${esc(receipt.when)})</span>` : ""}`
          : "";
        // Per-row: Source law only. Filing receipt is linked above when present.
        // Agency-wide browse chips stay in section chrome — never on every card.
        const neighbors = renderMandateRowGraphActions({
          source_href: item.source_href,
          matter_id: item.matter_id,
          prefer: "contracts",
          escape: esc,
        });
        const chip = receipt
          ? `<span class="mandate-obs-chip mandate-obs-observed mandate-filing-receipt-chip" data-observation-status="${esc(OBSERVATION_STATUS.OBSERVED)}" data-filing-receipt="1">${esc(FILING_RECEIPT_LABEL)}</span>`
          : "";
        return `<li class="node-record mandate-reports-mandate" data-mandate-id="${esc(item.mandate_id)}" data-deliverable-type="report"${item.matter_id ? ` data-matter-id="${esc(item.matter_id)}"` : ""}${receipt ? ` data-observation-status="${esc(OBSERVATION_STATUS.OBSERVED)}" data-has-filing-receipt="1"` : ""}>
          <div class="node-record-main">${chip}${esc(item.duty_text)}</div>
          <span class="muted node-muted">${meta}${receiptLine}${neighbors}</span>
        </li>`;
      }).join("")
    }</ul>`
    : "";

  const neighborChrome = renderMandateSectionNeighborActions({
    graph_neighbors: graphNeighbors,
    escape: esc,
  });
  const actions = [
    neighborChrome,
    view.report_mandates_follow_href
      ? `<a class="node-action civic-object-action" href="${esc(view.report_mandates_follow_href)}">Watch report mandates</a>`
      : "",
    view.share_path
      ? `<a class="node-action civic-object-action" href="${esc(view.share_path)}">Share this view</a>`
      : "",
  ].filter(Boolean).join("");

  const copy = view.copy || MANDATE_REPORTS_RECEIPT_COPY;
  return `<section id="mandates-reports" class="node-section node-card civic-object-section mandate-reports-receipt" data-agency-constellation-card="mandates-reports" data-method="${esc(view.method || MANDATE_REPORTS_RECEIPT_METHOD)}" data-status="${esc(view.status)}" data-export-class="object_members"${(counts.filing_receipts || 0) === 0 ? ' data-mandate-edges="co-located-only"' : ""}>
    <h2>${esc(sectionTitle)} <span class="muted node-muted">(${esc(statusLine || "linked")})</span></h2>
    <p class="node-muted muted">${esc(copy.lead || MANDATE_REPORTS_RECEIPT_COPY.lead)}</p>
    ${mandateList}
    ${actions ? `<p class="node-inline-actions civic-object-inline-actions">${actions}</p>` : ""}
  </section>`;
}

/** Minimal CSS for receipt chips on the card. */
export const MANDATE_REPORTS_RECEIPT_STYLE = `
.mandate-reports-receipt .mandate-obs-chip {
  display: inline-block;
  margin-inline-end: 0.5rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  border: 1px solid var(--color-border, #c8c8c8);
  font: 600 0.75rem/1.3 var(--font-body, system-ui, sans-serif);
  letter-spacing: 0.01em;
  vertical-align: 0.05em;
  white-space: nowrap;
  background: color-mix(in srgb, var(--color-action, #0b57d0) 12%, transparent);
  border-color: color-mix(in srgb, var(--color-action, #0b57d0) 35%, var(--color-border, #c8c8c8));
}
.mandate-reports-receipt .mandate-filing-receipt-link {
  font-weight: 600;
}
`;
