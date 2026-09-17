/**
 * In-place search-result inspection with an explicit full-record destination.
 *
 * Progressive enhancement keeps three distinct meanings:
 *
 *   - the static title `<a>` is the canonical record until enhancement is ready
 *   - once bound, a title-sized inspect button opens a bounded modal summary
 *   - a separately named full-record `<a>` keeps native destination behaviour
 *
 * Collection continuation ("Continue in Contracts") stays outside this module
 * as an explicit handoff owned by `search_lens_handoff.mjs`. This module never
 * rewrites a result title into a collection route.
 */

import {
  AFFORDANCE_ACTION_ROLES,
  affordanceHandoffPresentation,
} from "./affordance_grammar.mjs";

export const SEARCH_RESULT_INSPECTION_SCHEMA = "cityscroll.search_result_inspection.v1";
export const SEARCH_RESULT_INSPECTION_VERSION = 1;
export const SEARCH_RESULT_INSPECTION_DIALOG_ID = "search-result-inspection";
export const SEARCH_RESULT_INSPECTION_TITLE_ID = "search-result-inspection-title";
export const SEARCH_RESULT_INSPECTION_ATTRIBUTE = "data-search-result-inspection";
export const SEARCH_RESULT_INSPECTION_READY_ATTRIBUTE = "data-search-result-inspection-ready";
export const SEARCH_RESULT_TITLE_LINK_CLASS = "topic-search-result-title-link";
export const SEARCH_RESULT_INSPECT_CLASS = "topic-search-result-inspect";
export const SEARCH_RESULT_FULL_RECORD_CLASS = "topic-search-result-full-record";

const INSPECT_CLOSE_LABEL = "Close";
const INSPECT_KICKER = "Search result";
const FULL_RECORD_LABEL = "Open the full record";
const DETAIL_FAILURE_STATUS = "Further detail did not load. The full record link below is unaffected.";

function inspectText(value, max = 2_000) {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  return result ? result.slice(0, max) : null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeFor(options = {}) {
  return typeof options.escape === "function" ? options.escape : escapeHtml;
}

function resultUid(record = {}, view = null) {
  return inspectText(record.object_ref, 320)
    || inspectText(view?.href || record.source_route || record.canonical_href, 600)
    || null;
}

function sourceObservationRef(record = {}, view = null) {
  const fromView = view?.edge_provenance?.source_observation_ref;
  if (fromView) return inspectText(fromView, 240);
  const refs = Array.isArray(record.source_observation_refs) ? record.source_observation_refs : [];
  for (const ref of refs) {
    const cleaned = inspectText(ref, 240);
    if (cleaned) return cleaned;
  }
  return null;
}

/**
 * Immutable inspection facts from an already-built relevance view plus the
 * source record's identity fields. Callers that own `buildUniversalSearchResultView`
 * pass that view in so this module does not import the renderer.
 */
export function searchResultInspectionFacts(record = {}, view = null) {
  if (!view?.href || !view?.title) return null;
  const uid = resultUid(record, view);
  if (!uid) return null;
  const lifecycleState = inspectText(view.lifecycle?.state, 40) || "unknown";
  const lifecycle = Object.freeze({
    state: lifecycleState,
    // Keep unknown statuses unlabeled so resident markup does not invent a chip
    // or leak "Status not available" into progressive-enhancement payloads.
    label: lifecycleState === "unknown"
      ? null
      : (inspectText(view.lifecycle?.label, 80) || null),
    group: inspectText(view.lifecycle?.group, 40) || "other",
  });
  return Object.freeze({
    schema: SEARCH_RESULT_INSPECTION_SCHEMA,
    version: SEARCH_RESULT_INSPECTION_VERSION,
    uid,
    title: view.title,
    href: view.href,
    summary: view.summary || null,
    entity_type: view.entity_type,
    entity_type_label: view.entity_type_label,
    lens: view.lens,
    lens_label: view.lens_label,
    lifecycle,
    evidence: view.evidence,
    object_ref: inspectText(record.object_ref, 320),
    source_observation_ref: sourceObservationRef(record, view),
  });
}

export function serializeSearchResultInspection(facts) {
  return facts ? JSON.stringify(facts) : "";
}

export function parseSearchResultInspection(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || parsed.schema !== SEARCH_RESULT_INSPECTION_SCHEMA) return null;
    if (!inspectText(parsed.uid, 320) || !inspectText(parsed.href, 600) || !inspectText(parsed.title, 500)) {
      return null;
    }
    return Object.freeze({
      schema: SEARCH_RESULT_INSPECTION_SCHEMA,
      version: Number(parsed.version) || SEARCH_RESULT_INSPECTION_VERSION,
      uid: inspectText(parsed.uid, 320),
      title: inspectText(parsed.title, 500),
      href: inspectText(parsed.href, 600),
      summary: inspectText(parsed.summary, 1_200),
      entity_type: inspectText(parsed.entity_type, 80) || "unclassified",
      entity_type_label: inspectText(parsed.entity_type_label, 80) || "Published record",
      lens: inspectText(parsed.lens, 80) || "notices",
      lens_label: inspectText(parsed.lens_label, 80) || "Published records",
      lifecycle: Object.freeze({
        state: inspectText(parsed.lifecycle?.state, 40) || "unknown",
        label: inspectText(parsed.lifecycle?.label, 80),
        group: inspectText(parsed.lifecycle?.group, 40) || "other",
      }),
      evidence: Object.freeze({
        field: inspectText(parsed.evidence?.field, 80) || "record text",
        reason: inspectText(parsed.evidence?.reason, 120) || "Keyword evidence unavailable",
        value: inspectText(parsed.evidence?.value, 2_000) || "",
      }),
      object_ref: inspectText(parsed.object_ref, 320),
      source_observation_ref: inspectText(parsed.source_observation_ref, 240),
    });
  } catch {
    return null;
  }
}

export function searchResultFullRecordLabel() {
  return FULL_RECORD_LABEL;
}

export function renderSearchResultInspectButton(facts, options = {}) {
  if (!facts) return "";
  const esc = escapeFor(options);
  const label = `Inspect: ${facts.title}`;
  const payload = esc(serializeSearchResultInspection(facts));
  const inner = typeof options.innerHTML === "string" ? options.innerHTML : esc(facts.title);
  return `<button class="${SEARCH_RESULT_INSPECT_CLASS}" type="button"` +
    ` ${SEARCH_RESULT_INSPECTION_ATTRIBUTE}="${payload}"` +
    ` data-search-result-inspection-uid="${esc(facts.uid)}"` +
    ` aria-label="${esc(label)}">${inner}</button>`;
}

export function renderSearchResultFullRecordLink(facts, options = {}) {
  if (!facts) return "";
  const esc = escapeFor(options);
  const openPresentation = affordanceHandoffPresentation({ href: facts.href, escape: esc });
  return `<a class="${SEARCH_RESULT_FULL_RECORD_CLASS}" href="${esc(facts.href)}"` +
    ` data-browse-return-uid="${esc(facts.uid)}"` +
    `${openPresentation.attributes}>${esc(FULL_RECORD_LABEL)}` +
    `${openPresentation.glyph}${openPresentation.announcement}</a>`;
}

function definitionRow(term, value, esc) {
  return `<div class="search-result-inspection-row"><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`;
}

export function renderSearchResultInspectionBody(facts, options = {}) {
  if (!facts) return "";
  const esc = escapeFor(options);
  const rows = [
    definitionRow("Type", facts.entity_type_label, esc),
    definitionRow("Family", facts.lens_label, esc),
    facts.lifecycle?.state && facts.lifecycle.state !== "unknown"
      ? definitionRow("Status", facts.lifecycle.label, esc)
      : "",
    facts.object_ref ? definitionRow("Record identity", facts.object_ref, esc) : "",
    facts.source_observation_ref
      ? definitionRow("Source observation", facts.source_observation_ref, esc)
      : "",
    facts.evidence?.reason
      ? definitionRow("Why it matched", `${facts.evidence.reason}${facts.evidence.value ? `: ${facts.evidence.value}` : ""}`, esc)
      : "",
  ].filter(Boolean).join("");
  const summary = facts.summary
    ? `<p class="search-result-inspection-summary">${esc(facts.summary)}</p>`
    : "";
  const detail = inspectText(options.detail);
  const detailHTML = detail
    ? `<p class="search-result-inspection-detail">${esc(detail)}</p>`
    : "";
  const detailStatus = inspectText(options.detailStatus);
  const detailStatusHTML = detailStatus
    ? `<p class="search-result-inspection-detail-status">${esc(detailStatus)}</p>`
    : "";
  const openPresentation = affordanceHandoffPresentation({ href: facts.href, escape: esc });
  const actionLabel = openPresentation.role === AFFORDANCE_ACTION_ROLES.handoff
    ? "Open the published record"
    : FULL_RECORD_LABEL;
  return `<p class="search-result-inspection-kicker">${esc(INSPECT_KICKER)}</p>` +
    `<h2 class="search-result-inspection-title" id="${esc(SEARCH_RESULT_INSPECTION_TITLE_ID)}">${esc(facts.title)}</h2>` +
    summary +
    `<dl class="search-result-inspection-facts">${rows}</dl>` +
    detailHTML +
    detailStatusHTML +
    `<p class="search-result-inspection-actions">` +
    `<a class="search-result-inspection-open" data-search-result-inspection-open href="${esc(facts.href)}"` +
    ` data-browse-return-uid="${esc(facts.uid)}"` +
    `${openPresentation.attributes}>${esc(actionLabel)}` +
    `${openPresentation.glyph}${openPresentation.announcement}</a>` +
    "</p>";
}

const INSPECT_FOCUSABLE = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";
const boundInspectionRoots = new WeakSet();
const DIALOG_OWNER_ATTRIBUTE = "data-search-result-inspection-owner";
let inspectionBindingSequence = 0;

function ownerDocument(root) {
  if (!root) return typeof document === "undefined" ? null : document;
  if (typeof root.querySelectorAll !== "function") return null;
  return root.ownerDocument || (root.nodeType === 9 ? root : null);
}

function ensureDialog(doc) {
  const existing = doc.getElementById(SEARCH_RESULT_INSPECTION_DIALOG_ID);
  if (existing) return existing;
  const dialog = doc.createElement("dialog");
  dialog.id = SEARCH_RESULT_INSPECTION_DIALOG_ID;
  dialog.className = "search-result-inspection-dialog";
  doc.body.appendChild(dialog);
  return dialog;
}

function focusableIn(dialog) {
  return [...dialog.querySelectorAll(INSPECT_FOCUSABLE)].filter((node) => !node.hasAttribute("hidden"));
}

function triggerForUid(doc, uid) {
  for (const node of doc.querySelectorAll("[data-search-result-inspection-uid]")) {
    if (node.getAttribute("data-search-result-inspection-uid") === uid) return node;
  }
  return null;
}

function returnFocus(doc, invoker, uid, root) {
  if (invoker && invoker.isConnected && typeof invoker.focus === "function") {
    invoker.focus();
    return invoker;
  }
  const replacement = uid ? triggerForUid(doc, uid) : null;
  if (replacement && typeof replacement.focus === "function") {
    replacement.focus();
    return replacement;
  }
  const survivor = root && root.isConnected
    ? root.querySelector("[data-search-document], .topic-search-results, main") || root
    : null;
  if (survivor && typeof survivor.focus === "function") {
    if (!survivor.hasAttribute("tabindex")) survivor.setAttribute("tabindex", "-1");
    survivor.focus();
    return survivor;
  }
  return null;
}

/**
 * Mount search-result inspection on one container. Idempotent and delegated so
 * a repaint of result cards does not require a second bind.
 */
export function bindSearchResultInspection(root, options = {}) {
  const doc = ownerDocument(root);
  if (!doc || typeof doc.createElement !== "function" || !doc.body) return null;
  const scope = root && typeof root.querySelectorAll === "function" ? root : doc;
  if (boundInspectionRoots.has(scope)) return null;
  boundInspectionRoots.add(scope);

  const dialog = ensureDialog(doc);
  inspectionBindingSequence += 1;
  const bindingId = String(inspectionBindingSequence);
  let openToken = 0;
  let invoker = null;
  let openUid = null;

  const setBody = (facts, extra) => {
    dialog.innerHTML = `<div class="search-result-inspection-inner">` +
      `<button class="search-result-inspection-close" type="button" data-search-result-inspection-close>${INSPECT_CLOSE_LABEL}</button>` +
      renderSearchResultInspectionBody(facts, extra) +
      "</div>";
    dialog.setAttribute("aria-labelledby", SEARCH_RESULT_INSPECTION_TITLE_ID);
  };

  const close = () => {
    if (!dialog.open) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };

  const open = (facts, control) => {
    if (!facts) return null;
    openToken += 1;
    const sequence = openToken;
    invoker = control || null;
    openUid = facts.uid;
    dialog.setAttribute(DIALOG_OWNER_ATTRIBUTE, bindingId);
    dialog.setAttribute("data-browse-return-uid", facts.uid);
    setBody(facts);
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else {
        dialog.setAttribute("open", "");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
      }
    }
    const first = dialog.querySelector("[data-search-result-inspection-close]");
    if (first && typeof first.focus === "function") first.focus();
    if (typeof options.loadDetail === "function") {
      Promise.resolve()
        .then(() => options.loadDetail(facts))
        .then((detail) => {
          if (sequence !== openToken || !dialog.open) return;
          const text = inspectText(typeof detail === "string" ? detail : detail?.summary);
          if (text) setBody(facts, { detail: text });
        })
        .catch(() => {
          if (sequence !== openToken || !dialog.open) return;
          setBody(facts, { detailStatus: DETAIL_FAILURE_STATUS });
        });
    }
    return dialog;
  };

  const onClick = (event) => {
    const closeControl = event.target.closest?.("[data-search-result-inspection-close]");
    if (closeControl) {
      event.preventDefault();
      close();
      return;
    }
    const control = event.target.closest?.(`[${SEARCH_RESULT_INSPECTION_ATTRIBUTE}]`);
    if (!control) return;
    if (event.searchResultInspectionHandled) return;
    event.searchResultInspectionHandled = true;
    open(parseSearchResultInspection(control.getAttribute(SEARCH_RESULT_INSPECTION_ATTRIBUTE)), control);
  };

  const onKeydown = (event) => {
    if (!dialog.open) return;
    if (event.key === "Escape" && typeof dialog.showModal !== "function") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableIn(dialog);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = doc.activeElement;
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    }
  };

  const onClose = () => {
    if (dialog.getAttribute(DIALOG_OWNER_ATTRIBUTE) !== bindingId) return;
    returnFocus(doc, invoker, openUid, scope);
    dialog.removeAttribute(DIALOG_OWNER_ATTRIBUTE);
    invoker = null;
    openUid = null;
  };

  scope.addEventListener("click", onClick);
  if (typeof scope.contains !== "function" || !scope.contains(dialog)) dialog.addEventListener("click", onClick);
  dialog.addEventListener("keydown", onKeydown);
  dialog.addEventListener("close", onClose);

  if (typeof scope.setAttribute === "function") scope.setAttribute(SEARCH_RESULT_INSPECTION_READY_ATTRIBUTE, "");
  else if (doc.documentElement) doc.documentElement.setAttribute(SEARCH_RESULT_INSPECTION_READY_ATTRIBUTE, "");

  return {
    open,
    close,
    destroy() {
      scope.removeEventListener("click", onClick);
      dialog.removeEventListener("click", onClick);
      dialog.innerHTML = "";
      dialog.removeEventListener("keydown", onKeydown);
      dialog.removeEventListener("close", onClose);
      boundInspectionRoots.delete(scope);
    },
  };
}
