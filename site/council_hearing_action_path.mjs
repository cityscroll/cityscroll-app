import { buildActionPath } from "./action_path_v0.mjs";
import { projectCouncilHearingMatterContinuation, STRICT_COUNCIL_MEETING_JOIN_METHOD } from "./council_hearing_matter_continuation.mjs";

/** Stated when an exact matter has no reachable record to open yet. */
export const MATTER_RECORD_UNAVAILABLE_LABEL = "Matter record not available";

function text(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function actionFor(record) {
  const participation = record?.participation || {};
  const destination = (Array.isArray(participation.links) ? participation.links : [])
    .map((link) => link?.url || link?.href)
    .map(httpsUrl)
    .find(Boolean);
  if (destination) {
    return {
      type: "attend",
      delivery: "official_handoff",
      destination,
      destination_label: "Council hearing information",
      confirmation_required: false,
      deadline: record.event_date || null,
    };
  }
  return {
    type: "document",
    delivery: "local",
    destination: null,
    confirmation_required: false,
    deadline: null,
  };
}

/** Compose the strict outcome relation at the landed Action Path boundary. */
export function buildCouncilHearingActionPath(record = {}, outcome = null) {
  const projection = projectCouncilHearingMatterContinuation(record, outcome);
  const meetingRef = text(record?.meeting_id);
  if (!meetingRef) return null;
  const evidence = [{
    source_ref: meetingRef,
    source_url: httpsUrl(record?.source_url),
    basis: projection.strict_join ? "strict Council meeting/outcome join" : "no exact Council meeting/outcome join",
    receipt_ref: projection.strict_join
      ? `meeting-outcomes:${STRICT_COUNCIL_MEETING_JOIN_METHOD}`
      : "meeting-outcomes:unmatched",
  }];
  const input = {
    subject_ref: meetingRef,
    target_ref: meetingRef,
    action: actionFor(record),
    evidence,
  };
  if (projection.state === "single") {
    const [matter] = projection.matters;
    input.process_ref = matter.subject_ref;
    // The continuation names where the reader is taken, resolved by the one
    // availability rule. It is a navigation label, not a promise that anything
    // was saved on the reader's behalf.
    input.continuation = {
      kind: "subject",
      subject_ref: matter.subject_ref,
      label: matter.destination.label || MATTER_RECORD_UNAVAILABLE_LABEL,
      reason: "This hearing has an exact Council matter join.",
    };
  } else if (projection.state === "multiple") {
    input.continuation = {
      label: "Choose a matter to open",
      reason: "This hearing has multiple exact matter joins.",
      candidates: projection.matters.map((matter) => ({
        kind: "subject",
        subject_ref: matter.subject_ref,
      })),
    };
  }
  return buildActionPath(input);
}
