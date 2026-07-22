// Characterization for changelog media. Before this feature, every entry rendered as one
// flat <li>; after it, that exact byte shape remains unchanged for media-less entries while
// an optional, validated media object expands only the entry that owns it.
//
// Run: node --test test/changelog_media.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { renderEntries, validateEntries } from "../tools/gen_changelog.mjs";

const plainEntry = {
  pr: 79,
  merged_at: "2026-07-17",
  url: "https://github.com/cityscroll/crol-list/pull/79",
  text: "A plain update stays plain.",
};

const media = {
  screenshots: [
    {
      viewport: 390,
      width: 390,
      height: 844,
      before: {
        src: "media/changelog/pr-80/before-390.png",
        alt: "The notice before the award watch button was added.",
        alt_i18n: "chg_pr80_before_alt",
      },
      after: {
        src: "media/changelog/pr-80/after-390.png",
        alt: "The notice with the award watch button.",
        alt_i18n: "chg_pr80_after_alt",
      },
    },
  ],
  recording: {
    src: "media/changelog/pr-80/award-watch.webm",
    poster: "media/changelog/pr-80/after-390.png",
    width: 390,
    height: 844,
    caption: "Open the notice, choose the award watch, and reach the email confirmation step.",
    caption_i18n: "chg_pr80_recording_caption",
  },
};

test("before: every update was a flat list item; after: an entry without media renders exactly the old markup", () => {
  validateEntries([plainEntry]);
  assert.equal(
    renderEntries([plainEntry]),
    '    <li><time datetime="2026-07-17">2026.07.17</time> — A plain update stays plain.</li>',
  );
});

test("before: changelog entries could not show product evidence; after: a media entry renders lazy images, real alt text, captions, and keyboard-native video controls", () => {
  const entry = { ...plainEntry, pr: 80, media };
  validateEntries([entry]);
  const html = renderEntries([entry]);

  assert.match(html, /class="chg-entry chg-entry--media"/);
  assert.match(html, /loading="lazy" decoding="async"/);
  assert.match(html, /alt="The notice before the award watch button was added\."/);
  assert.match(html, /data-i18n-alt="chg_pr80_before_alt"/);
  assert.match(html, /<video controls preload="none"/);
  assert.match(html, /poster="media\/changelog\/pr-80\/after-390\.png"/);
  assert.match(html, /data-i18n="chg_pr80_recording_caption"/);
  assert.doesNotMatch(renderEntries([plainEntry]), /chg-media|<img|<video/);
});

test("before: malformed media could drift into generated HTML; after: the optional schema rejects incomplete or unsafe assets", () => {
  assert.throws(
    () => validateEntries([{ ...plainEntry, media: { screenshots: [] } }]),
    /media\.screenshots must contain at least one before\/after pair/,
  );
  assert.throws(
    () => validateEntries([{ ...plainEntry, pr: 80, media: { ...media, recording: { ...media.recording, src: "../outside.webm" } } }]),
    /must stay under media\/changelog\/pr-80\//,
  );
});
