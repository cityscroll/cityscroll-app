/**
 * Refresh helpers for the grounded Community Board people artifact.
 *
 * The public artifact stays a reviewed, board-local pilot. Refresh re-fetches
 * the official roster page and rebuilds only relationships the page still
 * evidences with exact names and role tags.
 */

export const COMMUNITY_BOARD_PEOPLE_SCHEMA = "cityscroll.community_board_people.v1";
export const MANHATTAN_CB06_ROSTER_URL = "https://cbsix.org/about-us/board-members-and-staff/";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

export function publisherPersonIdFromName(name) {
  const slug = clean(name, 240)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

function decodeEntities(value) {
  return clean(value)
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

/**
 * Parse the CB6 WordPress roster into sectioned member cards.
 * Sections are h2 headings; cards use members_box_title + tags spans.
 */
export function parseCbsixRosterHtml(html) {
  const source = String(html || "");
  const sectionMatches = [...source.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  const sections = [];
  for (let index = 0; index < sectionMatches.length; index += 1) {
    const match = sectionMatches[index];
    const title = decodeEntities(match[1].replace(/<[^>]+>/g, " "));
    const start = match.index + match[0].length;
    const end = index + 1 < sectionMatches.length ? sectionMatches[index + 1].index : source.length;
    const body = source.slice(start, end);
    const members = [];
    for (const card of body.matchAll(/members_box_item[\s\S]*?members_box_title[^>]*>([\s\S]*?)<\/div>[\s\S]*?<div class="tags">([\s\S]*?)<\/div>/gi)) {
      const name = decodeEntities(card[1].replace(/<[^>]+>/g, " "));
      const tags = [...card[2].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
        .map((tag) => decodeEntities(tag[1].replace(/<[^>]+>/g, " ")))
        .filter(Boolean);
      if (name) members.push({ name, tags });
    }
    if (title) sections.push({ title, members });
  }
  return { sections };
}

function sectionMembers(parsed, title) {
  const needle = clean(title).toLowerCase();
  return parsed.sections.find((section) => section.title.toLowerCase() === needle)?.members || [];
}

function memberWithTag(members, tag) {
  const needle = clean(tag).toLowerCase();
  return members.find((member) => member.tags.some((value) => value.toLowerCase() === needle)) || null;
}

function sourceDocument({ sourceUrl, observedOn, observedAt, contentSha256 = null }) {
  return {
    publisher_document_id: `cb6-board-members-and-staff-${observedOn}`,
    document_url: sourceUrl,
    date: observedOn,
    observed_receipt: {
      status: "ok",
      observed_at: observedAt,
      ...(contentSha256 ? { content_sha256: contentSha256 } : {}),
    },
  };
}

function relationship({
  personName,
  relation,
  role,
  observedOn,
  sourceDocument: document,
  committeeRef = null,
}) {
  const publisherPersonId = publisherPersonIdFromName(personName);
  if (!publisherPersonId) throw new Error(`unable to derive publisher_person_id for ${personName}`);
  return {
    publisher_person_id: publisherPersonId,
    person_name: personName,
    relation,
    role,
    ...(committeeRef ? { committee_ref: committeeRef } : {}),
    relation_date: observedOn,
    valid_from: observedOn,
    source_document: document,
  };
}

/**
 * Rebuild the grounded manhattan-cb-06 people pilot from a live roster capture.
 * Requires the same four role evidences the committed artifact publishes.
 */
export function buildCommunityBoardPeopleFromRosterCapture({
  html,
  sourceUrl = MANHATTAN_CB06_ROSTER_URL,
  observedAt,
  contentSha256 = null,
  boardId = "manhattan-cb-06",
} = {}) {
  const observedInstant = clean(observedAt, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(observedInstant)) {
    throw new Error("buildCommunityBoardPeopleFromRosterCapture requires an ISO observedAt");
  }
  const observedOn = observedInstant.slice(0, 10);
  const parsed = parseCbsixRosterHtml(html);
  const officers = sectionMembers(parsed, "Board Officers");
  const chairs = sectionMembers(parsed, "Committee Chairs");
  const publicMembers = sectionMembers(parsed, "Public Members");
  const staff = sectionMembers(parsed, "Board Staff");

  const boardChair = memberWithTag(officers, "Chair");
  const transportationChair = memberWithTag(chairs, "Transportation");
  const transportationPublic = memberWithTag(publicMembers, "Transportation");
  const districtManager = memberWithTag(staff, "District Manager");

  const missing = [];
  if (!boardChair) missing.push("Board Officers/Chair");
  if (!transportationChair) missing.push("Committee Chairs/Transportation");
  if (!transportationPublic) missing.push("Public Members/Transportation");
  if (!districtManager) missing.push("Board Staff/District Manager");
  if (missing.length) {
    throw new Error(`roster capture missing required role evidence: ${missing.join(", ")}`);
  }

  const document = sourceDocument({
    sourceUrl,
    observedOn,
    observedAt: observedInstant,
    contentSha256,
  });
  const committeeRef = `community-board-committee:${boardId}:transportation`;
  const relationships = [
    relationship({
      personName: boardChair.name,
      relation: "member_of",
      role: "board_chair",
      observedOn,
      sourceDocument: document,
    }),
    relationship({
      personName: boardChair.name,
      relation: "chairs",
      role: "board_chair",
      observedOn,
      sourceDocument: document,
    }),
    relationship({
      personName: transportationChair.name,
      relation: "chairs",
      role: "committee_chair",
      observedOn,
      sourceDocument: document,
      committeeRef,
    }),
    relationship({
      personName: transportationPublic.name,
      relation: "member_of",
      role: "public_committee_member",
      observedOn,
      sourceDocument: document,
      committeeRef,
    }),
    relationship({
      personName: districtManager.name,
      relation: "staffed_by",
      role: "district_manager",
      observedOn,
      sourceDocument: document,
    }),
  ];

  return {
    schema: COMMUNITY_BOARD_PEOPLE_SCHEMA,
    observed_on: observedOn,
    policy: {
      identity: "community-board-person:{board_id}:{publisher_person_id|reviewed_local_id}",
      same_name_never_merges_identity: true,
      council_official_identity_never_inferred: true,
      roles_are_temporal_and_separate: true,
    },
    boards: {
      [boardId]: { relationships },
    },
  };
}
