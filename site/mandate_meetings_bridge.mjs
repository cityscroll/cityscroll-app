/** Mandates → meetings/hearings cross-entity edges for agency constellations. */

import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { agencyObligationsFollowHref } from "./agency_obligations.mjs";
import { followingUrlFromWatch } from "./following_view.mjs";
import {
  buildEdgeProvenanceClaim,
  renderWhyBelieveControl,
} from "./graph_edge_provenance.mjs";
import { contentTokens } from "./process_conformance.mjs";
import { canonicalizeBrowseUrl } from "./route_migration.mjs";
import { mandateSubjectRef } from "./mandate_subject_ref.mjs";
import {
  DEFAULT_CROSS_SPINE_EDGE_POLICY,
  routeCrossSpineEdge,
} from "../entity_resolution/cross_domain/edge_policy.mjs";
import {
  emptyScope,
  normalizeScope,
  routeHashFromScope,
  scopeWithEntity,
} from "./scope_v0.mjs";

export const MANDATE_MEETINGS_SCHEMA = "cityscroll.mandate_meetings.v2";
export const MANDATE_MEETINGS_METHOD = "mandate_meeting_subject_temporal_v2";
export const MANDATE_MEETINGS_MATCHER_VERSION = "v2";
export const MANDATE_MEETING_EDGE_TYPE = "requires_public_hearing";
export const MANDATE_MEETING_MIN_PRECISION = 0.9;

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

function normalizedId(value) {
  return clean(value, 120).toLowerCase();
}

function firstValue(...values) {
  return values.find((value) => clean(value, 500)) || null;
}

function mandateSubjectText(mandate) {
  return firstValue(
    mandate.matter_body_subject,
    mandate.body_subject,
    mandate.subject,
    mandate.matter?.subject,
    mandate.duty_text,
    mandate.citation,
  );
}

function meetingSubjectText(row) {
  return firstValue(
    row.matter_body_subject,
    row.body_subject,
    row.matter?.subject,
    row.subject,
    row.body,
    row.description,
    row.short_title || row.title || row.label,
  );
}

function temporalEvidence(mandate, meeting) {
  const explicit = meeting.temporal_compatible
    ?? meeting.temporal?.compatible
    ?? meeting.temporal_evidence?.compatible;
  if (typeof explicit === "boolean") {
    return {
      compatible: explicit,
      method: "publisher_temporal_compatibility",
      meeting_date: meeting.date,
    };
  }

  const meetingDate = datePart(meeting.date);
  const lower = datePart(firstValue(
    mandate.temporal_window?.start,
    mandate.temporal?.start,
    mandate.effective_date,
    mandate.start_date,
  ));
  const upper = datePart(firstValue(
    mandate.temporal_window?.end,
    mandate.temporal?.end,
    mandate.deadline?.computed_date,
    mandate.end_date,
  ));
  if (!meetingDate || (!lower && !upper)) {
    return { compatible: false, method: null, meeting_date: meetingDate, window: { start: lower, end: upper } };
  }
  if (lower && meetingDate < lower) {
    return { compatible: false, method: "mandate_temporal_window_v1", meeting_date: meetingDate, window: { start: lower, end: upper } };
  }
  if (upper && meetingDate > upper) {
    return { compatible: false, method: "mandate_temporal_window_v1", meeting_date: meetingDate, window: { start: lower, end: upper } };
  }
  return { compatible: true, method: "mandate_temporal_window_v1", meeting_date: meetingDate, window: { start: lower, end: upper } };
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
      temporal_compatible: row.temporal_compatible
        ?? row.temporal?.compatible
        ?? row.temporal_evidence?.compatible
        ?? null,
      temporal: row.temporal || row.temporal_evidence || null,
      matter_id: clean(row.matter_id || row.matter?.id, 120) || null,
      subject_fields: [
        row.matter_body_subject || row.body_subject ? "body_subject" : null,
        row.matter?.subject ? "matter.subject" : null,
        row.subject ? "subject" : null,
        row.body ? "body" : null,
        row.description ? "description" : null,
        row.short_title || row.title || row.label ? "short_title" : null,
      ].filter(Boolean),
      href: clean(row.href, 240) || `/notices/${encodeURIComponent(requestId)}`,
      source_system: clean(row.source_system, 80) || "city_record",
      agency_name: identity.canonical_name,
      subject_scope_tokens: scopeTokens(meetingSubjectText(row)),
    });
  }
  return out.sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")));
}

function matchedScope(mandate, candidate) {
  const mandateScope = scopeTokens(mandateSubjectText(mandate));
  const subjectScope = new Set(candidate.subject_scope_tokens || []);
  const shared = mandateScope.filter((token) => subjectScope.has(token));
  return shared.length >= 2 ? shared : [];
}

function publicationGate(source) {
  const row = source?.gate?.mandate_meeting
    || source?.gates?.mandate_meeting
    || source?.mandate_meeting
    || source
    || null;
  const precision = Number(row?.precision);
  const minPrecision = Number(row?.min_precision ?? MANDATE_MEETING_MIN_PRECISION);
  const passed = (row?.passed === true || row?.status === "pass")
    && Number.isFinite(precision)
    && Number.isFinite(minPrecision)
    && precision >= MANDATE_MEETING_MIN_PRECISION
    && precision >= minPrecision;
  return {
    status: passed ? "pass" : (row?.status || "insufficient"),
    precision: Number.isFinite(precision) ? precision : null,
    min_precision: Number.isFinite(minPrecision) ? minPrecision : MANDATE_MEETING_MIN_PRECISION,
    passed,
    gold_version: clean(source?.gold_version || row?.gold_version, 120) || null,
    eval_version: clean(source?.eval_version || row?.eval_version, 120) || null,
  };
}

function crossSpinePolicy(gate) {
  return {
    ...DEFAULT_CROSS_SPINE_EDGE_POLICY,
    gates: {
      ...DEFAULT_CROSS_SPINE_EDGE_POLICY.gates,
      mandate_meeting: {
        status: gate.passed ? "pass" : (gate.status || "insufficient"),
        min_precision: gate.min_precision,
        precision: gate.precision,
      },
    },
  };
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
  const gate = publicationGate(sources.crossSpineGate);
  const edgePolicy = crossSpinePolicy(gate);
  const runId = `resolution-run:mandate-meeting:${stablePart(identity.canonical_id)}:${stablePart(sources.generatedAt || sources.meetingsDomain?.generated_at || "current")}`;
  const resolutionRun = Object.freeze({
    id: runId,
    method: MANDATE_MEETINGS_METHOD,
    matcher_version: MANDATE_MEETINGS_MATCHER_VERSION,
    entity_type: "mandate_meeting",
    scope_note: "agency+event_kind+matter_body_subject+temporal",
    publication_gate: gate,
    status: "complete",
  });
  const edges = [];
  const shadowEdges = [];
  const perMandateLimit = Math.max(1, Math.min(Number(sources.perMandateLimit) || 3, 8));

  for (const mandate of mandates) {
    const mandateRef = mandateSubjectRef(mandate.obligation_id);
    if (!mandateRef) continue;
    let matched = 0;
    for (const meeting of candidates) {
      const subjectScope = matchedScope(mandate, meeting);
      const temporal = temporalEvidence(mandate, meeting);
      const mandateMatterId = clean(mandate.matter_id || mandate.source?.matter_id, 120) || null;
      const matterExact = Boolean(mandateMatterId && meeting.matter_id
        && normalizedId(mandateMatterId) === normalizedId(meeting.matter_id));
      const evidence = {
        keys: ["agency", "event_kind", "matter_body_subject", "temporal"],
        agency_id: identity.canonical_id,
        event_kind: meeting.event_kind,
        matter_id: mandateMatterId,
        meeting_matter_id: meeting.matter_id,
        matter_exact: matterExact,
        subject_scope: subjectScope,
        subject_scope_overlap: subjectScope,
        body_subject_overlap: subjectScope,
        subject_fields: meeting.subject_fields,
        temporal_compatible: temporal.compatible,
        temporal,
      };
      const route = routeCrossSpineEdge({
        relation: "mandate_meeting",
        features: {
          agency_exact: true,
          event_kind_match: Boolean(meeting.event_kind),
          subject_scope_overlap: subjectScope,
          temporal_compatible: temporal.compatible,
        },
        evidence,
        provenance: {
          source_system: meeting.source_system,
          source_record_id: `city_record:${meeting.request_id}`,
        },
      }, { policy: edgePolicy });
      const publicCandidate = route.tier === "public_inferred";
      const missing = [];
      if (!subjectScope.length) missing.push("matter_body_subject");
      if (!temporal.compatible) missing.push("temporal");
      if (!gate.passed) missing.push("held_out_precision_gate");
      const linkId = `entity-link:mandate-meeting:${stablePart(mandate.obligation_id)}:${stablePart(meeting.request_id)}`;
      const entityLink = {
        id: linkId,
        source_record_id: mandateRef,
        canonical_entity_id: meeting.subject_ref,
        decision: publicCandidate ? "auto_link" : "evidence_only",
        confidence: publicCandidate ? 0.9 : null,
        tier: route.tier,
        tier_reason: route.reason,
        method: MANDATE_MEETINGS_METHOD,
        matcher_version: MANDATE_MEETINGS_MATCHER_VERSION,
        resolution_run_id: runId,
        review_status: publicCandidate ? "auto_inferred" : null,
        evidence,
      };
      const item = {
        id: `${mandate.obligation_id}:${meeting.request_id}`,
        subject_ref: meeting.subject_ref,
        root_ref: mandateRef,
        label: meeting.label,
        href: meeting.href,
        relation: MANDATE_MEETING_EDGE_TYPE,
        confidence: publicCandidate ? "strong" : "evidence_only",
        decision: publicCandidate ? entityLink.decision : "evidence_only",
        edge_policy: {
          tier: route.tier,
          reason: route.reason,
          policy_version: route.policy_version,
          evidence: route.evidence,
        },
        method: MANDATE_MEETINGS_METHOD,
        entity_link_id: linkId,
        resolution_run_id: runId,
        date: meeting.date,
        provenance: {
          source_system: meeting.source_system,
          source_record_id: `city_record:${meeting.request_id}`,
          source_fields: ["agency_name", "type_of_notice_description", ...meeting.subject_fields, "event_date"],
          input_value: subjectScope.join(", "),
          observed_at: meeting.date,
          basis: "agency+event_kind+matter_body_subject+temporal",
          source_excerpt: meeting.label,
        },
      };
      if (!publicCandidate) {
        shadowEdges.push({
          id: item.id,
          mandate: item.root_ref,
          meeting,
          match: evidence,
          entity_link: { ...entityLink, decision: "evidence_only", review_status: null },
          decision: "evidence_only",
          reason: missing.length ? missing : [route.reason],
        });
        continue;
      }
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
          subject_ref: mandateRef,
          duty_text: clean(mandate.duty_text, 500),
          citation: clean(mandate.citation, 200) || null,
          source_href: clean(mandate.source?.legistar_url || mandate.href, 400) || null,
        },
        meeting,
        match: entityLink.evidence,
        entity_link: entityLink,
        edge_policy: item.edge_policy,
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
    publication_gate: gate,
    counts: {
      mandates: matchedMandates.size,
      meetings: matchedMeetings.size,
      edges: edges.length,
      shadow_edges: shadowEdges.length,
    },
    edges,
    shadow_edges: shadowEdges,
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
      ? ` · ${officialSourceLink({ href: mandate.source_href, label: "Source law", className: "agency-source-link", escape: esc })}`
      : "";
    const meetings = edges.map((edge) => {
      const why = renderWhyBelieveControl(edge.claim);
      return `<li class="node-record mandate-meeting-record" data-mandate-meeting-edge="${esc(edge.entity_link.id)}" data-edge-claim-row="${esc(edge.claim?.claim_id || edge.entity_link.id)}">
        <div class="node-record-main">${constellationLink({ href: edge.meeting.href, label: edge.meeting.label, className: "agency-edge-link", attributes: { "data-subject-ref": edge.meeting.subject_ref }, escape: esc })}${why ? ` ${why}` : ""}</div>
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
