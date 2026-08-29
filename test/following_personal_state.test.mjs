import assert from "node:assert/strict";
import test from "node:test";

import {
  FOLLOWING_PERSONAL_STATES,
  followingManagementUrl,
  followingPersonalIslandHtml,
  followingPersonalIslandProjection,
  followingPersonalStateFromHost,
  followingPersonalUiState,
  followingTabHash,
  followingUrlForTab,
} from "../site/following_personal_state.mjs";
import { buildFollowingViewModel, renderFollowingDocument } from "../site/following_view.mjs";

function host(html) {
  return {
    getAttribute(name) {
      const match = html.match(new RegExp(`${name}="([^"]*)"`));
      return match ? match[1] : null;
    },
    querySelector(selector) {
      if (selector === "[data-personal-state]") {
        const match = html.match(/data-personal-state="([^"]+)"/);
        return match ? { getAttribute: () => match[1] } : null;
      }
      if (selector === "[data-session-recognized]") {
        const match = html.match(/data-session-recognized="([^"]+)"/);
        return match ? { getAttribute: () => match[1] } : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== "[data-watch-key]") return [];
      return [...html.matchAll(/data-watch-key="/g)];
    },
  };
}

test("personal island states stay a closed, distinguishable set", () => {
  assert.deepEqual(FOLLOWING_PERSONAL_STATES, [
    "loading",
    "unrecognized",
    "empty",
    "recognized",
    "unavailable",
    "error",
  ]);
  assert.equal(followingPersonalUiState({ loading: true }), "loading");
  assert.equal(followingPersonalUiState({ sessionRecognized: false }), "unrecognized");
  assert.equal(followingPersonalUiState({ sessionRecognized: true, watchCount: 0 }), "empty");
  assert.equal(followingPersonalUiState({ sessionRecognized: true, watchCount: 1 }), "recognized");
  assert.equal(followingPersonalUiState({ responseOk: false }), "unavailable");
  assert.equal(followingPersonalUiState({ fetchFailed: true }), "error");
});

test("unrecognized, empty, unavailable, and error recover without minting a watch", () => {
  for (const state of ["unrecognized", "empty", "unavailable", "error", "loading"]) {
    const view = followingPersonalIslandProjection(state);
    const html = followingPersonalIslandHtml(state);
    assert.equal(view.showControls, false);
    assert.doesNotMatch(html, /data-watch-key|name="action"|prefs\?token=/);
    assert.match(html, new RegExp(`data-personal-state="${state}"`));
  }

  const unrecognized = followingPersonalIslandProjection("unrecognized");
  assert.equal(unrecognized.recovery.kind, "create");
  assert.match(followingPersonalIslandHtml("unrecognized"), /Open a CityScroll email to see your watches/);
  assert.match(followingPersonalIslandHtml("unrecognized"), /data-following-create-recovery/);
  assert.match(followingPersonalIslandHtml("unrecognized"), /data-session-recognized="false"/);

  const empty = followingPersonalIslandHtml("empty");
  assert.match(empty, /No saved watches yet/);
  assert.match(empty, /data-session-recognized="true"/);
  assert.match(empty, /data-following-create-recovery/);
  assert.doesNotMatch(empty, /data-watch-key/);

  assert.match(followingPersonalIslandHtml("unavailable"), /data-personal-retry/);
  assert.match(followingPersonalIslandHtml("error"), /Could not load saved watches/);
  assert.equal(followingPersonalIslandProjection("recognized").showControls, true);
  assert.equal(followingPersonalIslandHtml("recognized", {
    watchesHtml: '<article data-watch-key="sub:meetings-queens"></article>',
  }), '<article data-watch-key="sub:meetings-queens"></article>');
});

test("management destination keeps the canonical Following route and your-following hash", () => {
  assert.equal(followingTabHash("watches"), "your-following");
  assert.equal(followingTabHash("create"), "create");
  assert.equal(
    followingManagementUrl({ pathname: "/following/", search: "" }),
    "/following/#your-following",
  );
  assert.equal(
    followingUrlForTab({ pathname: "/following/", search: "?lens=meetings" }, "watches"),
    "/following/?lens=meetings#your-following",
  );
  assert.equal(
    followingUrlForTab({ pathname: "/following/", search: "?lens=meetings" }, "create"),
    "/following/?lens=meetings#create",
  );
});

test("public Following shell stamps an unrecognized island without session controls", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({}, { templates: [] }));
  assert.match(html, /data-personal-watch-list[^>]*data-personal-state="unrecognized"/);
  assert.match(html, /data-following-create-recovery/);
  assert.doesNotMatch(html, /data-watch-key|data-session-recognized="true"/);
  assert.equal(followingPersonalStateFromHost(host(
    '<div data-personal-state="error"><button data-personal-retry>Try again</button></div>',
  )), "error");
});
