/**
 * Shared Contracts result inspection for notice-backed and source-native rows.
 *
 * Progressive enhancement keeps three distinct meanings:
 *
 *   - the static title `<a>` is the canonical full record until enhancement is ready
 *   - once bound, a title-sized inspect button selects the shared `#detail` host
 *   - a separately named full-record `<a>` keeps native destination behaviour
 *
 * Kinetic actions (Respond / award guide) stay on the object-card action rail.
 * This module never fabricates notice joins for procurement-only rows and never
 * uses trusted-click navigation as the primary inspect path.
 */

import {
  AFFORDANCE_ACTION_ROLES,
  affordanceHandoffPresentation,
  objectCardInteractionProjection,
  renderObjectCardActionRail,
  renderObjectCardCopy,
} from "./affordance_grammar.mjs";
import { noticeDisplayTitle } from "./display_title.mjs";

export const CONTRACT_RESULT_INSPECTION_SCHEMA = "cityscroll.contract_result_inspection.v1";
export const CONTRACT_RESULT_INSPECTION_VERSION = 1;
export const CONTRACT_RESULT_READY_ATTRIBUTE = "data-contract-result-inspect-ready";
export const CONTRACT_RESULT_INSPECT_ATTRIBUTE = "data-contract-result-inspect";
export const CONTRACT_RESULT_TITLE_LINK_CLASS = "money-row-title-link";
export const CONTRACT_RESULT_INSPECT_CLASS = "money-row-inspect";
export const CONTRACT_RESULT_FULL_RECORD_CLASS = "money-row-full-record";
export const CONTRACT_RESULT_DETAIL_CLASS = "contract-result-inspection-detail";
export const CONTRACT_RESULT_OVERVIEW_CLASS = "contract-result-inspection-overview";

const CONTRACT_RESULT_FULL_RECORD_LABEL = "Open the full record";
const CONTRACT_RESULT_DETAIL_FAILURE_STATUS = "Further detail did not load. The full record link below is unaffected.";
const CONTRACT_RESULT_DETAIL_KICKER = "Contract overview";

function contractResultCleanText(value, max = 2_000) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function contractResultCleanId(value, max = 320) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function contractResultEscapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function contractResultEscapeFor(options = {}) {
  return typeof options.escape === "function" ? options.escape : contractResultEscapeHtml;
}

function contractResultNoticeHref(requestId) {
  const id = contractResultCleanId(requestId, 100);
  return id ? `/notices/${encodeURIComponent(id)}` : null;
}

/**
 * Grounded full-record destination for one Contracts row.
 * Prefers an explicit analytical inspect handoff, then a procurement canonical
 * href, then the notice document. Absence stays null rather than inventing a path.
 */
export function contractResultFullRecordHref(row = {}) {
  return contractResultCleanText(row.inspect_href, 600)
    || contractResultCleanText(row.canonical_href, 600)
    || contractResultNoticeHref(row.request_id);
}

/**
 * Stable uid used by inspect controls and return-context anchors.
 */
export function contractResultInspectionUid(row = {}) {
  return contractResultCleanId(row.procurement_id, 320)
    || contractResultCleanId(row.request_id, 100)
    || contractResultCleanId(row.id, 160)
    || contractResultCleanId(row.contract_id, 160)
    || contractResultCleanId(row.canonical_href, 600)
    || contractResultCleanId(row.inspect_href, 600)
    || null;
}

function contractResultSourceObservationRef(row = {}) {
  const refs = Array.isArray(row.source_observation_refs) ? row.source_observation_refs : [];
  for (const ref of refs) {
    const cleaned = contractResultCleanText(ref, 240);
    if (cleaned) return cleaned;
  }
  const requestId = contractResultCleanId(row.request_id, 100);
  return requestId ? `notice:${requestId}` : null;
}

function lifecycleLabel(row = {}) {
  const typed = contractResultCleanText(row.type_of_notice_description, 120);
  if (typed) return typed;
  const stage = contractResultCleanText(row.primary_stage, 80)
    || (Array.isArray(row.procurement_stages) ? contractResultCleanText(row.procurement_stages[0], 80) : null);
  return stage;
}

/**
 * Source-honest inspection facts for notice-backed and source-native rows.
 * Notice request ids and procurement identities stay distinct when both exist.
 */
export function projectContractResultInspection(row = {}) {
  const href = contractResultFullRecordHref(row);
  const title = contractResultCleanText(noticeDisplayTitle(row), 500);
  const uid = contractResultInspectionUid(row);
  if (!href || !title || !uid) return null;
  const requestId = contractResultCleanId(row.request_id, 100);
  const procurementId = contractResultCleanId(row.procurement_id, 320);
  const pin = contractResultCleanId(row.pin, 160);
  const contractId = contractResultCleanId(row.contract_id, 160);
  const agency = contractResultCleanText(row.agency_name, 240);
  const vendor = contractResultCleanText(row.vendor_name, 240);
  const summary = contractResultCleanText(row.additional_description_1, 1_200);
  const amount = row.contract_amount == null || row.contract_amount === ""
    ? null
    : Number(row.contract_amount);
  const due = contractResultCleanText(String(row.due_date || "").slice(0, 10), 40);
  const start = contractResultCleanText(String(row.start_date || "").slice(0, 10), 40);
  const method = contractResultCleanText(row.selection_method_description, 240);
  const category = contractResultCleanText(row.category_description, 240);
  const sourceSystem = contractResultCleanText(row.source_system, 120);
  const observation = contractResultSourceObservationRef(row);
  const shape = row.inspect_href
    ? "analytical"
    : (procurementId && !requestId ? "source_native" : (requestId ? "notice_backed" : "source_native"));
  return Object.freeze({
    schema: CONTRACT_RESULT_INSPECTION_SCHEMA,
    version: CONTRACT_RESULT_INSPECTION_VERSION,
    uid,
    title,
    href,
    shape,
    agency,
    vendor,
    summary,
    lifecycle: lifecycleLabel(row),
    method,
    category,
    due_date: due,
    start_date: start,
    amount: Number.isFinite(amount) ? amount : null,
    pin,
    contract_id: contractId,
    procurement_id: procurementId,
    request_id: requestId,
    source_observation_ref: observation
      && observation !== procurementId
      && observation !== (requestId ? `notice:${requestId}` : null)
      ? observation
      : null,
    source_system: sourceSystem,
    inspect_href: contractResultCleanText(row.inspect_href, 600),
  });
}

/**
 * Object-card interaction projection used for Copy and kinetic Respond/award
 * actions. The title destination remains the grounded full-record href so
 * no-JS and Copy stay coherent; enhanced markup replaces the title with an
 * inspect control separately.
 */
export function contractResultInteractionProjection(row = {}, options = {}) {
  const href = contractResultFullRecordHref(row);
  const title = contractResultCleanText(noticeDisplayTitle(row), 500);
  const presentation = typeof options.primaryAction === "function"
    ? options.primaryAction(row, options.today)
    : options.primaryAction || null;
  const kineticActions = presentation ? [{
    label: presentation.label
      || (typeof options.translate === "function" ? options.translate(presentation.label_key) : presentation.label_key),
    href: presentation.href,
    kind: presentation.action?.type,
    context_ready: true,
    primary: true,
  }] : [];
  return objectCardInteractionProjection({
    target: (href && title) ? { href, label: title } : null,
    kinetic_actions: kineticActions,
  });
}

export function contractResultFullRecordLabel() {
  return CONTRACT_RESULT_FULL_RECORD_LABEL;
}

export function contractResultDetailFailureStatus() {
  return CONTRACT_RESULT_DETAIL_FAILURE_STATUS;
}

export function renderContractResultFullRecordLink(facts, options = {}) {
  if (!facts?.href) return "";
  const esc = contractResultEscapeFor(options);
  const openPresentation = affordanceHandoffPresentation({ href: facts.href, escape: esc });
  const label = options.label || CONTRACT_RESULT_FULL_RECORD_LABEL;
  return `<a class="${CONTRACT_RESULT_FULL_RECORD_CLASS}" href="${esc(facts.href)}"` +
    ` data-browse-return-uid="${esc(facts.uid)}"` +
    `${openPresentation.attributes}>${esc(label)}` +
    `${openPresentation.glyph}${openPresentation.announcement}</a>`;
}

/**
 * Title cluster: static canonical link (no-JS / failed enhancement) beside a
 * title-sized inspect button revealed only after the binder marks ready.
 */
export function renderContractResultTitleClusterHTML(facts, options = {}) {
  if (!facts) return "";
  const esc = contractResultEscapeFor(options);
  const inner = typeof options.titleMarkup === "string" ? options.titleMarkup : esc(facts.title);
  const inspectLabel = `Inspect: ${facts.title}`;
  return `<div class="money-row-title-cluster">` +
    `<a class="${CONTRACT_RESULT_TITLE_LINK_CLASS} rtitle" href="${esc(facts.href)}" lang="en" dir="ltr">${inner}</a>` +
    `<button type="button" class="${CONTRACT_RESULT_INSPECT_CLASS} rtitle"` +
    ` ${CONTRACT_RESULT_INSPECT_ATTRIBUTE}="${esc(facts.uid)}"` +
    ` aria-label="${esc(inspectLabel)}" lang="en" dir="ltr">${inner}</button>` +
    `</div>`;
}

function contractResultDefinitionRow(term, value, esc) {
  if (!value) return "";
  return `<div class="contract-result-inspection-row"><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`;
}

function contractResultFormatAmount(amount) {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(Number(amount));
  } catch {
    return String(amount);
  }
}

/**
 * Overview facts shared by the collection detail host for source-native and
 * analytical rows (and as a failed-detail shell for notice-backed rows).
 */
export function renderContractResultInspectionOverviewHTML(facts, options = {}) {
  if (!facts) return "";
  const esc = contractResultEscapeFor(options);
  const rows = [
    contractResultDefinitionRow("Agency", facts.agency, esc),
    contractResultDefinitionRow("Vendor", facts.vendor, esc),
    contractResultDefinitionRow("Status", facts.lifecycle, esc),
    contractResultDefinitionRow("Method", facts.method, esc),
    contractResultDefinitionRow("Category", facts.category, esc),
    contractResultDefinitionRow("Due", facts.due_date, esc),
    contractResultDefinitionRow("Start", facts.start_date, esc),
    contractResultDefinitionRow("Amount", contractResultFormatAmount(facts.amount), esc),
    contractResultDefinitionRow("PIN", facts.pin, esc),
    contractResultDefinitionRow("Contract id", facts.contract_id, esc),
    contractResultDefinitionRow("Procurement identity", facts.procurement_id, esc),
    contractResultDefinitionRow("Notice", facts.request_id, esc),
    facts.source_observation_ref && facts.source_observation_ref !== `notice:${facts.request_id || ""}`
      ? contractResultDefinitionRow("Source observation", facts.source_observation_ref, esc)
      : (facts.source_observation_ref && !facts.request_id
        ? contractResultDefinitionRow("Source observation", facts.source_observation_ref, esc)
        : ""),
    contractResultDefinitionRow("Source", facts.source_system, esc),
  ].filter(Boolean).join("");
  const summary = facts.summary
    ? `<p class="contract-result-inspection-summary">${esc(facts.summary)}</p>`
    : "";
  if (!rows && !summary) return "";
  return `<dl class="${CONTRACT_RESULT_OVERVIEW_CLASS}" data-contract-result-overview="1">${rows}</dl>${summary}`;
}

/**
 * Shared `#detail` body for source-native / analytical inspection and for
 * failed optional enrichment. Always keeps the explicit full-record link.
 */
export function renderContractResultInspectionDetailHTML(facts, options = {}) {
  if (!facts) return "";
  const esc = contractResultEscapeFor(options);
  const overview = renderContractResultInspectionOverviewHTML(facts, { escape: esc });
  const statusText = options.failed
    ? (options.detailStatus || CONTRACT_RESULT_DETAIL_FAILURE_STATUS)
    : options.detailStatus;
  const status = statusText
    ? `<p class="contract-result-inspection-status" role="status">${esc(statusText)}</p>`
    : "";
  const fullRecord = renderContractResultFullRecordLink(facts, {
    escape: esc,
    label: options.fullRecordLabel || CONTRACT_RESULT_FULL_RECORD_LABEL,
  });
  return `<div class="${CONTRACT_RESULT_DETAIL_CLASS}" data-contract-result-detail="1"` +
    ` data-contract-result-uid="${esc(facts.uid)}"` +
    ` data-contract-result-shape="${esc(facts.shape)}">` +
    `<p class="contract-result-inspection-kicker">${esc(options.kicker || CONTRACT_RESULT_DETAIL_KICKER)}</p>` +
    `<h2 class="rolename" lang="en" dir="ltr">${esc(facts.title)}</h2>` +
    overview +
    status +
    `<p class="contract-result-inspection-actions">${fullRecord}</p>` +
    `</div>`;
}

/**
 * Row interaction chrome: inspect title cluster, Copy, named full-record link,
 * and optional kinetic Respond/award rail.
 */
export function renderContractResultInteractionsHTML(row = {}, options = {}) {
  const facts = projectContractResultInspection(row);
  if (!facts) return "";
  const esc = contractResultEscapeFor(options);
  const projection = contractResultInteractionProjection(row, {
    primaryAction: options.primaryAction,
    today: options.today,
    translate: options.translate,
  });
  const titleCluster = renderContractResultTitleClusterHTML(facts, {
    escape: esc,
    titleMarkup: options.titleMarkup,
  });
  const copy = renderObjectCardCopy(projection, {
    escape: esc,
    label: options.copyLabel || "Copy link",
  });
  const fullRecord = renderContractResultFullRecordLink(facts, { escape: esc });
  const rail = renderObjectCardActionRail(projection, {
    escape: esc,
    heading: options.actionHeading || "What can I do now?",
    newTabLabel: options.newTabLabel || "(opens in new tab)",
  });
  return `<div class="ui-object-card-interactions" data-contract-result-uid="${esc(facts.uid)}">` +
    `<div class="ui-object-card-primary">${titleCluster}${copy}</div>` +
    `<div class="ui-object-card-handoffs">${fullRecord}</div>` +
    `${rail}` +
    `</div>`;
}

/**
 * Whether the shared inspection detail host should paint this row instead of
 * the notice-oriented money-history renderer.
 */
export function contractResultUsesSharedDetail(row = {}) {
  if (!row || typeof row !== "object") return false;
  if (contractResultCleanText(row.inspect_href, 600)) return true;
  const requestId = contractResultCleanId(row.request_id, 100);
  if (requestId) return false;
  return Boolean(contractResultFullRecordHref(row));
}

/**
 * Progressive enhancement for Contracts rows: title-sized inspect selects the
 * shared detail host; failed enhancement leaves the static title link working.
 */
export function bindContractResultInspection(root, options = {}) {
  if (!root || typeof root.querySelectorAll !== "function") return null;
  if (root.getAttribute?.(CONTRACT_RESULT_READY_ATTRIBUTE) != null) {
    // Re-bind after list re-render: clear ready and continue.
    if (typeof root.removeAttribute === "function") root.removeAttribute(CONTRACT_RESULT_READY_ATTRIBUTE);
  }
  const doc = root.ownerDocument || (root.nodeType === 9 ? root : null);
  if (!doc) return null;
  const onInspect = typeof options.onInspect === "function" ? options.onInspect : null;

  const onClick = (event) => {
    const button = event.target.closest?.(`[${CONTRACT_RESULT_INSPECT_ATTRIBUTE}]`);
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    event.stopPropagation?.();
    const rowEl = button.closest?.(".row");
    if (!rowEl) return;
    const index = Number(rowEl.dataset?.i);
    if (!Number.isFinite(index)) return;
    if (onInspect) onInspect(index, rowEl, event);
  };

  const onKeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const button = event.target.closest?.(`[${CONTRACT_RESULT_INSPECT_ATTRIBUTE}]`);
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    const rowEl = button.closest?.(".row");
    if (!rowEl) return;
    const index = Number(rowEl.dataset?.i);
    if (!Number.isFinite(index)) return;
    if (onInspect) onInspect(index, rowEl, event);
  };

  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKeydown);
  if (typeof root.setAttribute === "function") root.setAttribute(CONTRACT_RESULT_READY_ATTRIBUTE, "");

  return {
    destroy() {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeydown);
      if (typeof root.removeAttribute === "function") root.removeAttribute(CONTRACT_RESULT_READY_ATTRIBUTE);
    },
  };
}

// Keep role vocabulary reachable for tests that assert inspect ≠ navigate.
export const CONTRACT_RESULT_INSPECT_ROLE = AFFORDANCE_ACTION_ROLES.inspect;
