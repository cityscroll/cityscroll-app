import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBrowseView,
  disambiguateBrowseCardHeadings,
  renderBrowseView,
} from "../site/browse_view.mjs";

test("distinct meetings that share a publisher title get unique visible headings", () => {
  const rows = [
    {
      meeting_id: "meeting:community_board:cb6-a",
      title: "Transportation Committee Meeting",
      event_date: "2026-10-05",
      board_id: "manhattan-cb-06",
      board_name: "Manhattan CB6",
      meeting_origin: "official_community_board_calendar",
      source_system: "community_board",
    },
    {
      meeting_id: "meeting:community_board:cb6-b",
      title: "Transportation Committee Meeting",
      event_date: "2026-11-02",
      board_id: "manhattan-cb-06",
      board_name: "Manhattan CB6",
      meeting_origin: "official_community_board_calendar",
      source_system: "community_board",
    },
    {
      meeting_id: "meeting:community_board:bk14-a",
      title: "Transportation Committee Meeting",
      event_date: "2026-10-05",
      board_id: "brooklyn-cb-14",
      board_name: "Brooklyn CB14",
      meeting_origin: "official_community_board_calendar",
      source_system: "community_board",
    },
    {
      meeting_id: "meeting:community_board:unique",
      title: "Unique Hearing Title",
      event_date: "2026-10-05",
      board_id: "manhattan-cb-06",
      board_name: "Manhattan CB6",
      meeting_origin: "official_community_board_calendar",
      source_system: "community_board",
    },
  ];
  const labels = disambiguateBrowseCardHeadings("meetings", rows);
  assert.equal(labels.get("meeting:community_board:cb6-a"), "Transportation Committee Meeting · 2026-10-05 · Manhattan CB6");
  assert.equal(labels.get("meeting:community_board:cb6-b"), "Transportation Committee Meeting · 2026-11-02");
  assert.equal(labels.get("meeting:community_board:bk14-a"), "Transportation Committee Meeting · 2026-10-05 · Brooklyn CB14");
  assert.equal(labels.get("meeting:community_board:unique"), "Unique Hearing Title");

  const html = renderBrowseView(buildBrowseView("meetings", { rows }));
  // Headings carry data-source-title (and may carry other attributes); a bare
  // <h3>…</h3> match returns zero texts and lets uniqueness pass vacuously.
  const headingTexts = [...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/g)].map((match) =>
    match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
  );
  assert.equal(headingTexts.length, 4, headingTexts);
  assert.equal(new Set(headingTexts).size, headingTexts.length, headingTexts);
  assert.ok(headingTexts.every((text) => text.includes("Transportation Committee Meeting") || text.includes("Unique Hearing Title")));
  assert.match(html, /data-source-title="Transportation Committee Meeting"/);
  assert.match(html, /data-record-id="meeting:community_board:cb6-a"/);
});
