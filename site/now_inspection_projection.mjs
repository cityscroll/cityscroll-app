/**
 * Shared Now inspection projection.
 *
 * Now cards and the Now calendar preview share one source-honest overview so
 * a resident can decide whether a deadline matters before leaving the list.
 * The projection reads already-published Now item fields (agency, identity,
 * type/category/method, optional summary, due-date precision). It never
 * invents missing summaries, times, or joins.
 *
 * Runtime and build-time card owners render the same overview facts. Calendar
 * hosts feed agency through the shared occurrence/preview facts and optional
 * summary text through the existing `loadDetail` contract.
 */

export const NOW_INSPECTION_PROJECTION_SCHEMA = "cityscroll.now_inspection_projection.v1";

export const NOW_CARD_READY_ATTRIBUTE = "data-now-card-inspect-ready";
export const NOW_CARD_INSPECT_ATTRIBUTE = "data-now-inspect";
export const NOW_CARD_TITLE_LINK_CLASS = "now-card-title-link";
export const NOW_CARD_INSPECT_CLASS = "now-card-inspect";
export const NOW_CARD_FULL_RECORD_CLASS = "now-card-full-record";
export const NOW_CARD_DETAIL_CLASS = "now-card-detail";
export const NOW_CARD_OVERVIEW_CLASS = "now-card-overview";

function cleanText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function cleanId(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

/**
 * Exact published identity for one Now item, when the source carried one.
 * Notice request ids and PINs stay distinct; absence is omitted rather than
 * filled with a placeholder.
 */
export function nowInspectionIdentity(item = {}) {
  const requestId = cleanId(item.request_id);
  const pin = cleanId(item.pin);
  const examNumber = cleanId(item.exam_number);
  const ruleId = cleanId(item.rule_id);
  if (!requestId && !pin && !examNumber && !ruleId) return null;
  return {
    ...(requestId ? { request_id: requestId } : {}),
    ...(pin ? { pin } : {}),
    ...(examNumber ? { exam_number: examNumber } : {}),
    ...(ruleId ? { rule_id: ruleId } : {}),
  };
}

/**
 * Distinguishing overview summary from available published fields.
 * A free-text `item.summary` wins when present. Otherwise type, category, and
 * selection method are joined when they exist. Missing optional fields never
 * create an empty summary string.
 */
export function composeNowOverviewSummary(item = {}) {
  const explicit = cleanText(item.summary);
  if (explicit) return explicit;
  const parts = [
    cleanText(item.notice_type),
    cleanText(item.category),
    cleanText(item.selection_method),
  ].filter(Boolean);
  if (!parts.length) return null;
  // Drop adjacent duplicates so "Solicitation · Solicitation" never appears.
  const unique = [];
  for (const part of parts) {
    if (!unique.length || unique[unique.length - 1].toLocaleLowerCase() !== part.toLocaleLowerCase()) {
      unique.push(part);
    }
  }
  return unique.join(" · ") || null;
}

/**
 * Due-date precision carried exactly as the Now item states it. Date-only and
 * timezone-free values stay date-only; this never invents a clock time or zone.
 */
export function nowInspectionDue(item = {}) {
  const time = item.time;
  if (!time?.value && !time?.day) return null;
  const precision = time.precision === "instant" ? "instant" : "day";
  return {
    value: time.value || null,
    day: time.day || null,
    precision,
    source_field: time.source_field || null,
    verified: time.verified !== false,
  };
}

/**
 * Project one Now item into the shared overview / inspection fact set used by
 * cards, calendar occurrences, and the optional preview detail loader.
 */
export function projectNowInspection(item = {}) {
  const id = cleanText(item.id);
  const title = cleanText(item.title);
  const route = cleanText(item.route);
  if (!id || !title || !route) return null;
  const agency = cleanText(item.agency);
  const identity = nowInspectionIdentity(item);
  const summary = composeNowOverviewSummary(item);
  const due = nowInspectionDue(item);
  const noticeType = cleanText(item.notice_type);
  const category = cleanText(item.category);
  const selectionMethod = cleanText(item.selection_method);
  const lifecycle = item.cancelled ? "cancelled" : cleanText(item.lifecycle);
  return {
    schema: NOW_INSPECTION_PROJECTION_SCHEMA,
    id,
    title,
    route,
    agency,
    identity,
    summary,
    due,
    notice_type: noticeType,
    category,
    selection_method: selectionMethod,
    lifecycle: lifecycle === "cancelled" ? "cancelled" : null,
    domain: cleanText(item.domain),
    kind: cleanText(item.kind),
    lane: cleanText(item.lane),
  };
}

/**
 * Plain-text detail payload for the shared calendar preview `loadDetail` hook.
 * Returns null when there is nothing beyond title/date already on the cell, so
 * the host can skip painting an empty detail section.
 */
export function nowInspectionDetailPayload(itemOrProjection) {
  const projection = itemOrProjection?.schema === NOW_INSPECTION_PROJECTION_SCHEMA
    ? itemOrProjection
    : projectNowInspection(itemOrProjection);
  if (!projection) return null;
  const lines = [];
  if (projection.agency) lines.push(`Agency: ${projection.agency}`);
  if (projection.summary) lines.push(projection.summary);
  if (projection.identity?.request_id) lines.push(`Notice ${projection.identity.request_id}`);
  if (projection.identity?.pin) lines.push(`PIN ${projection.identity.pin}`);
  if (projection.identity?.exam_number) lines.push(`Exam ${projection.identity.exam_number}`);
  if (projection.lifecycle === "cancelled") lines.push("This item is cancelled.");
  if (!lines.length) return null;
  return { summary: lines.join("\n") };
}

/**
 * Occurrence fields the Now calendar adds on top of the shared display shape
 * so the preview host can show agency without a second fetch.
 */
export function nowInspectionOccurrenceFields(item) {
  const projection = projectNowInspection(item);
  if (!projection) return {};
  return {
    ...(projection.agency ? { agency: projection.agency } : {}),
    ...(projection.summary ? { summary: projection.summary } : {}),
  };
}

function defaultEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function definitionRow(term, value, esc) {
  if (!value) return "";
  return `<div class="now-card-fact"><dt>${esc(term)}</dt><dd lang="en" dir="ltr">${esc(value)}</dd></div>`;
}

/**
 * Overview markup shared by static build cards and the enhanced runtime.
 * Optional missing summaries produce no empty section.
 */
export function renderNowInspectionOverviewHTML(itemOrProjection, options = {}) {
  const projection = itemOrProjection?.schema === NOW_INSPECTION_PROJECTION_SCHEMA
    ? itemOrProjection
    : projectNowInspection(itemOrProjection);
  if (!projection) return "";
  const esc = typeof options.esc === "function" ? options.esc : defaultEscape;
  const rows = [
    definitionRow("Agency", projection.agency, esc),
    definitionRow("Summary", projection.summary, esc),
    definitionRow("Notice", projection.identity?.request_id, esc),
    definitionRow("PIN", projection.identity?.pin, esc),
    definitionRow("Exam", projection.identity?.exam_number, esc),
  ].filter(Boolean);
  if (!rows.length) return "";
  return `<dl class="${NOW_CARD_OVERVIEW_CLASS}" data-now-overview="1">${rows.join("")}</dl>`;
}

/**
 * Expanded inspection panel: same overview facts, plus an explicit full-record
 * control kept separate from Apply/Register domain actions in `.actions`.
 */
export function renderNowInspectionDetailHTML(itemOrProjection, options = {}) {
  const projection = itemOrProjection?.schema === NOW_INSPECTION_PROJECTION_SCHEMA
    ? itemOrProjection
    : projectNowInspection(itemOrProjection);
  if (!projection) return "";
  const esc = typeof options.esc === "function" ? options.esc : defaultEscape;
  const overview = renderNowInspectionOverviewHTML(projection, { esc });
  const status = options.detailStatus
    ? `<p class="now-card-detail-status" role="status">${esc(options.detailStatus)}</p>`
    : "";
  const fullRecordLabel = options.fullRecordLabel || "Open full record";
  return `<div class="${NOW_CARD_DETAIL_CLASS}" data-now-detail hidden>` +
    `<p class="now-card-detail-kicker">In-place details</p>` +
    overview +
    status +
    `<p class="now-card-detail-actions">` +
    `<a class="${NOW_CARD_FULL_RECORD_CLASS}" href="${esc(projection.route)}" data-now-full-record="1">${esc(fullRecordLabel)}</a>` +
    `<button type="button" class="now-card-detail-dismiss" data-now-inspect-dismiss>Close details</button>` +
    `</p></div>`;
}

/**
 * Title cluster: static canonical link (no-JS / failed enhancement) beside a
 * title-sized inspect button revealed only after the binder marks ready.
 */
export function renderNowCardTitleClusterHTML(itemOrProjection, options = {}) {
  const projection = itemOrProjection?.schema === NOW_INSPECTION_PROJECTION_SCHEMA
    ? itemOrProjection
    : projectNowInspection(itemOrProjection);
  if (!projection) return "";
  const esc = typeof options.esc === "function" ? options.esc : defaultEscape;
  const title = esc(projection.title);
  const inspectLabel = `Inspect: ${projection.title}`;
  return `<h3 class="now-card-title">` +
    `<a class="${NOW_CARD_TITLE_LINK_CLASS}" href="${esc(projection.route)}" lang="en" dir="ltr">${title}</a>` +
    `<button type="button" class="${NOW_CARD_INSPECT_CLASS}" ${NOW_CARD_INSPECT_ATTRIBUTE}="${esc(projection.id)}"` +
    ` aria-expanded="false" aria-label="${esc(inspectLabel)}" lang="en" dir="ltr">${title}</button>` +
    `</h3>`;
}

/**
 * Build a uid → Now item index for the optional calendar preview detail loader.
 */
export function indexNowItemsByCalendarUid(surface, stableUid = (item) => item?.id) {
  const index = new Map();
  const lanes = [
    ...(surface?.act_by?.dated || []),
    ...(surface?.happening_soon?.items || []),
  ];
  for (const item of lanes) {
    if (!item?.id) continue;
    const uid = typeof stableUid === "function" ? stableUid(item) : item.id;
    if (!uid || index.has(uid)) continue;
    index.set(uid, item);
  }
  return index;
}

/**
 * `loadDetail` hook for Now's compact-month host: resolve the occurrence uid
 * back to the Now item and return the shared summary payload. Throws when the
 * host asked for detail that cannot be produced so the preview binder keeps
 * its coherent facts and announces failure plainly.
 */
export function createNowCalendarDetailLoader(surface, options = {}) {
  const stableUid = options.stableUid;
  const index = indexNowItemsByCalendarUid(surface, stableUid);
  return (facts) => {
    const uid = cleanText(facts?.uid);
    if (!uid) throw new Error("now detail missing occurrence uid");
    const item = index.get(uid);
    if (!item) throw new Error("now detail item not found");
    const payload = nowInspectionDetailPayload(item);
    if (!payload) throw new Error("now detail has no available summary");
    return payload;
  };
}

/**
 * Progressive enhancement for Now cards: title-sized inspect toggles the
 * inline detail panel; dismiss restores focus; failed enhancement leaves the
 * static title link working.
 */
export function bindNowCardInspection(root) {
  if (!root || typeof root.querySelectorAll !== "function") return null;
  if (root.getAttribute?.(NOW_CARD_READY_ATTRIBUTE) != null) return null;
  const doc = root.ownerDocument || (root.nodeType === 9 ? root : null);
  if (!doc) return null;

  const closeDetail = (card, restoreFocus = true) => {
    const detail = card?.querySelector?.("[data-now-detail]");
    const button = card?.querySelector?.(`[${NOW_CARD_INSPECT_ATTRIBUTE}]`);
    if (detail) detail.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
    if (restoreFocus && button && typeof button.focus === "function" && button.isConnected) {
      button.focus();
    }
  };

  const openDetail = (card, button) => {
    const detail = card.querySelector("[data-now-detail]");
    if (!detail) return;
    for (const open of root.querySelectorAll("[data-now-detail]:not([hidden])")) {
      const other = open.closest(".now-card");
      if (other && other !== card) closeDetail(other, false);
    }
    detail.hidden = false;
    button?.setAttribute("aria-expanded", "true");
    const dismiss = detail.querySelector("[data-now-inspect-dismiss]");
    if (dismiss && typeof dismiss.focus === "function") dismiss.focus();
  };

  const onClick = (event) => {
    const dismiss = event.target.closest?.("[data-now-inspect-dismiss]");
    if (dismiss) {
      event.preventDefault();
      closeDetail(dismiss.closest(".now-card"), true);
      return;
    }
    const button = event.target.closest?.(`[${NOW_CARD_INSPECT_ATTRIBUTE}]`);
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    const card = button.closest(".now-card");
    if (!card) return;
    const detail = card.querySelector("[data-now-detail]");
    if (!detail) return;
    if (detail.hidden) openDetail(card, button);
    else closeDetail(card, true);
  };

  const onKeydown = (event) => {
    if (event.key !== "Escape") return;
    const open = root.querySelector("[data-now-detail]:not([hidden])");
    if (!open) return;
    event.preventDefault();
    closeDetail(open.closest(".now-card"), true);
  };

  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKeydown);
  if (typeof root.setAttribute === "function") root.setAttribute(NOW_CARD_READY_ATTRIBUTE, "");

  return {
    destroy() {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeydown);
      if (typeof root.removeAttribute === "function") root.removeAttribute(NOW_CARD_READY_ATTRIBUTE);
    },
  };
}
