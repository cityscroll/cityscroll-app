import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const followingApp = readFileSync(new URL("../../site/app/following.mjs", import.meta.url), "utf8");
const browseApp = readFileSync(new URL("../../site/app/feed-actions.mjs", import.meta.url), "utf8");
const browsePage = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");

test("browser controls update preview state and restore it through navigation", () => {
  assert.match(followingApp, /data-following-availability-preset/);
  assert.match(followingApp, /history\.replaceState/);
  assert.match(followingApp, /addEventListener\("popstate"/);
  assert.match(followingApp, /data-following-availability/);
  assert.match(followingApp, /availabilityFromForm/);
});

test("browse controls support touch selection and share-state restoration", () => {
  assert.match(browsePage, /data-meetings-availability/);
  assert.match(browsePage, /data-meetings-availability-custom hidden/);
  assert.match(browsePage, /data-meetings-availability-day/);
  assert.match(browsePage, /data-meetings-availability-timezone/);
  assert.match(browseApp, /wireMeetingAvailabilityControls/);
  assert.match(browseApp, /typeof selection === "object"/);
  assert.match(browseApp, /updateHash/);
  assert.match(browseApp, /evaluateMeetingAvailabilityRows/);
});

test("the no-JavaScript form exposes the same availability fields", () => {
  assert.match(browsePage, /name="meetingsAvailability" value="evenings_weekends"/);
  assert.match(browsePage, /Weekdays from 17:00 \(inclusive\)/);
});
