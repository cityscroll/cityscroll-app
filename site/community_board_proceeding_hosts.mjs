/**
 * Proceeding-host projection for Community Board meetings.
 *
 * Convening body and proceeding form are orthogonal facts. This module keeps
 * the small resident-facing projection separate from the source join that
 * establishes whether the meeting is published and belongs to a board.
 */

export const COMMUNITY_BOARD_PROCEEDING_HOSTS_SCHEMA = "cityscroll.community_board_proceeding_hosts.v1";

export const COMMUNITY_BOARD_PROCEEDING_FORMS = Object.freeze([
  "meeting",
  "public_hearing",
  "special_meeting",
  "unknown",
]);

function text(value) {
  return String(value ?? "").trim();
}

function proceedingForm(value) {
  const normalized = text(value).toLowerCase();
  return COMMUNITY_BOARD_PROCEEDING_FORMS.includes(normalized) ? normalized : "unknown";
}

function boardRef(edge = {}) {
  return text(edge.institution_refs?.board_ref || edge.parent_board_ref)
    || (/^community-board:[^:]+(?:-[^:]+)*-cb-\d{2}$/.test(text(edge.from)) ? text(edge.from) : null);
}

function hostKind(hostRef) {
  if (hostRef.startsWith("community-board-committee:")) return "community-board-committee";
  if (hostRef.startsWith("community-board:")) return "community-board";
  return null;
}

/**
 * Project one accepted hosts_meeting edge without changing the meeting id.
 * Held edges remain explicit unknowns and never become resident-facing hosts.
 */
export function projectCommunityBoardProceedingHost(edge = {}, meeting = {}) {
  const hostRef = text(edge.from);
  const meetingId = text(edge.to || meeting.meeting_id);
  const kind = hostKind(hostRef);
  const accepted = edge.promoted === true || edge.status === "promoted" || edge.status === "official";
  if (!hostRef || !meetingId || !kind || !accepted) {
    return {
      schema: COMMUNITY_BOARD_PROCEEDING_HOSTS_SCHEMA,
      status: "unknown",
      meeting_id: meetingId || null,
      host_ref: hostRef || null,
      host_kind: kind,
      proceeding_form: proceedingForm(meeting.proceeding_form || meeting.meeting_family),
      institution_refs: boardRef(edge) ? { board_ref: boardRef(edge) } : {},
      provenance: edge.provenance || null,
    };
  }
  const refs = {
    ...(boardRef(edge) ? { board_ref: boardRef(edge) } : {}),
    ...(text(edge.institution_refs?.committee_ref || edge.committee_ref)
      ? { committee_ref: text(edge.institution_refs?.committee_ref || edge.committee_ref) }
      : {}),
  };
  return {
    schema: COMMUNITY_BOARD_PROCEEDING_HOSTS_SCHEMA,
    status: "accepted",
    meeting_id: meetingId,
    host_ref: hostRef,
    host_kind: kind,
    host_name: text(edge.committee_name || edge.target_name) || null,
    parent_board_ref: refs.board_ref || null,
    institution_refs: refs,
    proceeding_form: proceedingForm(meeting.proceeding_form || meeting.meeting_family),
    provenance: edge.provenance || null,
  };
}

/** Return the accepted convening-body projections for one meeting row. */
export function projectCommunityBoardProceedingHosts(edges = [], meeting = {}) {
  return (Array.isArray(edges) ? edges : [])
    .filter((edge) => edge?.relation === "hosts_meeting" || edge?.edge_type === "hosts_meeting")
    .map((edge) => projectCommunityBoardProceedingHost(edge, meeting))
    .filter((host) => host.status === "accepted");
}

