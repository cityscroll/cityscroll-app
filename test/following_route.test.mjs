import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFollowingViewModel,
  renderFollowingDocument,
} from "../site/following_view.mjs";

test("Following keeps a scoped watch's canonical return path visible without a token", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "meetings",
    filter: { keywords: ["curb"], borough: "Queens" },
    frequency: "weekly",
    requested: true,
  }));
  const currentMatches = html.match(/class="ui-constellation-link following-current-matches" href="([^"]+)"/);

  assert.ok(currentMatches, "the watch identity card should link to current matches");
  const destination = new URL(currentMatches[1], "https://cityscroll.org");
  assert.equal(destination.pathname, "/browse/meetings/");
  assert.match(destination.search, /boro=Queens/);
  assert.match(destination.search, /q=curb/);
  assert.match(html, /data-following-identity-rule>Notify me when Hearings and meetings match keyword curb AND in Queens\.<\/p>/);
  assert.match(html, /name="email"/);
  assert.doesNotMatch(html, /data-watch-key|recognized="true"/);
});
