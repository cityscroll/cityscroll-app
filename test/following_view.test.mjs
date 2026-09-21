import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENINGS_WEEKENDS_AVAILABILITY,
  buildFollowingViewModel,
  followingUrlFromWatch,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";

test("Following exposes the compiled evenings and weekends meaning before save", () => {
  const view = buildFollowingViewModel({
    lens: "meetings",
    filter: { availability: EVENINGS_WEEKENDS_AVAILABILITY },
    requested: true,
    availabilityCounts: { total: 4, matched: 2, excluded: 2, unknown_start: 2 },
  });
  const html = renderFollowingDocument(view);

  assert.match(html, /name="availability_preset" value="evenings_weekends" checked/);
  assert.match(html, /Weekdays from 17:00 \(inclusive\) onward/);
  assert.match(html, /weekends all day/);
  assert.match(html, /America\/New_York/);
  assert.match(html, /unknown starts excluded/);
  assert.match(html, /2 meetings without a start time excluded from this constrained result/);
});

test("the availability preset survives the canonical Following URL round trip", () => {
  const href = followingUrlFromWatch({
    lens: "meetings",
    filter: { availability: EVENINGS_WEEKENDS_AVAILABILITY },
  }, { frequency: "weekly" });
  const parsed = watchFromFollowingParams(new URL(href).searchParams);

  assert.deepEqual(parsed.filter.availability, EVENINGS_WEEKENDS_AVAILABILITY);
  assert.equal(parsed.frequency, "weekly");
});
