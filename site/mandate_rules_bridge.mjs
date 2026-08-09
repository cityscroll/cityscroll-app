import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";

/**
 * Mandates → Rules constellation card (first iteration).
 *
 * Connects rulemaking-type statutory mandates (deliverable_type = rulemaking)
 * to the agency's Rules-lens City Record filings (proposal → hearing → adoption).
 * Join path: mandate → agency identity → Rules-lens records. Per-mandate
 * observed filings from process-conformance topic join appear when present.
 *
 * Product term: mandates. Upstream extract vocabulary is not user-facing.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { agencyObligationsFollowHref } from "./agency_obligations.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import { noticeDocumentPath } from "./notice_permalink.mjs";
import {
  MANDATE_RULE_PUBLICATION_TIER,
  OBSERVATION_LABELS,
  OBSERVATION_STATUS,
} from "./process_conformance.mjs";

export const MANDATE_RULES_BRIDGE_SCHEMA = "cityscroll.mandate_rules_bridge.v1";
export const MANDATE_RULES_BRIDGE_METHOD = "mandate_agency_rules_bridge_v1";
export const MANDATE_RULES_BRIDGE_ITERATION = "v1";

/** Reader lead — plain connection, no hedging. */
export const MANDATE_RULES_BRIDGE_COPY = Object.freeze({
  lead:
    "Statutory duties that require this agency to make rules, shown with City Record Agency Rules filings from the Rules lens.",
});

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

const noticeHref = (href, requestId) => {
  const value = clean(href, 240);
  if (value.startsWith("#notice/")) {
    const fragmentId = value.slice("#notice/".length).split(/[?#]/, 1)[0];
    let id = fragmentId;
    try {
      id = decodeURIComponent(fragmentId);
    } catch {
      // Keep the raw fragment id; noticeDocumentPath will still encode it safely.
    }
    return noticeDocumentPath(id || requestId);
  }
  return value || noticeDocumentPath(requestId);
};

/** Shareable constellation anchor for the Mandates → Rules card. */
export function agencyMandateRulesPath(agencyIdOrName) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return "/agencies/";
  return `/agencies/${encodeURIComponent(identity.canonical_id)}/#mandates-rules`;
}

/**
 * Rules-lens follow scope for an agency (City Record Agency Rules activity).
 */
export function agencyRulesFollowHref(agencyIdOrName, { frequency = "weekly" } = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_name) return "/following/";
  const ref = identity.canonical_id ? `agency:id:${identity.canonical_id}` : null;
  const filter = { agency: identity.canonical_name };
  if (ref) filter.entity_refs_all = [ref];
  return followingUrlFromWatch({ lens: "rules", filter }, { frequency });
}

/**
 * Build the Mandates → Rules bridge view for one agency.
 *
 * @param {string} agencyIdOrName
 * @param {{
 *   obligationsLookup?: object,
 *   rulesItems?: object[],
 *   rulesCount?: number,
 *   rulesBrowseHref?: string,
 *   rulesFollowHref?: string,
 *   conformanceItems?: object[],
 *   limit?: number,
 * }} sources
 */
export function buildMandateRulesBridgeView(agencyIdOrName, sources = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return null;

  const bucket = sources.obligationsLookup?.by_agency?.[identity.canonical_id] || null;
  const allMandates = Array.isArray(bucket?.obligations) ? bucket.obligations : [];
  const rulemaking = allMandates.filter(
    (row) => clean(row?.deliverable_type, 40).toLowerCase() === "rulemaking",
  );

  const confById = new Map();
  for (const item of sources.conformanceItems || []) {
    const mid = item?.mandate_id || item?.obligation_id;
    if (mid) confById.set(mid, item);
  }

  const limit = Math.max(1, Math.min(Number(sources.limit) || 12, 40));
  const mandates = rulemaking.slice(0, limit).map((row) => {
    const conf = confById.get(row.obligation_id) || null;
    const obs = conf?.observation || null;
    const publicMandateRuleEdge = obs?.match?.publication === MANDATE_RULE_PUBLICATION_TIER
      || obs?.publication === MANDATE_RULE_PUBLICATION_TIER;
    const observed = obs?.status === OBSERVATION_STATUS.OBSERVED
      && publicMandateRuleEdge
      && obs?.observed_record
      ? {
        request_id: clean(obs.observed_record.request_id, 40) || null,
        label: clean(obs.observed_record.label, 240) || null,
        when: clean(obs.observed_record.when, 40) || null,
        href: noticeHref(obs.observed_record.href, obs.observed_record.request_id),
        signal_kind: clean(obs.observed_record.signal_kind, 40) || "rule_filing",
        publication: MANDATE_RULE_PUBLICATION_TIER,
      }
      : null;
    return {
      mandate_id: row.obligation_id,
      duty_text: clean(row.duty_text, 500),
      deliverable_type: "rulemaking",
      citation: clean(row.citation, 200) || null,
      deadline_date: clean(row.deadline?.computed_date, 20) || null,
      deadline_text: clean(row.deadline?.text || row.deadline_text, 240) || null,
      recurrence: clean(row.recurrence, 40) || null,
      source_href: clean(row.source?.legistar_url || row.href, 400) || null,
      observation_status: observed
        ? OBSERVATION_STATUS.OBSERVED
        : (obs?.status || null),
      observation_label: observed
        ? (OBSERVATION_LABELS[OBSERVATION_STATUS.OBSERVED] || "Observed in City Record")
        : (obs?.label || null),
      observed_record: observed,
    };
  });

  const rulesItems = (Array.isArray(sources.rulesItems) ? sources.rulesItems : [])
    .filter(Boolean)
    .slice(0, limit)
    .map((item) => ({
      id: clean(item.id || item.request_id, 40) || null,
      subject_ref: clean(item.subject_ref, 120)
        || (item.id || item.request_id ? `notice:${item.id || item.request_id}` : null),
      label: clean(item.label, 240) || clean(item.id || item.request_id, 40),
      date: clean(item.date || item.when, 40) || null,
      href: noticeHref(item.href, item.id || item.request_id),
      source: clean(item.source, 80) || "City Record",
    }))
    .filter((item) => item.label);

  const rulesCount = Number(sources.rulesCount);
  const rulesTotal = Number.isFinite(rulesCount) && rulesCount >= 0
    ? rulesCount
    : rulesItems.length;

  const mandateTotal = rulemaking.length;
  const observedCount = mandates.filter((m) => m.observed_record).length;

  // Surface only when there is something standable: rulemaking mandates
  // and/or Rules-lens activity for the agency.
  if (!mandateTotal && !rulesTotal) {
    return {
      schema: MANDATE_RULES_BRIDGE_SCHEMA,
      method: MANDATE_RULES_BRIDGE_METHOD,
      iteration: MANDATE_RULES_BRIDGE_ITERATION,
      status: "empty",
      agency_id: identity.canonical_id,
      agency_name: identity.canonical_name,
      subject_ref: `agency:id:${identity.canonical_id}`,
      counts: {
        rulemaking_mandates: 0,
        rules_filings: 0,
        observed_links: 0,
      },
      mandates: [],
      rules_items: [],
      copy: MANDATE_RULES_BRIDGE_COPY,
      share_path: agencyMandateRulesPath(identity.canonical_id),
      rules_browse_href: sources.rulesBrowseHref || "",
      rules_follow_href: sources.rulesFollowHref
        || agencyRulesFollowHref(identity.canonical_id),
      rulemaking_mandates_follow_href: agencyObligationsFollowHref(identity.canonical_id, {
        deliverableType: "rulemaking",
      }),
    };
  }

  return {
    schema: MANDATE_RULES_BRIDGE_SCHEMA,
    method: MANDATE_RULES_BRIDGE_METHOD,
    iteration: MANDATE_RULES_BRIDGE_ITERATION,
    status: "matched",
    agency_id: identity.canonical_id,
    agency_name: identity.canonical_name,
    subject_ref: `agency:id:${identity.canonical_id}`,
    counts: {
      rulemaking_mandates: mandateTotal,
      rules_filings: rulesTotal,
      observed_links: observedCount,
    },
    mandates,
    rules_items: rulesItems,
    copy: MANDATE_RULES_BRIDGE_COPY,
    share_path: agencyMandateRulesPath(identity.canonical_id),
    rules_browse_href: sources.rulesBrowseHref || "",
    rules_follow_href: sources.rulesFollowHref
      || agencyRulesFollowHref(identity.canonical_id),
    rulemaking_mandates_follow_href: agencyObligationsFollowHref(identity.canonical_id, {
      deliverableType: "rulemaking",
    }),
  };
}

/**
 * Compact HTML for constellation embedding (#mandates-rules).
 * Omits entirely when empty — no absence disclaimers.
 */
export function renderMandateRulesBridgeSection(view) {
  if (!view || view.status !== "matched") return "";
  const counts = view.counts || {};
  const statusLine = [
    counts.rulemaking_mandates
      ? `${counts.rulemaking_mandates} rulemaking mandate${counts.rulemaking_mandates === 1 ? "" : "s"}`
      : null,
    counts.rules_filings
      ? `${counts.rules_filings} Rules filing${counts.rules_filings === 1 ? "" : "s"}`
      : null,
    counts.observed_links
      ? `${counts.observed_links} linked filing${counts.observed_links === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean).join(" · ");

  const mandateList = (view.mandates || []).length
    ? `<ul class="node-record-list mandate-rules-mandates" data-bridge-side="mandates">${
      view.mandates.map((item) => {
        const meta = [
          "rulemaking",
          item.deadline_date
            ? `deadline ${item.deadline_date}`
            : (item.deadline_text ? `deadline: ${item.deadline_text}` : null),
          item.recurrence,
          item.citation,
        ].filter(Boolean).map(esc).join(" · ");
        const observed = item.observed_record?.href
          ? ` · ${constellationLink({ href: item.observed_record.href, label: `City Record: ${item.observed_record.label || item.observed_record.request_id}`, className: "agency-edge-link", escape: esc })}`
          : "";
        const source = item.source_href
          ? ` · ${officialSourceLink({ href: item.source_href, label: "Source law", className: "agency-source-link", escape: esc })}`
          : "";
        const chip = item.observation_status === OBSERVATION_STATUS.OBSERVED
          ? `<span class="mandate-obs-chip mandate-obs-observed" data-observation-status="${esc(OBSERVATION_STATUS.OBSERVED)}">${esc(item.observation_label || "Observed in City Record")}</span>`
          : "";
        return `<li class="node-record mandate-rules-mandate" data-mandate-id="${esc(item.mandate_id)}" data-deliverable-type="rulemaking"${item.observation_status ? ` data-observation-status="${esc(item.observation_status)}"` : ""}>
          <div class="node-record-main">${chip}${esc(item.duty_text)}</div>
          <span class="muted node-muted">${meta}${observed}${source}</span>
        </li>`;
      }).join("")
    }</ul>`
    : "";

  const rulesList = (view.rules_items || []).length
    ? `<ul class="node-record-list mandate-rules-filings" data-bridge-side="rules">${
      view.rules_items.map((item) => {
        const label = item.href
          ? constellationLink({ href: item.href, label: item.label, className: "agency-edge-link", attributes: { "data-subject-ref": item.subject_ref || "" }, escape: esc })
          : esc(item.label);
        const meta = [item.source, item.date].filter(Boolean).map(esc).join(" · ");
        return `<li class="node-record mandate-rules-filing" data-request-id="${esc(item.id || "")}">
          <div class="node-record-main">${label}</div>
          ${meta ? `<span class="muted node-muted">${meta}</span>` : ""}
        </li>`;
      }).join("")
    }</ul>`
    : "";

  const parts = [];
  if (mandateList) {
    parts.push(`<h3 class="node-subhead">Rulemaking mandates</h3>${mandateList}`);
  }
  if (rulesList) {
    parts.push(`<h3 class="node-subhead">Rules-lens activity</h3>${rulesList}`);
  }

  const actions = [
    view.rules_browse_href
      ? `<a class="node-action civic-object-action" href="${esc(view.rules_browse_href)}">Open in Rules</a>`
      : "",
    view.rulemaking_mandates_follow_href
      ? `<a class="node-action civic-object-action" href="${esc(view.rulemaking_mandates_follow_href)}">Watch rulemaking mandates</a>`
      : "",
    view.rules_follow_href
      ? `<a class="node-action civic-object-action" href="${esc(view.rules_follow_href)}">Follow Rules activity</a>`
      : "",
    view.share_path
      ? `<a class="node-action civic-object-action" href="${esc(view.share_path)}">Share this view</a>`
      : "",
  ].filter(Boolean).join("");

  const copy = view.copy || MANDATE_RULES_BRIDGE_COPY;
  return `<section id="mandates-rules" class="node-section node-card civic-object-section mandate-rules-bridge" data-agency-constellation-card="mandates-rules" data-method="${esc(view.method || MANDATE_RULES_BRIDGE_METHOD)}" data-status="${esc(view.status)}" data-export-class="object_members">
    <h2>Rulemaking mandates · Rules activity <span class="muted node-muted">(${esc(statusLine || "linked")})</span></h2>
    <p class="node-muted muted">${esc(copy.lead || MANDATE_RULES_BRIDGE_COPY.lead)}</p>
    ${parts.join("")}
    ${actions ? `<p class="node-inline-actions civic-object-inline-actions">${actions}</p>` : ""}
  </section>`;
}

/** Minimal CSS for subheads on the bridge card. */
export const MANDATE_RULES_BRIDGE_STYLE = `
.mandate-rules-bridge .node-subhead {
  margin: 1rem 0 0.4rem;
  font: 600 0.95rem/1.3 var(--font-body, system-ui, sans-serif);
}
.mandate-rules-bridge .mandate-obs-chip {
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
`;
