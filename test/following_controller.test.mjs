import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const following = readFileSync(new URL("../site/app/following.mjs", import.meta.url), "utf8");

test("Following controller paints distinct personal retrieval states", () => {
  assert.match(following, /from "\.\.\/following_personal_state\.mjs"/);
  assert.match(following, /paintPersonalIsland\("loading"/);
  assert.match(following, /paintPersonalIsland\("unavailable"/);
  assert.match(following, /paintPersonalIsland\("error"/);
  assert.match(following, /data-personal-retry/);
  assert.match(following, /data-following-create-recovery/);
  assert.match(following, /msgPersonalLoadError/);
});

test("Following controller keeps the managed watch on the same surface after actions", () => {
  assert.match(following, /keepExisting: true, focusWatchKey: watchKey/);
  assert.match(following, /markManagementDestination\(\)/);
  assert.match(following, /focusWatch\(focusWatchKey\)/);
  assert.match(following, /await loadPersonal\(\{ keepExisting: true \}\)/);
  assert.match(following, /setTab\("watches", \{ historyMode: "push" \}\)/);
  assert.match(following, /if \(status\) status\.textContent = msg\("msgPersonalError"\)/);
  assert.match(following, /https:\/\/cityscroll\.org/);
  assert.match(following, /form\.getAttribute\("action"\)/);
  assert.doesNotMatch(following, /window\.location = .*(prefs|alerts)/);
});

test("Following controller recovers #your-following across tab and history changes", () => {
  assert.match(following, /historyMode: "push"/);
  assert.match(following, /popstate/);
  assert.match(following, /historyMode: "none"/);
  assert.match(following, /followingManagementUrl\(location\)/);
  assert.match(following, /followingUrlForTab\(location, tab\)/);
  assert.match(following, /data-following-suggestions/);
  assert.match(following, /insertAfter\.after\(personal\)/);
});

test("Following controller adopts a preview workspace after a choose-step form post", () => {
  assert.match(following, /nextRoot\.dataset\.followingJourney/);
  assert.match(following, /root\.querySelector\("#create"\)\?\.after\(replacement\)/);
});
