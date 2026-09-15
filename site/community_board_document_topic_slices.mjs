/**
 * Deterministic topic slices over retained official Community Board documents.
 *
 * This is a materializer, not an acquisition client: callers pass the
 * inventoried documents already retained by the site. Unsupported, unreadable,
 * and non-official records remain in coverage and never become civic silence.
 */

export const COMMUNITY_BOARD_DOCUMENT_TOPIC_SLICES_SCHEMA =
  "cityscroll.community_board_document_topic_slices.v1";
export const COMMUNITY_BOARD_DOCUMENT_TOPIC_SLICE_SCHEMA =
  "cityscroll.community_board_document_topic_slice.v1";

export const COMMUNITY_BOARD_DOCUMENT_ACTION_TYPES = Object.freeze([
  "mention",
  "public_testimony",
  "committee_recommendation",
  "chair_action",
  "member_action",
  "formal_board_action",
]);

export const OFFICIAL_BOARD_DOCUMENT_SOURCE_ROLES = Object.freeze([
  "minutes",
  "agenda",
  "committee_recommendation",
  "testimony",
  "chair_statement",
  "member_statement",
  "formal_vote",
  "resolution",
  "official_board_statement",
]);

const FORMAL_ROLES = new Set(["formal_vote", "resolution", "official_board_statement"]);
const FORMAL_STANCE_EVIDENCE_ROLES = new Set([
  "committee_recommendation",
  "formal_vote",
  "resolution",
  "official_board_statement",
]);
const FORMAL_STANCES = new Set(["support", "opposition"]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const BOARD_ID = /^(bronx|brooklyn|manhattan|queens|staten-island)-cb-(\d{2})$/;
const clean = (value, max = 600) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const date = (value) => { const v = clean(value, 10); return ISO_DAY.test(v) ? v : null; };
const url = (value) => { const v = clean(value, 2_000); return /^https:\/\/[^\s<>"']+$/.test(v) ? v : null; };
const href = (value) => { const v = clean(value, 2_000); return v.startsWith("/") && !v.startsWith("//") ? v : null; };
const slug = (value) => clean(value, 180).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document";
const escapeHtml = (value) => clean(value, 4_000).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));

const ACTION_LABELS = Object.freeze({
  mention: "Mention",
  public_testimony: "Public testimony",
  committee_recommendation: "Committee recommendation",
  chair_action: "Chair action (individual)",
  member_action: "Member action (individual)",
  formal_board_action: "Formal board action",
});

function boardInfo(value) {
  const boardId = clean(value, 100).toLowerCase();
  const match = boardId.match(BOARD_ID);
  if (!match) return null;
  return { board_id: boardId, board_name: `Community Board ${Number(match[2])}`, borough: match[1], district: Number(match[2]) };
}

function sourceRole(row) {
  return clean(row.source_role || row.source_kind || row.document_role || row.role, 80).toLowerCase();
}

function documentText(row) {
  return clean(row.text || row.excerpt || row.body || row.extracted_text || row.accepted_excerpt, 20_000);
}

function matchesFor(text, aliases) {
  const lower = text.toLocaleLowerCase("en-US");
  return aliases.flatMap((group) => group.terms
    .filter((term) => lower.includes(term.toLocaleLowerCase("en-US")))
    .map((term) => ({ alias_group: group.id, term })));
}

function actionFor(role, row) {
  if (FORMAL_ROLES.has(role)) return "formal_board_action";
  if (role === "committee_recommendation") return "committee_recommendation";
  if (role === "testimony") return "public_testimony";
  if (role === "chair_statement") return "chair_action";
  if (role === "member_statement") return "member_action";
  // A retained vote/resolution/statement is the formal evidence boundary;
  // wording alone, including a chair's wording, cannot upgrade a passage.
  if (row.formal_evidence === true && row.board_action === true) return "formal_board_action";
  return "mention";
}

function formalStanceFor(role, row) {
  const stance = clean(row.formal_stance || row.stance || row.position, 40).toLowerCase();
  if (!FORMAL_STANCES.has(stance)) return null;
  const retainedEvidence = FORMAL_STANCE_EVIDENCE_ROLES.has(role)
    || (row.formal_evidence === true && row.board_action === true);
  return retainedEvidence ? stance : null;
}

function excerpt(text, matchedTerm) {
  if (!text || !matchedTerm) return null;
  if (text.length <= 320) return text;
  const lower = text.toLocaleLowerCase("en-US");
  const at = lower.indexOf(matchedTerm.toLocaleLowerCase("en-US"));
  const start = Math.max(0, (at < 0 ? 0 : at) - 120);
  return `${start ? "…" : ""}${text.slice(start, start + 320)}${start + 320 < text.length ? "…" : ""}`;
}

function normalizeAliases(input) {
  return Object.freeze((Array.isArray(input) ? input : [])
    .map((group, index) => ({
      id: clean(group?.id, 100) || `alias-${index + 1}`,
      terms: [...new Set((Array.isArray(group?.terms) ? group.terms : [group?.term])
        .map((term) => clean(term, 240)).filter(Boolean))],
    }))
    .filter((group) => group.terms.length)
    .map((group) => Object.freeze({ ...group, terms: Object.freeze(group.terms) })));
}

export function normalizeCommunityBoardDocumentTopic(input = {}) {
  return Object.freeze({
    issue_id: clean(input.issue_id || input.topic_id || input.id, 160) || "topic",
    label: clean(input.label || input.title, 240) || null,
    board_id: clean(input.board_id || input.body_id, 100).toLowerCase() || null,
    aliases: normalizeAliases(input.aliases || input.terms),
    through_date: date(input.through_date || input.observed_through),
  });
}

function sourceRows(documents, inventory) {
  const rows = Array.isArray(documents) ? documents : [];
  const inventoryRows = Array.isArray(inventory) ? inventory : [];
  const all = [...inventoryRows, ...rows];
  const roles = new Map();
  for (const row of all) {
    const role = sourceRole(row);
    if (!OFFICIAL_BOARD_DOCUMENT_SOURCE_ROLES.includes(role)) continue;
    const state = clean(row.state || row.coverage_state || (row.readable === false ? "unreadable" : "retained"), 40) || "retained";
    const entry = roles.get(role) || { role, documents_searched: 0, retained: 0, unreadable: 0, unavailable: 0 };
    if (rows.includes(row)) entry.documents_searched += 1;
    if (state === "unreadable" || state === "unsupported-format") entry.unreadable += 1;
    else if (state === "unavailable") entry.unavailable += 1;
    else if (rows.includes(row)) entry.retained += 1;
    roles.set(role, entry);
  }
  return [...roles.values()].sort((a, b) => a.role.localeCompare(b.role));
}

function boardDistrict(boardId) {
  const board = boardInfo(boardId);
  const boroughCode = { bronx: "X", brooklyn: "K", manhattan: "M", queens: "Q", "staten-island": "R" }[board?.borough];
  return board && boroughCode ? `${boroughCode}${String(board.district).padStart(2, "0")}` : null;
}

function projectHit(row, topic, identity, matched) {
  const role = sourceRole(row);
  const meetingDate = date(row.meeting_date || row.date || row.publication_date);
  const retrievalDate = date(row.retrieval_date || row.retrieved_at || row.observed_on || row.observed_through);
  const documentUrl = url(row.document_url || row.source_url || row.source?.url);
  const documentId = clean(row.document_id || row.id || row.source_record_id, 240);
  if (!meetingDate || !retrievalDate || !documentUrl || !documentId) return null;
  const boardName = identity.board_name;
  const actionType = actionFor(role, row);
  const route = href(row.route) || `/following/topics/${slug(topic.issue_id)}/board-documents/${slug(documentId)}/`;
  return Object.freeze({
    schema: COMMUNITY_BOARD_DOCUMENT_TOPIC_SLICE_SCHEMA,
    issue_id: topic.issue_id,
    board_id: identity.board_id,
    board_name: boardName,
    document_id: documentId,
    object_id: documentId,
    document_role: role,
    meeting_date: meetingDate,
    document_url: documentUrl,
    source_url: documentUrl,
    retrieval_date: retrievalDate,
    locator: clean(row.locator || row.location || row.source_locator || row.page || row.source_lines, 240) || null,
    excerpt: excerpt(documentText(row), matched[0].term),
    title: clean(row.title || row.published_label || `${identity.board_name} ${role}`, 240),
    matched_aliases: Object.freeze(matched.map((item) => Object.freeze(item))),
    action_type: actionType,
    action_label: ACTION_LABELS[actionType],
    formal_stance: formalStanceFor(role, row),
    route,
    source_family: "document_excerpt",
    source_reference: `community-board-document:${identity.board_id}:${documentId}`,
    observed_through: retrievalDate,
    districts: Object.freeze([boardDistrict(identity.board_id)].filter(Boolean)),
  });
}

function coverage(documents, inventory, hits, throughDate) {
  const rows = Array.isArray(documents) ? documents : [];
  const searchable = rows.filter((row) => OFFICIAL_BOARD_DOCUMENT_SOURCE_ROLES.includes(sourceRole(row)));
  const states = searchable.reduce((result, row) => {
    const state = clean(row.state || row.coverage_state || (row.readable === false ? "unreadable" : "retained"), 40) || "retained";
    result[state] = (result[state] || 0) + 1;
    return result;
  }, {});
  const dates = rows.map((row) => date(row.retrieval_date || row.retrieved_at || row.observed_on || row.observed_through)).filter(Boolean);
  return Object.freeze({
    documents_searched: rows.length,
    official_documents_searched: searchable.length,
    documents_matched: hits.length,
    source_roles: Object.freeze(sourceRows(rows, inventory).map((entry) => Object.freeze(entry))),
    states: Object.freeze(states),
    freshness: Object.freeze({ through_date: throughDate || dates.sort().at(-1) || null }),
    through_date: throughDate || dates.sort().at(-1) || null,
    source_scope: "retained official Community Board documents only",
    excluded_source_families: Object.freeze(["court_records", "reporting", "social_posts", "petitions", "unverified_external_documents"]),
  });
}

export function materializeCommunityBoardDocumentTopicSlice(documents = [], input = {}, options = {}) {
  const topic = normalizeCommunityBoardDocumentTopic(input);
  const rows = Array.isArray(documents) ? documents : [];
  const hits = [];
  for (const row of rows) {
    const identity = boardInfo(row?.board_id || row?.body_id);
    const role = sourceRole(row);
    if (!identity || (topic.board_id && identity.board_id !== topic.board_id) || !OFFICIAL_BOARD_DOCUMENT_SOURCE_ROLES.includes(role)) continue;
    if (row.readable === false || ["unreadable", "unavailable", "unsupported-format"].includes(clean(row.state || row.coverage_state, 40))) continue;
    const matched = matchesFor(documentText(row), topic.aliases);
    if (matched.length) {
      const hit = projectHit(row, topic, identity, matched);
      if (hit) hits.push(hit);
    }
  }
  hits.sort((a, b) => a.meeting_date.localeCompare(b.meeting_date) || a.document_id.localeCompare(b.document_id));
  const throughDate = topic.through_date || rows.map((row) => date(row.retrieval_date || row.retrieved_at || row.observed_on || row.observed_through)).filter(Boolean).sort().at(-1) || null;
  return Object.freeze({
    schema: COMMUNITY_BOARD_DOCUMENT_TOPIC_SLICE_SCHEMA,
    issue_id: topic.issue_id,
    label: topic.label,
    board_id: topic.board_id,
    aliases: topic.aliases,
    hits: Object.freeze(hits),
    matched: hits.length > 0,
    coverage: coverage(rows, options.source_inventory || options.inventory, hits, throughDate),
  });
}

export function materializeCommunityBoardDocumentTopicSlices(documents = [], topics = [], options = {}) {
  const normalizedTopics = Array.isArray(topics) ? topics : [topics];
  const slices = normalizedTopics.map((topic) => materializeCommunityBoardDocumentTopicSlice(documents, topic, options));
  const entries = slices.flatMap((slice) => slice.hits);
  return Object.freeze({
    schema: COMMUNITY_BOARD_DOCUMENT_TOPIC_SLICES_SCHEMA,
    version: 1,
    slices: Object.freeze(slices),
    entries: Object.freeze(entries),
    coverage: Object.freeze({ documents_searched: Array.isArray(documents) ? documents.length : 0, topics: slices.length }),
  });
}

export const buildCommunityBoardDocumentTopicSlice = materializeCommunityBoardDocumentTopicSlice;
export const buildCommunityBoardDocumentTopicSlices = materializeCommunityBoardDocumentTopicSlices;
export const materializeBoardDocumentTopicSlices = materializeCommunityBoardDocumentTopicSlices;

export function renderCommunityBoardDocumentTopicSlice(slice) {
  if (!slice || slice.schema !== COMMUNITY_BOARD_DOCUMENT_TOPIC_SLICE_SCHEMA) return "";
  const body = slice.hits.map((hit) => `<article data-action-type="${escapeHtml(hit.action_type)}"><h3><a href="${escapeHtml(hit.route)}">${escapeHtml(hit.action_label)}</a></h3><p>${escapeHtml(hit.board_name)} · <time datetime="${escapeHtml(hit.meeting_date)}">${escapeHtml(hit.meeting_date)}</time></p><p>${escapeHtml(hit.excerpt)}</p><p><a href="${escapeHtml(hit.document_url)}">Open official source document</a></p><details><summary>Source details</summary><p>Retrieved ${escapeHtml(hit.retrieval_date)} · ${escapeHtml(hit.document_role)}${hit.locator ? ` · ${escapeHtml(hit.locator)}` : ""}</p></details></article>`).join("");
  const c = slice.coverage;
  const empty = `<p>No retained official board document matched these aliases. Searched ${escapeHtml(c.official_documents_searched)} official document${c.official_documents_searched === 1 ? "" : "s"} through ${escapeHtml(c.through_date || "an unknown date")}.</p>`;
  return `<section id="board-document-topic-slice" data-schema="${COMMUNITY_BOARD_DOCUMENT_TOPIC_SLICE_SCHEMA}"><h2>${escapeHtml(slice.label || "Official board documents")}</h2>${body || empty}<details><summary>Search coverage</summary><p>${escapeHtml(c.source_scope)}. Source roles searched: ${escapeHtml(c.source_roles.map((role) => role.role).join(", ") || "none")}.</p></details></section>`;
}

export const renderBoardDocumentTopicSlice = renderCommunityBoardDocumentTopicSlice;
