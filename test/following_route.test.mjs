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
  assert.match(html, /data-following-identity-rule>Notify me when new hearings and meetings mentioning 'curb' are published in Queens\.<\/p>/);
  assert.match(html, /name="email"/);
  assert.doesNotMatch(html, /data-watch-key|recognized="true"/);
});

test("Following topic-only watch keeps its full criteria in the returned rule sentence", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "money",
    filter: { keywords: ["elevator"] },
    requested: true,
    frequency: "daily",
  }));

  assert.match(html, /Notify me when new contracts mentioning 'elevator' are published citywide\./);
});

test("Following topic+place watch combines subject and place in a scannable sentence", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "rules",
    filter: {
      borough: "Brooklyn",
      agency: "Housing Preservation and Development",
    },
    requested: true,
    frequency: "weekly",
  }));

  assert.match(html, /Notify me when new rules from Housing Preservation and Development are published in Brooklyn\./);
  assert.match(html, /<dt>Topic<\/dt>.*Rules/s);
  assert.match(html, /<dt>Place<\/dt>.*Brooklyn/s);
  assert.match(html, /<dt>Agency<\/dt>.*Housing Preservation and Development/s);
});
