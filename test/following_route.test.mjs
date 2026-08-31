import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildFollowingViewModel,
  canonicalFollowingScope,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";
import { followingManagementUrl } from "../site/following_personal_state.mjs";
import {
  HOME_FOLLOWING_ONBOARDING_HREF,
  homeFollowingEntryHref,
} from "../site/home_following_entry.mjs";

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

test("Following preview enhancement keeps refined criteria in the shareable URL", () => {
  const following = readFileSync(new URL("../site/app/following.mjs", import.meta.url), "utf8");
  assert.match(following, /history\.replaceState\(\{\}, \"\", `\$\{url\.pathname\}\$\{url\.search\}`\)/);
  assert.match(following, /data-following-preview-status.*msg\("msgPreviewReady"\)|replaceChildren\(msg\("msgPreviewReady"\)\)/);
  assert.match(following, /addEventListener\("popstate"/);
  assert.match(following, /restoreFromLocation/);
});

test("manage-watches recovery stays on the canonical Following route", () => {
  assert.equal(followingManagementUrl({ pathname: "/following/", search: "" }), "/following/#your-following");
  const following = readFileSync(new URL("../site/app/following.mjs", import.meta.url), "utf8");
  assert.match(following, /popstate/);
  assert.match(following, /markManagementDestination/);
  assert.match(following, /data-personal-retry/);
  assert.match(following, /keepExisting: true/);
  assert.doesNotMatch(following, /\/prefs\/new|\/alerts\/manage/);
});

test("generic homepage onboarding opens the Following choose step", () => {
  const watch = watchFromFollowingParams(new URL(HOME_FOLLOWING_ONBOARDING_HREF, "https://cityscroll.org").searchParams);
  const html = renderFollowingDocument(buildFollowingViewModel(watch, { templates: [] }));
  assert.equal(watch.onboarding, true);
  assert.equal(watch.requested, false);
  assert.match(html, /data-following-journey="choose"/);
  assert.match(html, /Choose what to follow/);
  assert.doesNotMatch(html, /data-following-subscribe-form/);
});

test("homepage scoped entry round-trips the canonical Following URL", () => {
  const href = homeFollowingEntryHref({
    lens: "meetings",
    filter: { keywords: ["curb"], borough: "Queens" },
    frequency: "weekly",
  });
  const parsed = watchFromFollowingParams(new URL(href, "https://cityscroll.org").searchParams);
  assert.deepEqual(
    canonicalFollowingScope(parsed),
    canonicalFollowingScope({ lens: "meetings", filter: { keywords: ["curb"], borough: "Queens" } }),
  );
  const html = renderFollowingDocument(buildFollowingViewModel({ ...parsed, requested: true }));
  assert.match(html, /Notify me when new hearings and meetings mentioning 'curb' are published in Queens\./);
  assert.match(html, /name="email"/);
});

test("invalid homepage context and direct Following entry stay on the canonical builder", () => {
  assert.equal(homeFollowingEntryHref({ lens: "not-a-lens", filter: { keywords: ["x"] } }), HOME_FOLLOWING_ONBOARDING_HREF);
  const direct = renderFollowingDocument(buildFollowingViewModel({}));
  assert.match(direct, /data-following-journey="choose"/);
  assert.match(direct, /Follow what you care about/);
  const unrecognized = renderFollowingDocument(buildFollowingViewModel(
    watchFromFollowingParams(new URLSearchParams("lens=not-a-lens&filter=%7B%7D")),
  ));
  assert.match(unrecognized, /data-following-journey="preview"/);
  assert.doesNotMatch(unrecognized, /data-watch-key|recognized="true"/);
});

test("district watches make the Community Board picker discoverable", () => {
  const districtHtml = renderFollowingDocument(buildFollowingViewModel({
    lens: "district",
    filter: { councilDistrict: "7" },
    requested: true,
  }));

  assert.match(districtHtml, /Not a Community Board\. Boards are 1–18 in each borough/);
  assert.match(districtHtml, /<a href="https:\/\/cityscroll\.org\/following\?lens=meetings(?:&amp;|&)filter=%7B%7D(?:&amp;|&)freq=daily">Choose a Community Board watch<\/a>/);

  const meetingsHtml = renderFollowingDocument(buildFollowingViewModel({
    lens: "meetings",
    filter: {},
    requested: true,
  }));

  assert.match(meetingsHtml, /<details class="following-refinements" open>/);
  assert.match(meetingsHtml, /name="boardBorough"/);
  assert.match(meetingsHtml, /name="boardNumber"/);
});
