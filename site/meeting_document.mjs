import { communityBoardPageHref } from "./community_board_links.mjs";
import {
  communityBoardMeetingEdgeAccepted,
  communityBoardMeetingEdgeFromRow,
} from "./community_board_institution_edges.mjs";

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function boardId(record) {
  const edge = communityBoardMeetingEdgeFromRow(record);
  return edge?.from?.replace(/^community-board:/, "")
    || record?.institution_refs?.board_ref?.replace(/^community-board:/, "")
    || record?.board_id
    || null;
}

/** Render the source-qualified canonical meeting document used by every meeting card. */
export function renderMeetingDocument(record = {}) {
  const id = String(record.meeting_id || "").trim();
  const title = String(record.title || "Meeting").trim() || "Meeting";
  const canonical = `/meetings/${encodeURIComponent(id)}/`;
  const source = record.source_url || record.compatibility?.publisher_href || null;
  const edge = communityBoardMeetingEdgeFromRow(record);
  const board = boardId(record);
  const boardLink = edge && communityBoardMeetingEdgeAccepted(edge) && board
    ? `<a href="${esc(communityBoardPageHref(board))}">Hosted by Community Board</a>`
    : "";
  const legacy = record.compatibility?.legacy_notice_href;
  const checked = record.source_receipt?.observed_at;
  const sourceDetails = [
    source ? `<a href="${esc(source)}" rel="noopener noreferrer">Official source</a>` : "",
    record.source_record_id ? `<span>Publisher record: <bdi>${esc(record.source_record_id)}</bdi></span>` : "",
    checked ? `<time datetime="${esc(checked)}">Source checked ${esc(checked)}</time>` : "",
  ].filter(Boolean).join(" · ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · CityScroll</title>
<meta name="description" content="Public meeting record from CityScroll.">
<link rel="canonical" href="https://cityscroll.org${esc(canonical)}">
<link rel="stylesheet" href="/brand.css">
<link rel="stylesheet" href="/civic-documents.css">
</head>
<body>
<header class="document-mast"><div class="document-mast-inner"><a class="document-brand brand-lockup home" href="/">CityScroll</a><nav class="document-nav" aria-label="Primary"><a href="/now/">Now</a><a href="/near-you/">Near you</a><a href="/following/">Following</a><a href="/browse/">Browse</a></nav></div></header>
<main id="main" class="civic-document meeting-document" data-civic-object-kind="meeting" data-meeting-id="${esc(id)}" data-source-record-id="${esc(record.source_record_id || "")}">
  <p class="node-back"><a href="/browse/meetings/">Browse meetings and hearings</a></p>
  <p class="node-kicker">${esc(record.source_system === "community_board" ? "Community board meeting" : "City Record meeting")}</p>
  <h1>${esc(title)}</h1>
  ${record.event_date ? `<p><time datetime="${esc(record.event_date)}">${esc(record.event_date)}</time></p>` : ""}
  ${boardLink ? `<p>${boardLink}</p>` : ""}
  <p><a class="node-action primary" href="/meeting.ics?id=${encodeURIComponent(id)}">Add to calendar</a>${legacy ? ` · <a href="${esc(legacy)}">Open the City Record notice</a>` : ""}</p>
  ${sourceDetails ? `<details class="meeting-source-details"><summary>Source details</summary><p>${sourceDetails}</p></details>` : ""}
</main>
</body>
</html>`;
}
