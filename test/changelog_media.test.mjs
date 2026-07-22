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

test("a recording-only entry (no screenshots key) renders the recording figure with no screenshot markup and no orphaned viewport heading", () => {
  const entry = { ...plainEntry, pr: 80, media: { recording: media.recording } };
  validateEntries([entry]);
  const html = renderEntries([entry]);

  assert.match(html, /<figure class="chg-media-recording">/);
  assert.match(html, /<video controls preload="none"/);
  assert.doesNotMatch(html, /chg-media-pair|chg-media-grid|chg-media-shot|<img|chg_media_viewport/);
});

test("a screenshots-only entry (single 1440 pair, no recording) renders the pair with no video markup and no orphaned recording caption", () => {
  const singlePair = {
    screenshots: [
      {
        viewport: 1440,
        width: 1440,
        height: 900,
        before: {
          src: "media/changelog/pr-62/before-1440.png",
          alt: "Before the reform.",
          alt_i18n: "chg_pr62_before_alt",
        },
        after: {
          src: "media/changelog/pr-62/after-1440.png",
          alt: "After the reform.",
          alt_i18n: "chg_pr62_after_alt",
        },
      },
    ],
  };
  const entry = { ...plainEntry, pr: 62, media: singlePair };
  validateEntries([entry]);
  const html = renderEntries([entry]);

  assert.match(html, /class="chg-media-pair"/);
  assert.match(html, /1440 px/);
  assert.doesNotMatch(html, /<video|chg-media-recording|chg_media_recording/);
  // Exactly one pair section — no second, empty viewport heading left dangling.
  assert.equal((html.match(/class="chg-media-pair"/g) || []).length, 1);
});

test("before: a consolidated entry had no way to record which PRs it folded in; after: merged_prs is validated and must include the entry's own primary pr", () => {
  const consolidated = {
    ...plainEntry,
    pr: 80,
    merged_prs: [
      { pr: 70, url: "https://github.com/cityscroll/crol-list/pull/70" },
      { pr: 76, url: "https://github.com/cityscroll/crol-list/pull/76" },
      { pr: 80, url: "https://github.com/cityscroll/crol-list/pull/80" },
    ],
  };
  assert.doesNotThrow(() => validateEntries([consolidated]));
  assert.throws(
    () => validateEntries([{ ...plainEntry, pr: 80, merged_prs: [{ pr: 70, url: "https://x/70" }] }]),
    /merged_prs must be an array of at least two \{pr, url\} entries/,
  );
  assert.throws(
    () =>
      validateEntries([
        { ...plainEntry, pr: 80, merged_prs: [{ pr: 70, url: "https://x/70" }, { pr: 76, url: "https://x/76" }] },
      ]),
    /merged_prs must include the entry's own primary pr \(80\)/,
  );
});
