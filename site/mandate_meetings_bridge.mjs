/** Mandates → meetings/hearings cross-entity edges for agency constellations. */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { agencyObligationsFollowHref } from "./agency_obligations.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import {
  buildEdgeProvenanceClaim,
  renderWhyBelieveControl,
} from "./graph_edge_provenance.mjs";
import { contentTokens } from "./process_conformance.mjs";
import { canonicalizeBrowseUrl } from "./route_migration.mjs";
import {
  emptyScope,
  normalizeScope,
  routeHashFromScope,
  scopeWithEntity,
} from "./scope_v0.mjs";

export const MANDATE_MEETINGS_SCHEMA = "cityscroll.mandate_meetings.v1";
export const MANDATE_MEETINGS_METHOD = "mandate_meeting_multikey_exact_v1";
export const MANDATE_MEETINGS_MATCHER_VERSION = "v1";
export const MANDATE_MEETING_EDGE_TYPE = "requires_public_hearing";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

const EVENT_TOKENS = new Set([
  "administration", "agency", "agenda", "authority", "board", "commission", "conduct",
  "convene", "department", "hearing", "hearings", "hold", "meeting", "meetings", "notice",
  "office", "organize", "public", "session", "sessions",
]);

function singularToken(token) {
  const value = clean(token, 80).toLowerCase();
  if (value.length > 5 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function scopeTokens(...parts) {
  return [...new Set(contentTokens(parts.filter(Boolean).join(" "))
    .map(singularToken)
    .filter((token) => token && !EVENT_TOKENS.has(token)))];
}

/** True only when the duty itself commands a public civic event. */
export function mandateRequiresMeeting(mandate = {}) {
  const duty = clean(mandate.duty_text || mandate.label, 800);
  return /\b(?:hold|conduct|convene|organize|solicit|commence|begin)\b[^.!?]{0,160}\b(?:public\s+)?(?:hearing|meeting|forum|input session)s?\b/i.test(duty);
}

function eventKind(row = {}) {
  const type = clean(row.type_of_notice_description || row.notice_type || row.type, 120).toLowerCase();
  const section = clean(row.section_name || row.section, 120).toLowerCase();
  const label = clean(row.short_title || row.title || row.label, 320).toLowerCase();
  if (type === "public hearings" || section.includes("public hearings and meetings")) {
    return /\bmeeting\b/.test(label) && !/\bhearing\b/.test(label) ? "public_meeting" : "public_hearing";
  }
  if (type === "meeting" || type === "public meeting") return "public_meeting";
  return null;
}

function datePart(value) {
  const match = clean(value, 40).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function meetingCandidates(meetingsDomain, identity) {
  const out = [];
  for (const row of meetingsDomain?.rows || []) {
    const agency = resolveAgencyIdentity(row.agency_id || row.agency_name || row.agency);
    if (agency?.canonical_id !== identity.canonical_id) continue;
    const kind = eventKind(row);
    if (!kind) continue;
    const requestId = clean(row.request_id || row.id, 80);
    const label = clean(row.short_title || row.title || row.label, 320);
    if (!requestId || !label) continue;
    out.push({
      request_id: requestId,
      subject_ref: `notice:${requestId}`,
      label,
      event_kind: kind,
      date: datePart(row.event_date || row.start_date || row.date),
      href: clean(row.href, 240) || `/notices/${encodeURIComponent(requestId)}`,
      source_system: clean(row.source_system, 80) || "city_record",
      agency_name: identity.canonical_name,
      title_scope_tokens: scopeTokens(label),
      agency_scope_tokens: scopeTokens(identity.canonical_name),
    });
  }
  return out.sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")));
}

function matchedScope(mandate, candidate) {
  const mandateScope = scopeTokens(mandate.duty_text, mandate.citation);
  const titleScope = new Set(candidate.title_scope_tokens || []);
  const agencyScope = new Set(candidate.agency_scope_tokens || []);
  const titleShared = mandateScope.filter((token) => titleScope.has(token));
  const agencyShared = mandateScope.filter((token) => agencyScope.has(token));
  if (titleShared.length >= 2) return titleShared;
  if (agencyShared.length >= 2) return agencyShared;
  const rareAgency = agencyShared.filter((token) => token.length >= 8);
  return rareAgency.length ? rareAgency : [];
}

function stablePart(value) {
  return clean(value, 160).toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function agencyMandateMeetingsPath(agencyIdOrName) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  return identity?.canonical_id
    ? `/agencies/${encodeURIComponent(identity.canonical_id)}/#mandates-meetings`
    : "/agencies/";
}

export function agencyMeetingsFollowHref(agencyIdOrName, { frequency = "weekly" } = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_name) return "/following/";
  const filter = {
    agency: identity.canonical_name,
    entity_refs_all: [`agency:id:${identity.canonical_id}`],
  };
  return followingUrlFromWatch({ lens: "meetings", filter }, { frequency });
}

export function agencyMeetingsBrowseHref(agencyIdOrName) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return "/browse/meetings/";
  let scope = emptyScope("en");
  scope.facets.agencies = [identity.canonical_name];
  scope = scopeWithEntity(scope, `agency:id:${identity.canonical_id}`);
  scope.facets.domains = ["meetings"];
  scope.facets.values.connection_relation = "hosts_meeting";
  const hash = routeHashFromScope(normalizeScope(scope), { surface: "meetings" });
  const query = String(hash).includes("?") ? String(hash).split("?", 2)[1] : "";
  return canonicalizeBrowseUrl(`/browse/meetings/${query ? `?${query}` : ""}`);
}

export function buildMandateMeetingsView(agencyIdOrName, sources = {}) {
  const identity = resolveAgencyIdentity(agencyIdOrName);
  if (!identity?.canonical_id) return null;
  const mandates = (sources.obligationsLookup?.by_agency?.[identity.canonical_id]?.obligations || [])
    .filter((row) => row?.certification?.quote_verified !== false)
    .filter(mandateRequiresMeeting);
  const candidates = meetingCandidates(sources.meetingsDomain, identity);
  const runId = `resolution-run:mandate-meeting:${stablePart(identity.canonical_id)}:${stablePart(sources.generatedAt || sources.meetingsDomain?.generated_at || "current")}`;
  const resolutionRun = Object.freeze({
    id: runId,
    method: MANDATE_MEETINGS_METHOD,
    matcher_version: MANDATE_MEETINGS_MATCHER_VERSION,
    entity_type: "mandate_meeting",
    scope_note: "agency+event_kind+subject_scope",
    status: "complete",
  });
  const edges = [];
  const perMandateLimit = Math.max(1, Math.min(Number(sources.perMandateLimit) || 3, 8));

  for (const mandate of mandates) {
    let matched = 0;
    for (const meeting of candidates) {
      const subjectScope = matchedScope(mandate, meeting);
      if (!subjectScope.length) continue;
      const linkId = `entity-link:mandate-meeting:${stablePart(mandate.obligation_id)}:${stablePart(meeting.request_id)}`;
      const entityLink = {
        id: linkId,
        source_record_id: `obligation:${mandate.obligation_id}`,
        canonical_entity_id: meeting.subject_ref,
        decision: "auto_link",
        confidence: 1,
        method: MANDATE_MEETINGS_METHOD,
        matcher_version: MANDATE_MEETINGS_MATCHER_VERSION,
        resolution_run_id: runId,
        review_status: "auto_exact",
        evidence: {
          keys: ["agency", "event_kind", "subject_scope"],
          agency_id: identity.canonical_id,
          event_kind: meeting.event_kind,
          subject_scope: subjectScope,
        },
      };
      const item = {
        id: `${mandate.obligation_id}:${meeting.request_id}`,
        subject_ref: meeting.subject_ref,
        root_ref: `obligation:${mandate.obligation_id}`,
        label: meeting.label,
        href: meeting.href,
        relation: MANDATE_MEETING_EDGE_TYPE,
        confidence: "strong",
        decision: entityLink.decision,
        method: MANDATE_MEETINGS_METHOD,
        entity_link_id: linkId,
        resolution_run_id: runId,
        date: meeting.date,
        provenance: {
          source_system: meeting.source_system,
          source_record_id: `city_record:${meeting.request_id}`,
          source_fields: ["agency_name", "type_of_notice_description", "short_title"],
          input_value: subjectScope.join(", "),
          observed_at: meeting.date,
          basis: "agency+event_kind+subject_scope",
          source_excerpt: meeting.label,
        },
      };
      const claim = buildEdgeProvenanceClaim(item, {
        category_id: "mandate-meetings",
        relation: MANDATE_MEETING_EDGE_TYPE,
        root_ref: item.root_ref,
        document_path: `/agencies/${encodeURIComponent(identity.canonical_id)}/`,
      });
      edges.push({
        relation: MANDATE_MEETING_EDGE_TYPE,
        mandate: {
          mandate_id: mandate.obligation_id,
          subject_ref: `obligation:${mandate.obligation_id}`,
          duty_text: clean(mandate.duty_text, 500),
          citation: clean(mandate.citation, 200) || null,
          source_href: clean(mandate.source?.legistar_url || mandate.href, 400) || null,
        },
        meeting,
        match: entityLink.evidence,
        entity_link: entityLink,
        resolution_run: resolutionRun,
        process_conformance: {
          expected_event: { kind: meeting.event_kind, label: "Public meeting or hearing" },
          status: "observed",
          observed_record: meeting,
        },
        claim,
      });
      matched += 1;
      if (matched >= perMandateLimit) break;
    }
  }

  const matchedMandates = new Set(edges.map((edge) => edge.mandate.mandate_id));
  const matchedMeetings = new Set(edges.map((edge) => edge.meeting.request_id));
  return {
    schema: MANDATE_MEETINGS_SCHEMA,
    method: MANDATE_MEETINGS_METHOD,
    status: edges.length ? "matched" : "empty",
    agency_id: identity.canonical_id,
    agency_name: identity.canonical_name,
    subject_ref: `agency:id:${identity.canonical_id}`,
    relation: MANDATE_MEETING_EDGE_TYPE,
    resolution_run: resolutionRun,
    counts: { mandates: matchedMandates.size, meetings: matchedMeetings.size, edges: edges.length },
    edges,
    share_path: agencyMandateMeetingsPath(identity.canonical_id),
    meetings_browse_href: agencyMeetingsBrowseHref(identity.canonical_id),
    mandates_follow_href: agencyObligationsFollowHref(identity.canonical_id),
    meetings_follow_href: agencyMeetingsFollowHref(identity.canonical_id),
  };
}

export function renderMandateMeetingsSection(view) {
  if (!view || view.status !== "matched" || !view.edges?.length) return "";
  const groups = new Map();
  for (const edge of view.edges) {
    const id = edge.mandate.mandate_id;
    if (!groups.has(id)) groups.set(id, { mandate: edge.mandate, edges: [] });
    groups.get(id).edges.push(edge);
  }
  const list = [...groups.values()].map(({ mandate, edges }) => {
    const source = mandate.source_href
      ? ` · <a href="${esc(mandate.source_href)}" rel="noopener">Source law</a>`
      : "";
    const meetings = edges.map((edge) => {
      const why = renderWhyBelieveControl(edge.claim);
      return `<li class="node-record mandate-meeting-record" data-mandate-meeting-edge="${esc(edge.entity_link.id)}" data-edge-claim-row="${esc(edge.claim?.claim_id || edge.entity_link.id)}">
        <div class="node-record-main"><a data-subject-ref="${esc(edge.meeting.subject_ref)}" href="${esc(edge.meeting.href)}">${esc(edge.meeting.label)}</a>${why ? ` ${why}` : ""}</div>
        ${edge.meeting.date ? `<span class="muted node-muted">City Record · ${esc(edge.meeting.date)}</span>` : ""}
      </li>`;
    }).join("");
    return `<li class="node-record mandate-meetings-mandate" data-mandate-id="${esc(mandate.mandate_id)}">
      <div class="node-record-main">${esc(mandate.duty_text)}</div>
      ${mandate.citation || source ? `<span class="muted node-muted">${esc(mandate.citation || "")}${source}</span>` : ""}
      <ul class="node-record-list mandate-meeting-records">${meetings}</ul>
    </li>`;
  }).join("");
  const actions = [
    `<a class="node-action civic-object-action" href="${esc(view.meetings_browse_href)}">Open meetings and hearings</a>`,
    `<a class="node-action civic-object-action" href="${esc(view.mandates_follow_href)}">Watch mandates</a>`,
    `<a class="node-action civic-object-action" href="${esc(view.meetings_follow_href)}">Follow meetings and hearings</a>`,
    `<a class="node-action civic-object-action" href="${esc(view.share_path)}">Share this view</a>`,
  ].join("");
  return `<section id="mandates-meetings" class="node-section node-card civic-object-section mandate-meetings" data-agency-constellation-card="mandate-meetings" data-method="${esc(view.method)}" data-status="matched" data-export-class="object_members">
    <h2>Mandates · Meetings and hearings <span class="muted node-muted">(${view.counts.mandates} mandate${view.counts.mandates === 1 ? "" : "s"} · ${view.counts.meetings} event${view.counts.meetings === 1 ? "" : "s"})</span></h2>
    <ul class="node-record-list mandate-meetings-list">${list}</ul>
    <p class="node-inline-actions civic-object-inline-actions">${actions}</p>
  </section>`;
}
