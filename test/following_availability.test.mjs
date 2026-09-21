import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENINGS_WEEKENDS_AVAILABILITY,
  buildFollowingViewModel,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";

test("custom weekly availability keeps its days, clock boundary, timezone, and unknown-time rule", () => {
  const params = new URLSearchParams([
    ["lens", "meetings"],
    ["availability_preset", "custom"],
    ["availability_day", "1"],
    ["availability_day", "3"],
    ["availability_start", "18:30"],
    ["availability_end", "21:00"],
    ["availability_timezone", "America/Chicago"],
    ["availability_unknown_start", "include"],
  ]);
  const parsed = watchFromFollowingParams(params);

  assert.deepEqual(parsed.filter.availability, {
    schema: "cityscroll.meeting_availability.v1",
    timezone: "America/Chicago",
    windows: [{ weekdays: [1, 3], start: "18:30", end: "21:00" }],
    unknown_start: "include",
  });
});

test("preview failure preserves the selected window without claiming an empty success", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "meetings",
    filter: { availability: EVENINGS_WEEKENDS_AVAILABILITY },
    requested: true,
    previewError: "The preview is not ready. Your wording is still here.",
    previewItems: [],
    matchCount: null,
  }));

  assert.match(html, /name="availability_preset" value="evenings_weekends" checked/);
  assert.match(html, /The preview is not ready/);
  assert.doesNotMatch(html, /No matches now/);
  assert.doesNotMatch(html, /data-following-preview-state="ready"/);
});
