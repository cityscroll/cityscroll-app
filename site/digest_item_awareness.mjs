// Shared digest item time-awareness + action-awareness (render/content only).
//
// Used by:
//   - worker email HTML (subDigestHtml / rollup) via worker re-export
//   - site alert preview digItemHTML (dynamic import) so Preview matches the email
//
// Mirrors site action rails and deadline chips (open / closing-soon / closed from
// EVENT time). Pure: no I/O; does not touch seen: keys / delivery identity.

import registry from "./action_registry.js";

const {
  compileActionRail,
  solicitationHandoff,
  awardHandoff,
  hearingHandoff,
  ruleHandoff,
  zoningHandoff,
  franchiseHandoff,
} = registry;

const ROLLING_YEAR = 2090;
/** Match site deadlineTag "soon" band (≤14 days). */
const CLOSING_SOON_DAYS = 14;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Manual short date — same shape as worker/src/lib/digest.mjs shortDate. */
export function shortDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  return m ? `${MON[Number(m[2]) - 1]} ${Number(m[3])}` : "";
}

// Minimal English strings for email + email-mock preview (site page chrome uses t() separately).
const AWARENESS_STRINGS = {
  en: {
    rules_comment_open: "Comments open through {date}",
    rules_comment_action: "Comment on NYC Rules",
    digest_next_action_label: "Next step:",
    digest_next_action_default: "Follow the steps below",
    digest_deadline_rolling: "No fixed deadline (rolling)",
    digest_deadline_closed: "Closed",
    digest_deadline_closed_on: "Closed (was {date})",
    digest_deadline_closes_today: "Closes today",
    digest_deadline_closes_tomorrow: "Closes tomorrow",
    digest_deadline_closing_soon: "Closing soon · due {date} ({n} days left)",
    digest_deadline_closing_soon_bare: "Closing soon",
    digest_deadline_open: "Open through {date} ({n} days left)",
    digest_deadline_open_date: "Open through {date}",
    digest_deadline_open_bare: "Open",
  },
  es: {
    rules_comment_open: "Comentarios abiertos hasta {date}",
    rules_comment_action: "Comentar en NYC Rules",
    digest_next_action_label: "Siguiente paso:",
    digest_next_action_default: "Siga los pasos a continuación",
    digest_deadline_rolling: "Sin fecha límite fija (continua)",
    digest_deadline_closed: "Cerrado",
    digest_deadline_closed_on: "Cerrado (era {date})",
    digest_deadline_closes_today: "Cierra hoy",
    digest_deadline_closes_tomorrow: "Cierra mañana",
    digest_deadline_closing_soon: "Cierra pronto · vence {date} (quedan {n} días)",
    digest_deadline_closing_soon_bare: "Cierra pronto",
    digest_deadline_open: "Abierto hasta {date} (quedan {n} días)",
    digest_deadline_open_date: "Abierto hasta {date}",
    digest_deadline_open_bare: "Abierto",
  },
};

function awarenessT(lang, key, vars) {
  const dict = AWARENESS_STRINGS[lang] || AWARENESS_STRINGS.en;
  let str = dict[key] !== undefined ? dict[key]
    : (AWARENESS_STRINGS.en[key] !== undefined ? AWARENESS_STRINGS.en[key] : key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp("\\{" + k + "\\}", "g"), String(v == null ? "" : v));
    }
  }
  return str;
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function isoDay(value) {
  const s = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

export function isRollingDeadline(due) {
  if (!due) return false;
  const y = Number(String(due).slice(0, 4));
  return Number.isFinite(y) && y >= ROLLING_YEAR;
}

/**
 * Whole calendar days from today → event (event − today). Negative = past.
 * Uses date-only strings so Worker/Node TZ does not shift the state.
 */
export function daysUntilEvent(eventAt, today) {
  const e = isoDay(eventAt);
  const t = isoDay(today) || isoDay(new Date().toISOString());
  if (!e || !t) return null;
  const a = Date.parse(e + "T00:00:00Z");
  const b = Date.parse(t + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

/**
 * Deadline / event status from EVENT time (digest-time-ontology).
 * @returns {{ state: 'open'|'closing-soon'|'closed'|'rolling'|'none', event_at: string|null, days_left: number|null }}
 */
export function deadlineState(eventAt, today, { rolling = false } = {}) {
  if (rolling || isRollingDeadline(eventAt)) {
    return { state: "rolling", event_at: isoDay(eventAt) || null, days_left: null };
  }
  const day = isoDay(eventAt);
  if (!day) return { state: "none", event_at: null, days_left: null };
  const daysLeft = daysUntilEvent(day, today);
  if (daysLeft == null) return { state: "none", event_at: day, days_left: null };
  if (daysLeft < 0) return { state: "closed", event_at: day, days_left: daysLeft };
  if (daysLeft <= CLOSING_SOON_DAYS) {
    return { state: "closing-soon", event_at: day, days_left: daysLeft };
  }
  return { state: "open", event_at: day, days_left: daysLeft };
}

/** Map digest kind / row fields → action-registry kind. */
export function digestMatterKind(row, digestKind) {
  if (row?.kind) return String(row.kind);
  const k = String(digestKind || "").toLowerCase();
  if (k === "rfp") return "solicitation";
  if (k === "award") return "award";
  if (k === "rules") return "rule";
  if (k === "meetings") return "hearing";
  if (k === "property") return "property";
  if (k === "rezone") return "zoning";
  if (k === "franchise") return "franchise";

  const section = text(row?.section_name);
  const type = text(row?.type_of_notice_description);
  if (section === "Agency Rules") return "rule";
  if (section === "Property Disposition") return "property";
  if (section === "Public Hearings and Meetings" || /hearing|meeting/i.test(type)) return "hearing";
  if (type === "Solicitation") return "solicitation";
  if (/Award|Intent to Negotiate|Vendor List/i.test(type)) return "award";
  if (/franchise|concession|fcrc/i.test(text(row?.agency_name) + " " + text(row?.short_title))) {
    return "franchise";
  }
  return "notice";
}

function joinBody(row) {
  // City Record body fields only. Do not fold ZAP project_brief into notice_text —
  // zoningHandoff treats non-empty notice_text as a synthetic hearing and would
  // mislabel the ZAP project link as "Open the hearing notice".
  return [
    row?.additional_description_1,
    row?.additional_description_2,
    row?.additional_description_3,
    row?.other_info_1,
    row?.other_info_2,
    row?.other_info_3,
    row?.printout_1,
    row?.notice_text,
  ].filter(Boolean).map((s) => String(s)).join("\n");
}

function officialNoticeUrl(row, digestKind) {
  if (row?.official_notice_url) return String(row.official_notice_url);
  if (digestKind === "rezone" && row?.project_id) {
    return `https://zap.planning.nyc.gov/projects/${encodeURIComponent(String(row.project_id))}`;
  }
  if (row?.request_id) {
    return `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(String(row.request_id))}`;
  }
  return null;
}

/**
 * Shape a digest row into the matter object action_registry expects.
 * Only uses fields already present on the row (or temporal_action attach).
 */
export function matterFromDigestRow(row, { kind: digestKind, today } = {}) {
  const r = row || {};
  const matterKind = digestMatterKind(r, digestKind);
  const body = joinBody(r);
  const temporal = r.temporal_action || null;

  let deadline = null;
  let lifecycleStage = text(r.lifecycle_stage) || null;
  let rolling = isRollingDeadline(r.due_date);

  if (matterKind === "solicitation") {
    deadline = isoDay(r.due_date) || null;
    if (rolling) lifecycleStage = lifecycleStage || "open";
    else if (deadline && daysUntilEvent(deadline, today) < 0) lifecycleStage = lifecycleStage || "closed";
  } else if (matterKind === "hearing") {
    deadline = isoDay(r.event_date) || isoDay(r.due_date) || null;
  } else if (matterKind === "rule") {
    // Prefer temporal_action event_at (comment-close valid time) when reconciliation attached it.
    deadline = isoDay(temporal?.event_at)
      || isoDay(r.comment_by_date)
      || isoDay(r.due_date)
      || null;
    if (temporal?.kind === "rules-comment-open") {
      lifecycleStage = "comment-open";
    } else if (!lifecycleStage) {
      lifecycleStage = deadline && daysUntilEvent(deadline, today) >= 0 ? "comment-open" : null;
    }
  } else if (matterKind === "zoning") {
    deadline = isoDay(r.current_milestone_date) || isoDay(r.event_date) || null;
  } else if (matterKind === "property" || matterKind === "franchise") {
    deadline = isoDay(r.due_date) || isoDay(r.event_date) || null;
  } else if (matterKind === "award") {
    deadline = null;
  }

  const commentUrl = temporal?.url || r.comment_url || null;

  return {
    kind: matterKind,
    request_id: r.request_id || null,
    title: r.short_title || r.project_name || r.section_name || null,
    agency_name: r.agency_name || null,
    section_name: r.section_name || null,
    type_of_notice_description: r.type_of_notice_description
      || (digestKind === "rfp" ? "Solicitation" : digestKind === "award" ? "Award" : null),
    pin: r.pin || null,
    vendor_name: r.vendor_name || null,
    contract_amount: r.contract_amount ?? null,
    due_date: r.due_date || null,
    deadline,
    rolling_deadline: rolling,
    event_date: r.event_date || null,
    email: r.email || null,
    contact_name: r.contact_name || null,
    contact_phone: r.contact_phone || null,
    street_address_1: r.street_address_1 || null,
    street_address_2: r.street_address_2 || null,
    building_name: r.building_name || null,
    city: r.city || null,
    state: r.state || null,
    zip_code: r.zip_code || null,
    address_to_request: r.address_to_request || null,
    selection_method: r.selection_method_description || r.selection_method || null,
    notice_text: body,
    official_notice_url: officialNoticeUrl(r, digestKind),
    lifecycle_stage: lifecycleStage,
    franchise_stage: r.franchise_stage || null,
    disposition_stage: r.disposition_stage || null,
    comment_url: commentUrl,
    comment_by_date: deadline,
    rule_url: commentUrl,
    project_id: r.project_id || null,
    project_name: r.project_name || null,
    project_url: r.project_id
      ? `https://zap.planning.nyc.gov/projects/${encodeURIComponent(String(r.project_id))}`
      : null,
    public_status: r.public_status || null,
    phase_id: r.phase_id || null,
    phase_label: r.phase_label || null,
    bbl: r.bbl || null,
    participation_url: r.participation_url || null,
    participation: r.participation || null,
    venue: r.venue || null,
    summary: r.summary || null,
    // Award lifecycle side-cars when present on the row (usually absent in digests).
    registration: r.registration || null,
    payment: r.payment || null,
    pending: r.pending || null,
    award_stage: r.award_stage || null,
    ocp_award: r.ocp_award || null,
    rfx_detail: r.rfx_detail || null,
  };
}

function phaseLabelFor(matter, digestKind, row) {
  if (matter.kind === "solicitation") return "Solicitation";
  if (matter.kind === "award") {
    const type = text(matter.type_of_notice_description);
    if (/^Intent to Award$/i.test(type)) return "Intent to Award";
    if (/^Intent to Negotiate$/i.test(type)) return "Intent to Negotiate";
    if (/^Vendor List$/i.test(type)) return "Vendor List";
    return "Award";
  }
  if (matter.kind === "rule") {
    if (matter.lifecycle_stage === "comment-open") return "Comment period open";
    return "Agency Rules";
  }
  if (matter.kind === "hearing") return "Hearing / meeting";
  if (matter.kind === "zoning") {
    return text(row?.public_status) || text(matter.phase_label) || "Land use (ULURP)";
  }
  if (matter.kind === "property") {
    return text(matter.disposition_stage) || "Property disposition";
  }
  if (matter.kind === "franchise") {
    return text(matter.franchise_stage) || "Franchise / concession";
  }
  if (digestKind === "entity") return text(matter.type_of_notice_description) || "Notice";
  return text(matter.type_of_notice_description) || null;
}

/**
 * Primary kinetic action from compileActionRail, skipping watch/calendar chrome.
 * Falls back to handoff-only guide when rail is pointer-only.
 */
export function primaryNextAction(matter, { today } = {}) {
  const actions = compileActionRail(matter, { today });
  const primary = (actions || []).find((a) =>
    a
    && a.type !== "watch"
    && a.type !== "calendar"
    && a.type !== "return_to_matter"
    && a.type !== "local_note"
  ) || null;

  // Attach guide fields for email step bullets when present.
  if (primary?.guide) return primary;

  // Ensure guide from handoff when primary is official without nested guide.
  let handoff = null;
  if (matter.kind === "solicitation") handoff = solicitationHandoff(matter);
  else if (matter.kind === "award") handoff = awardHandoff(matter);
  else if (matter.kind === "hearing") handoff = hearingHandoff(matter);
  else if (matter.kind === "rule") handoff = ruleHandoff(matter, { today });
  else if (matter.kind === "zoning") handoff = zoningHandoff(matter, { today });
  else if (matter.kind === "franchise") handoff = franchiseHandoff(matter);

  if (primary && handoff) return { ...primary, guide: primary.guide || handoff };
  return primary;
}

function guideSteps(guide, matter) {
  if (!guide || typeof guide !== "object") return [];
  const steps = [];
  const push = (label, value) => {
    if (value == null || value === "") return;
    steps.push({ label, value: String(value) });
  };

  if (guide.package_url) push("Package / submit", guide.package_url);
  if (guide.destination && guide.destination !== guide.package_url
    && guide.destination !== guide.comment_url
    && guide.destination !== guide.project_url
    && guide.destination !== guide.participation_url
    && guide.destination !== guide.checkbook_url) {
    // destination already shown as CTA link; skip duplicate unless different
  }
  if (guide.comment_deadline) push("Comment by", String(guide.comment_deadline).slice(0, 10));
  if (guide.event_date) push("Event", String(guide.event_date).slice(0, 10));
  if (guide.hearing_date) push("Hearing", String(guide.hearing_date).slice(0, 10));
  if (guide.venue_building) push("Venue", guide.venue_building);
  if (guide.venue_address) push("Address", guide.venue_address);
  if (guide.participation_url) push("Join / participate", guide.participation_url);
  if (guide.testimony_email) push("Testimony email", guide.testimony_email);
  if (guide.testimony_until?.label) push("Testimony until", guide.testimony_until.label);
  else if (guide.testimony_until?.kind === "hearing_close") {
    push("Testimony until", "close of the hearing");
  }
  if (guide.contact_name) push("Contact", guide.contact_name);
  if (guide.email) push("Email", guide.email);
  if (guide.contact_phone) push("Phone", guide.contact_phone);
  if (guide.address_to_request) push("Submit to", guide.address_to_request);
  if (guide.selection_method) push("Method", guide.selection_method);
  if (guide.identifier) push("PIN / EPIN", guide.identifier);
  if (guide.vendor) push("Vendor", guide.vendor);
  if (guide.amount) push("Amount", guide.amount);
  if (guide.registration_date) push("Registered", String(guide.registration_date).slice(0, 10));
  if (guide.phase_label) push("Phase", guide.phase_label);
  if (guide.public_status) push("Status", guide.public_status);

  // Cap bullets so emails stay scannable.
  return steps.slice(0, 6);
}

/**
 * Build the awareness model for one digest line item.
 * @returns {{
 *   phase: string|null,
 *   deadline: { state, event_at, days_left },
 *   action: object|null,
 *   steps: Array<{label,value}>,
 *   pointer_only: boolean,
 * }}
 */
export function digestItemAwareness(row, { kind: digestKind = null, today = null } = {}) {
  const day = isoDay(today) || isoDay(new Date().toISOString());
  const matter = matterFromDigestRow(row, { kind: digestKind, today: day });
  const phase = phaseLabelFor(matter, digestKind, row);

  let eventAt = matter.deadline;
  if (matter.kind === "award") eventAt = null;
  if (row?.temporal_action?.event_at) eventAt = isoDay(row.temporal_action.event_at) || eventAt;

  const deadline = deadlineState(eventAt, day, { rolling: matter.rolling_deadline });
  const action = primaryNextAction(matter, { today: day });

  const isPointer = !action
    || action.delivery === "unavailable"
    || (
      action.type === "document"
      && /read_official_notice|zap_full_project/i.test(String(action.label_key || ""))
      && !action.guide?.has_fields
      && !action.guide?.package_url
      && !action.guide?.email
      && !action.guide?.vendor
    );

  const steps = isPointer ? [] : guideSteps(action?.guide || null, matter);

  // Honest pointer: no fabricated CTA. Callers still render View on CityScroll / City Record.
  return {
    phase,
    deadline,
    action: isPointer ? null : action,
    steps,
    pointer_only: isPointer,
    matter_kind: matter.kind,
  };
}

function deadlineStatusCopy(deadline, lang) {
  const state = deadline?.state;
  if (!state || state === "none") return "";
  const date = deadline.event_at ? shortDate(deadline.event_at) : "";
  const n = deadline.days_left;
  if (state === "rolling") return awarenessT(lang, "digest_deadline_rolling");
  if (state === "closed") {
    return date
      ? awarenessT(lang, "digest_deadline_closed_on", { date })
      : awarenessT(lang, "digest_deadline_closed");
  }
  if (state === "closing-soon") {
    if (n === 0) return awarenessT(lang, "digest_deadline_closes_today");
    if (n === 1) return awarenessT(lang, "digest_deadline_closes_tomorrow");
    if (date && n != null) {
      return awarenessT(lang, "digest_deadline_closing_soon", { date, n });
    }
    return awarenessT(lang, "digest_deadline_closing_soon_bare");
  }
  // open
  if (date && n != null) return awarenessT(lang, "digest_deadline_open", { date, n });
  if (date) return awarenessT(lang, "digest_deadline_open_date", { date });
  return awarenessT(lang, "digest_deadline_open_bare");
}

/**
 * Compact HTML block for time + action awareness under a digest item.
 * Returns "" when there is nothing useful beyond the existing links.
 *
 * @param {object} row - digest row (may include temporal_action)
 * @param {(s:string)=>string} esc - HTML escaper
 * @param {string} lang
 * @param {{ kind?: string, today?: string }} opts
 */

/**
 * Optional adoption-lag digest line for watched rules whose comment period has
 * closed. Prefer a pre-rendered adoption_lag_line (band-transition gated by the
 * caller via adoptionLagDigestItem). Falls back to a pattern-only line.
 */
export function adoptionLagAwarenessLine(row, opts = {}) {
  if (row?.adoption_lag_line) return String(row.adoption_lag_line);
  if (opts.line) return String(opts.line);
  const pattern = row?.adoption_lag_pattern || opts.pattern || null;
  if (!pattern || !pattern.n) return null;
  const date = String(
    pattern.comment_close
    || row?.comment_close
    || row?.nyc_rules?.comment_by_date
    || opts.commentClose
    || "",
  ).slice(0, 10);
  const closed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `Comments closed ${date}. ` : "";
  const n = pattern.n;
  const year = pattern.since_year || "2013";
  const median = pattern.median_days;
  const lo = pattern.middle_half_low;
  const hi = pattern.middle_half_high;
  const halfUseful = lo != null && hi != null && lo !== hi;
  const timing = median != null
    ? `Adoption typically takes ${median} days${halfUseful ? `; the middle half took ${lo}–${hi} days` : ""}.`
    : `Adoption timing for similar rules usually fell between ${lo} and ${hi} days.`;
  return `${closed}${timing} Based on ${n} similar rule adoptions since ${year}.`;
}

export function itemAwarenessHtml(row, esc, lang = "en", opts = {}) {
  const awareness = digestItemAwareness(row, opts);
  const parts = [];
  const temporal = row?.temporal_action;

  // Time line: phase + open/closing-soon/closed (event clock).
  // Rules with attached temporal_action keep the established "Comments open through {date}" line.
  let status;
  if (temporal?.kind === "rules-comment-open" && temporal.event_at) {
    status = awarenessT(lang, "rules_comment_open", { date: shortDate(temporal.event_at) });
  } else {
    status = deadlineStatusCopy(awareness.deadline, lang);
  }
  // When rules temporal owns the status line, skip a redundant phase prefix so the
  // classic "Comments open through … · Comment on NYC Rules" pattern stays scannable.
  const phase = (temporal?.kind === "rules-comment-open")
    ? ""
    : (awareness.phase ? esc(awareness.phase) : "");
  if (phase || status) {
    const timeBits = [phase, status ? esc(status) : ""].filter(Boolean).join(" · ");
    parts.push(
      `<div style="color:#8a3d12;font-size:13px;margin:3px 0 2px">${timeBits}</div>`,
    );
  }

  // Action line — prefer one concrete CTA (rules comment URL / rail destination).
  let actionRendered = false;
  if (temporal?.kind === "rules-comment-open" && temporal.url) {
    const label = awarenessT(lang, "rules_comment_action");
    parts.push(
      `<div style="font-size:13px;margin:2px 0"><a href="${esc(temporal.url)}">${esc(label)}</a></div>`,
    );
    actionRendered = true;
  } else if (awareness.action) {
    const a = awareness.action;
    const label = text(a.label) || awarenessT(lang, "digest_next_action_default");
    if (a.destination && a.delivery === "official_handoff") {
      parts.push(
        `<div style="font-size:13px;margin:2px 0"><b>${esc(awarenessT(lang, "digest_next_action_label"))}</b> `
        + `<a href="${esc(a.destination)}">${esc(label)}</a></div>`,
      );
      actionRendered = true;
    } else if (a.delivery === "unavailable" && a.label) {
      parts.push(
        `<div style="color:#666;font-size:12px;margin:2px 0">${esc(a.label)}</div>`,
      );
      actionRendered = true;
    } else if (a.delivery !== "unavailable") {
      parts.push(
        `<div style="font-size:13px;margin:2px 0"><b>${esc(awarenessT(lang, "digest_next_action_label"))}</b> `
        + `${esc(label)}</div>`,
      );
      actionRendered = true;
    }
  }

  // Suppress steps that only repeat the rules comment-by date already in the status line.
  const steps = awareness.steps.filter((s) => {
    if (temporal?.kind === "rules-comment-open" && s.label === "Comment by") return false;
    return true;
  });

  if (steps.length) {
    const lis = steps.map((s) => {
      const v = s.value;
      const isUrl = /^https:\/\//i.test(v);
      const isMail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      let valHtml;
      if (isUrl) valHtml = `<a href="${esc(v)}">${esc(v)}</a>`;
      else if (isMail) valHtml = `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
      else valHtml = esc(v);
      return `<li style="margin:0 0 2px">${esc(s.label)}: ${valHtml}</li>`;
    }).join("");
    parts.push(
      `<ul style="margin:4px 0 6px;padding-left:18px;font-size:12px;color:#444">${lis}</ul>`,
    );
  } else if (!actionRendered && !status && !phase) {
    // may still have adoption-lag line below
  }

  // One-line adoption-lag pattern attribution after closed comment periods.
  // Band-transition gating lives with the caller (adoptionLagDigestItem).
  const lagLine = adoptionLagAwarenessLine(row, opts);
  if (lagLine) {
    parts.push(
      `<div style="color:#5b6470;font-size:12px;margin:4px 0 2px">${esc(lagLine)}</div>`,
    );
  }

  if (!parts.length) return "";
  return parts.join("");
}

/**
 * Backward-compatible replacement for rules-only temporalActionHtml.
 * Renders full awareness when kind/today provided; rules temporal still works alone.
 */
export function temporalActionHtml(row, esc, lang = "en", opts = {}) {
  // If caller passes kind (or row looks like a full digest item), use full awareness.
  if (opts.kind || opts.full || row?.type_of_notice_description || row?.due_date
    || row?.event_date || row?.project_id || row?.temporal_action) {
    return itemAwarenessHtml(row, esc, lang, opts);
  }
  // Minimal legacy path (rules-only).
  const action = row?.temporal_action;
  if (action?.kind !== "rules-comment-open" || !action.event_at || !action.url) return "";
  const deadline = shortDate(action.event_at);
  const status = awarenessT(lang, "rules_comment_open", { date: deadline });
  const label = awarenessT(lang, "rules_comment_action");
  return `<div style="color:#8a3d12;font-size:13px;margin:3px 0">${esc(status)} · <a href="${esc(action.url)}">${esc(label)}</a></div>`;
}
