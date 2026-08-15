/**
 * Publication-to-object projection taxonomy.
 *
 * A City Record notice is evidence that something was published. It becomes a
 * link to another civic object only when that object's identity is stable. A
 * mandate route has the stricter deontic-object gate: exact id, warrant,
 * subject, required action, and a trigger/deadline.
 */

import { canonicalMandateId } from "./mandate_subject_ref.mjs";

export const NOTICE_OBJECT_LINK_SCHEMA = "cityscroll.notice_object_link.v1";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function noticeId(value) {
  const id = clean(value, 100).replace(/^notice:/i, "");
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

function stableObjectId(value, max = 160) {
  const id = clean(value, max);
  return id && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id) ? id : null;
}

function safeCanonicalHref(value) {
  const href = clean(value, 500);
  if (!href || href.startsWith("//")) return null;
  return href.startsWith("/") || /^https:\/\//i.test(href) ? href : null;
}

export function mandateDocumentPath(value) {
  const id = canonicalMandateId(value);
  return id ? `/mandates/${encodeURIComponent(id)}` : null;
}

export function noticeEvidenceTarget(value) {
  const id = noticeId(value);
  return id ? {
    kind: "notice",
    id,
    href: `/notices/${encodeURIComponent(id)}`,
    label: "Notice evidence",
  } : null;
}

function mandateDeadline(row) {
  const deadline = row?.deadline && typeof row.deadline === "object" ? row.deadline : {};
  const kind = clean(deadline.kind || row?.deadline_kind, 80).toLowerCase();
  const date = clean(deadline.computed_date || deadline.date || row?.deadline_date, 80);
  const text = clean(deadline.text || row?.deadline_text, 300);
  const trigger = clean(row?.trigger || row?.trigger_text || row?.condition, 300);
  const recurrence = clean(row?.recurrence, 80).toLowerCase();
  return {
    kind: kind && kind !== "none" ? kind : null,
    date: date || null,
    text: text || null,
    trigger: trigger || null,
    recurrence: recurrence && recurrence !== "none" ? recurrence : null,
  };
}

/**
 * Resolve a first-class mandate only after every deontic-object component is
 * present. Returns null for partial claims; callers must not invent a route.
 */
export function mandateObjectTarget(row = {}) {
  const id = canonicalMandateId(
    row.mandate_id || row.obligation_id || row.id || row.subject_ref,
  );
  const duty = clean(row.duty_text || row.required_action || row.expected_event, 700);
  const subject = clean(
    row.agency_id || row.agency_name || row.subject_id || row.subject_name || row.actor,
    200,
  );
  const citation = clean(row.citation || row.source?.citation, 240);
  const sourceHref = safeCanonicalHref(
    row.source_href || row.source?.legistar_url || row.source?.law_text_url,
  );
  const matterId = clean(row.matter_id || row.source?.matter_id, 80);
  const temporal = mandateDeadline(row);
  const hasWarrant = Boolean(citation || sourceHref || matterId);
  const hasTemporal = Boolean(
    temporal.kind || temporal.date || temporal.text || temporal.trigger || temporal.recurrence,
  );
  if (!id || !duty || !subject || !hasWarrant || !hasTemporal) return null;
  return {
    kind: "mandate",
    id,
    href: mandateDocumentPath(id),
    label: `Mandate · ${duty}`,
  };
}

function contractAwardNotice(row = {}) {
  const section = clean(row.section_name || row.type_of_notice_description, 160).toLowerCase();
  return section === "public comment on contract awards"
    || /public comment.+contract award/.test(section);
}

function contractIdentifiers(row = {}) {
  const direct = [row.epin, row.e_pin, row.contract_id, row.pin]
    .map((value) => clean(value, 160).toUpperCase())
    .filter((value) => /^[A-Z0-9][A-Z0-9-]{5,79}$/.test(value));
  const body = [
    row.additional_description_1,
    row.additional_description_2,
    row.additional_description_3,
    row.description,
  ].map((value) => clean(value, 12_000)
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160|#xa0);|\u00a0/gi, " ")
    .replace(/\s+/g, " "))
    .join(" ");
  const extracted = [...body.matchAll(/\bE[\s-]*PIN\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,79})\b/gi)]
    .map((match) => match[1].toUpperCase());
  return [...new Set([...direct, ...extracted])];
}

export function procurementObjectTarget(value, { label = null } = {}) {
  const id = stableObjectId(value);
  if (!id) return null;
  const query = new URLSearchParams({ mode: "award", q: id });
  return {
    kind: "procurement",
    id,
    href: `/browse/contracts/?${query.toString()}`,
    label: clean(label, 240) || `Contract award · ${id}`,
  };
}

function explicitTypedObject(row = {}) {
  const object = row.typed_object || row.object_target || null;
  if (!object || typeof object !== "object") return null;
  const kind = clean(object.kind || object.target_kind, 80).toLowerCase();
  const id = stableObjectId(object.id || object.target_id || object.subject_ref);
  const href = safeCanonicalHref(object.canonical_href || object.href);
  const allowed = new Set(["procurement", "contract", "meeting", "zoning", "land-use project", "rulemaking", "rule", "report"]);
  if (!allowed.has(kind) || !id || !href || object.identity_stable !== true) return null;
  return {
    kind,
    id,
    href,
    label: clean(object.label, 240) || `${kind} · ${id}`,
  };
}

/** Typed non-mandate target, only from exact publisher identifiers. */
export function typedNoticeObjectTarget(row = {}) {
  const explicit = explicitTypedObject(row);
  if (explicit) return explicit;

  if (contractAwardNotice(row)) {
    const ids = contractIdentifiers(row);
    if (ids.length !== 1) return null;
    return procurementObjectTarget(ids[0]);
  }

  const meetingId = stableObjectId(row.meeting_id || row.canonical_meeting_id, 320);
  if (meetingId) {
    return {
      kind: "meeting",
      id: meetingId,
      href: `/meetings/${encodeURIComponent(meetingId)}`,
      label: `Meeting · ${clean(row.meeting_title || row.short_title || meetingId, 240)}`,
    };
  }

  const projectId = stableObjectId(row.project_id || row.ulurp_number, 80);
  if (projectId) {
    return {
      kind: "zoning",
      id: projectId,
      href: `/browse/zoning/?q=${encodeURIComponent(projectId)}`,
      label: `Land-use project · ${clean(row.project_name || projectId, 240)}`,
    };
  }
  return null;
}

/**
 * Select the primary civic object for a notice. The notice remains a distinct
 * evidence target even when another object is matched.
 */
export function projectNoticeObjectTarget(row = {}, { mandate = null } = {}) {
  const evidence = noticeEvidenceTarget(
    row.request_id || row.requestId || row.notice_id || row.subject_ref,
  );
  if (!evidence) {
    return { schema: NOTICE_OBJECT_LINK_SCHEMA, state: "unknown", target: null, evidence: null };
  }
  const typed = typedNoticeObjectTarget(row);
  if (typed) {
    return { schema: NOTICE_OBJECT_LINK_SCHEMA, state: "matched", target: typed, evidence };
  }
  const mandateTarget = mandateObjectTarget(mandate || row.mandate || {});
  if (mandateTarget) {
    return { schema: NOTICE_OBJECT_LINK_SCHEMA, state: "matched", target: mandateTarget, evidence };
  }
  return { schema: NOTICE_OBJECT_LINK_SCHEMA, state: "notice_only", target: evidence, evidence };
}
