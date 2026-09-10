import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import {
  civicDayISO,
  closingThisWeekQuery,
  closingWeekEndISO,
  daysUntilDue,
  dueClosesThisWeek,
} from "../site/closing_this_week.mjs";
import { renderInterpretPreview } from "../site/interpret_preview.mjs";
import { filterMoneySnapshot } from "../site/resident_snapshot_queries.mjs";
import { moneySuggestionDestinationRows } from "../site/suggestion_destination.mjs";

const require = createRequire(import.meta.url);
const { parseNL } = require("../site/nl_parse.js");

const TODAY = "2026-09-10"; // Thursday

function solicitation(id, due) {
  return {
    request_id: id,
    type_of_notice_description: "Solicitation",
    due_date: due,
    agency_name: "Parks and Recreation",
    short_title: `Contract ${id}`,
  };
}

function fixtureRows() {
  return [
    solicitation("d1", "2026-09-11"),
    solicitation("d6", "2026-09-16"),
    solicitation("d7", "2026-09-17"),
    solicitation("d8", "2026-09-18"),
  ];
}

test("rolling seven civic days: 1, 6, and 7 are inside; 8 is the first day outside", () => {
  assert.equal(closingWeekEndISO(TODAY), "2026-09-17");
  assert.equal(daysUntilDue("2026-09-11", TODAY), 1);
  assert.equal(daysUntilDue("2026-09-16", TODAY), 6);
  assert.equal(daysUntilDue("2026-09-17", TODAY), 7);
  assert.equal(daysUntilDue("2026-09-18", TODAY), 8);
  assert.equal(dueClosesThisWeek("2026-09-11", TODAY), true);
  assert.equal(dueClosesThisWeek("2026-09-17", TODAY), true);
  assert.equal(dueClosesThisWeek("2026-09-18", TODAY), false);
  assert.equal(dueClosesThisWeek("2026-09-10", TODAY), false);
});

test("closing-this-week preview and list agree on a fixed clock, including the boundary day", () => {
  const rows = fixtureRows();
  const query = closingThisWeekQuery(TODAY);
  const list = filterMoneySnapshot(rows, { ...query, limit: 40 });
  const previewRows = moneySuggestionDestinationRows({
    filter: parseNL("contracts closing this week"),
    snapshot: { rows, count: rows.length, generated_at: "2026-09-10T00:00:00.000Z" },
    today: TODAY,
  });
  assert.deepEqual(list.map((row) => row.request_id), ["d1", "d6", "d7"]);
  assert.deepEqual(previewRows.map((row) => row.request_id), list.map((row) => row.request_id));
  assert.equal(list.length, 3);
  assert.equal(daysUntilDue(list[0].due_date, TODAY), 1);
  assert.equal(daysUntilDue(list.at(-1).due_date, TODAY), 7);

  const html = renderInterpretPreview({
    query: "contracts closing this week",
    rows: previewRows,
    renderRow: (row) => `<article data-id="${row.request_id}">closes in ${daysUntilDue(row.due_date, TODAY)} days</article>`,
    empty: "No matches for this search.",
  });
  assert.match(html, /data-preview-state="results"/);
  assert.match(html, /data-id="d1"/);
  assert.match(html, /data-id="d6"/);
  assert.match(html, /data-id="d7"/);
  assert.match(html, /closes in 1 days/);
  assert.match(html, /closes in 7 days/);
  assert.doesNotMatch(html, /data-id="d8"/);

  const emptyRows = [solicitation("d8", "2026-09-18")];
  const emptyList = filterMoneySnapshot(emptyRows, { ...query, limit: 40 });
  const emptyPreview = moneySuggestionDestinationRows({
    filter: parseNL("contracts closing this week"),
    snapshot: { rows: emptyRows, count: 1, generated_at: "2026-09-10T00:00:00.000Z" },
    today: TODAY,
  });
  assert.deepEqual(emptyList, []);
  assert.deepEqual([...emptyPreview], []);
  const emptyHtml = renderInterpretPreview({
    query: "contracts closing this week",
    rows: emptyPreview,
    renderRow: (row) => `<article data-id="${row.request_id}"></article>`,
    empty: "No matches for this search.",
  });
  assert.match(emptyHtml, /data-preview-state="empty"/);
  assert.match(emptyHtml, /No matches for this search\./);
  assert.doesNotMatch(emptyHtml, /data-id=/);
});

test("a due-tomorrow item is in both the preview and the list", () => {
  const rows = [solicitation("tomorrow", "2026-09-11"), solicitation("later", "2026-09-18")];
  const query = closingThisWeekQuery(TODAY);
  const list = filterMoneySnapshot(rows, { ...query, limit: 40 });
  const previewRows = moneySuggestionDestinationRows({
    filter: parseNL("contracts closing this week"),
    snapshot: { rows, count: 2, generated_at: "2026-09-10T00:00:00.000Z" },
    today: TODAY,
  });
  assert.deepEqual(list.map((row) => row.request_id), ["tomorrow"]);
  assert.deepEqual(previewRows.map((row) => row.request_id), ["tomorrow"]);
  const html = renderInterpretPreview({
    query: "contracts closing this week",
    rows: previewRows,
    renderRow: (row) => `<article data-id="${row.request_id}">closes in ${daysUntilDue(row.due_date, TODAY)} days</article>`,
  });
  assert.match(html, /data-preview-state="results"/);
  assert.match(html, /data-id="tomorrow"/);
  assert.doesNotMatch(html, /data-id="later"/);
});

test("a caller cannot widen the week window past the shared predicate", () => {
  const list = filterMoneySnapshot(fixtureRows(), {
    mode: "open",
    closingWeek: true,
    today: TODAY,
    weekEnd: "2026-12-31",
    limit: 40,
  });
  assert.deepEqual(list.map((row) => row.request_id), ["d1", "d6", "d7"]);
});

test("a pinned civic day is the clock for the live helpers", () => {
  const previous = globalThis.CROL_PINNED_TODAY;
  globalThis.CROL_PINNED_TODAY = TODAY;
  try {
    assert.equal(civicDayISO(Date.parse("2026-12-01T20:15:00.000Z")), TODAY);
    assert.equal(closingWeekEndISO(civicDayISO()), "2026-09-17");
  } finally {
    globalThis.CROL_PINNED_TODAY = previous;
  }
});

test("the Ask path uses the shared destination rows for closing this week, not federated keyword search", () => {
  const source = readFileSync(new URL("../site/app/search-share.mjs", import.meta.url), "utf8");
  assert.match(source, /async function renderClosingWeekPreview/);
  assert.match(source, /moneySuggestionDestinationRows/);
  const closingBranch = source.slice(source.indexOf("if(closingWeek){"));
  assert.match(closingBranch.slice(0, 500), /renderClosingWeekPreview/);
  assert.doesNotMatch(closingBranch.slice(0, 500), /renderPreviewFormFactor/);
});
