/**
 * A bounded, issue-scoped view over retained Community Board documents.
 *
 * The classifier is deliberately source-qualified: words in a passage can
 * surface a candidate, but only an explicit source kind can grant institutional
 * force. A person's title never upgrades a chair action into a board act.
 */

export const BOARD_DOCUMENT_ISSUE_SLICE_SCHEMA = "cityscroll.board_document_issue_slice.v1";
export const BOARD_DOCUMENT_ACTION_TYPES = Object.freeze([
  "mention",
  "public_testimony",
  "committee_recommendation",
  "chair_action",
  "formal_board_action",
]);
export const BOARD_DOCUMENT_SOURCE_KINDS = Object.freeze([
  "minutes",
  "agenda",
  "committee_recommendation",
  "testimony",
  "chair_statement",
  "formal_vote",
  "resolution",
  "official_board_statement",
]);

const ACTION_LABELS = Object.freeze({
  mention: "Mention",
  public_testimony: "Public testimony",
  committee_recommendation: "Committee recommendation",
  chair_action: "Chair action (individual)",
  formal_board_action: "Formal board action",
});
const FORMAL_KINDS = new Set(["formal_vote", "resolution", "official_board_statement"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (value, max = 600) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const isoDate = (value) => { const v = clean(value, 10); return ISO_DATE.test(v) ? v : null; };
const slug = (value) => clean(value, 180).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document";
const escapeHtml = (value) => clean(value, 4_000).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));

function boardIdentity(boardId) {
  const value = clean(boardId, 80).toLowerCase();
  const match = value.match(/^(bronx|brooklyn|manhattan|queens|staten-island)-cb-(\d{2})$/);
  if (!match) return null;
  return { board_id: value, board_name: `Community Board ${Number(match[2])}`, borough: match[1], district: Number(match[2]) };
}

function actionFor(row, matchedText) {
  const kind = clean(row.source_kind, 80).toLowerCase();
  if (FORMAL_KINDS.has(kind)) return "formal_board_action";
  if (kind === "committee_recommendation") return "committee_recommendation";
  if (kind === "testimony") return "public_testimony";
  if (kind === "chair_statement") return "chair_action";
  return matchedText ? "mention" : null;
}

function excerptFor(row, matchedText) {
  const source = clean(row.excerpt || row.text, 4_000);
  if (!source || !matchedText) return null;
  const index = source.toLocaleLowerCase("en-US").indexOf(matchedText.toLocaleLowerCase("en-US"));
  if (source.length <= 320) return source;
  const start = Math.max(0, (index < 0 ? 0 : index) - 120);
  return `${start ? "…" : ""}${source.slice(start, start + 320)}${start + 320 < source.length ? "…" : ""}`;
}

export function normalizeBoardDocumentIssueConfig(input = {}) {
  const aliases = (Array.isArray(input.aliases) ? input.aliases : [])
    .map((group, index) => ({
      id: clean(group?.id, 100) || `alias-${index + 1}`,
      terms: [...new Set((Array.isArray(group?.terms) ? group.terms : [group?.term]).map((term) => clean(term, 240)).filter(Boolean))],
    }))
    .filter((group) => group.terms.length);
  return Object.freeze({
    issue_id: clean(input.issue_id, 160) || "emmons-shelter",
    board_id: clean(input.board_id, 80).toLowerCase() || "brooklyn-cb-15",
    aliases: Object.freeze(aliases.map((group) => Object.freeze({ ...group, terms: Object.freeze(group.terms) }))),
    through_date: isoDate(input.through_date),
  });
}

export function classifyBoardDocumentIssueDocuments(documents = [], input = {}) {
  const config = normalizeBoardDocumentIssueConfig(input);
  const hits = [];
  const rows = Array.isArray(documents) ? documents : [];
  for (const row of rows) {
    const identity = boardIdentity(row?.board_id || row?.body_id);
    if (!identity || identity.board_id !== config.board_id) continue;
    const text = clean(row.text || row.excerpt || row.body, 20_000);
    const matched = config.aliases.flatMap((group) => group.terms.filter((term) => text.toLocaleLowerCase("en-US").includes(term.toLocaleLowerCase("en-US"))).map((term) => ({ alias_group: group.id, term })));
    if (!matched.length) continue;
    const meetingDate = isoDate(row.meeting_date || row.date);
    const retrievalDate = isoDate(row.retrieval_date || row.retrieved_at || row.observed_on);
    const documentUrl = clean(row.document_url || row.source_url, 2_000);
    if (!meetingDate || !retrievalDate || !/^https:\/\//.test(documentUrl)) continue;
    const actionType = actionFor(row, matched[0].term);
    const documentId = clean(row.document_id || row.id, 240) || `${identity.board_id}:${meetingDate}:${slug(documentUrl)}`;
    hits.push(Object.freeze({
      schema: BOARD_DOCUMENT_ISSUE_SLICE_SCHEMA,
      issue_id: config.issue_id,
      document_id: documentId,
      board_id: identity.board_id,
      board_name: identity.board_name,
      meeting_date: meetingDate,
      document_url: documentUrl,
      retrieval_date: retrievalDate,
      excerpt: excerptFor(row, matched[0].term),
      matched_aliases: Object.freeze(matched.map((item) => Object.freeze(item))),
      action_type: actionType,
      action_label: ACTION_LABELS[actionType],
      route: `/following/packs/${slug(config.issue_id)}/board-documents/${slug(documentId)}/`,
      source_kind: clean(row.source_kind, 80).toLowerCase() || "minutes",
    }));
  }
  hits.sort((a, b) => a.meeting_date.localeCompare(b.meeting_date) || a.document_id.localeCompare(b.document_id));
  const throughDate = config.through_date || rows.map((row) => isoDate(row.retrieval_date || row.retrieved_at || row.observed_on)).filter(Boolean).sort().at(-1) || null;
  return Object.freeze({
    schema: BOARD_DOCUMENT_ISSUE_SLICE_SCHEMA,
    issue_id: config.issue_id,
    board_id: config.board_id,
    aliases: config.aliases,
    hits: Object.freeze(hits),
    coverage: Object.freeze({ documents_searched: rows.length, through_date: throughDate }),
    matched: hits.length > 0,
  });
}

export function renderBoardDocumentIssueSlice(slice) {
  const view = slice?.schema === BOARD_DOCUMENT_ISSUE_SLICE_SCHEMA ? slice : classifyBoardDocumentIssueDocuments([], slice);
  const body = view.hits.map((hit) => `<article data-action-type="${escapeHtml(hit.action_type)}"><h3><a href="${escapeHtml(hit.route)}">${escapeHtml(hit.action_label)}</a></h3><p>${escapeHtml(hit.board_name)} · <time datetime="${escapeHtml(hit.meeting_date)}">${escapeHtml(hit.meeting_date)}</time></p><p>${escapeHtml(hit.excerpt)}</p><p><a href="${escapeHtml(hit.document_url)}">Open source document</a></p><details><summary>Source details</summary><p>Retrieved ${escapeHtml(hit.retrieval_date)} · matched ${escapeHtml(hit.matched_aliases.map((item) => item.term).join(", "))}</p></details></article>`).join("");
  const empty = `<p>No retained CB15 document matched these reviewed aliases. Searched ${view.coverage.documents_searched} retained document${view.coverage.documents_searched === 1 ? "" : "s"} through ${escapeHtml(view.coverage.through_date || "an unknown date")}.</p>`;
  return `<section id="board-document-issue-slice" data-schema="${BOARD_DOCUMENT_ISSUE_SLICE_SCHEMA}"><h2>What CB15 material says</h2>${body || empty}</section>`;
}

export const EMMONS_BOARD_DOCUMENT_ISSUE_CONFIG = Object.freeze(normalizeBoardDocumentIssueConfig({
  issue_id: "emmons-shelter",
  board_id: "brooklyn-cb-15",
  aliases: [
    { id: "address", terms: ["3218 Emmons", "3218 Emmons Avenue"] },
    { id: "hotel", terms: ["Gold Star Inn", "Comfort Inn Sheepshead Bay"] },
    { id: "shelter", terms: ["Sheepshead Bay shelter"] },
  ],
}));

