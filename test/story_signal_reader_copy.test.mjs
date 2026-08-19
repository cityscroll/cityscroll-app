import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildPrivateStorySignalProjection,
  detectStorySignalCardSlop,
  gateStorySignalCard,
  renderPrivateStorySignalPage,
  renderStorySignalCard,
} from "../site/story_signal_projection.mjs";

const admitted = JSON.parse(readFileSync(
  new URL("../site/data/comparative_story_signals.json", import.meta.url),
  "utf8",
));

test("cards use the required story anatomy and put the comparison basis in the headline", () => {
  const projection = buildPrivateStorySignalProjection(admitted);
  const card = projection.cards[0];
  const html = renderStorySignalCard(card);

  assert.equal(projection.cards.length, 1);
  assert.match(html, /What stands out/);
  assert.match(html, /This \$53\.0M award is 4th-largest among 264 Housing Preservation and Development award rows observed in the OCP snapshot from Jan\. 1, 2024 through Aug\. 5, 2026\./);
  assert.match(html, /What happened/);
  assert.match(html, /Context/);
  assert.match(html, /Next/);
  for (const action of [
    "Open source record",
    "Inspect process",
    "View peer group",
    "Follow similar awards",
    "Add to Investigation",
  ]) {
    assert.match(html, new RegExp(action));
  }
  assert.match(html, /href="\/#investigation\/signal\/story_signal%3Acomparative_fact%3A/);
  assert.match(html, /<article[^>]+aria-labelledby=/);
  assert.match(html, /<nav[^>]+aria-label="Next steps for/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.deepEqual(detectStorySignalCardSlop(html), []);
});

test("anti-slop gate rejects debug, adjective, disclaimer, and significance theater", () => {
  const cases = [
    ["HELD_MNAR", "backstage state"],
    ["join_coverage: 61%", "debug field"],
    ["snapshot_sha abc123", "debug field"],
    ["A shocking and suspicious award", "adjective theater"],
    ["Statistically significant anomaly score", "significance theater"],
    ["For informational purposes only; interpret with caution", "disclaimer slop"],
  ];
  for (const [copy, expected] of cases) {
    assert.ok(detectStorySignalCardSlop(`<article>${copy}</article>`).includes(expected), copy);
    assert.throws(() => gateStorySignalCard(`<article>${copy}</article>`), /Story-signal card contains/);
  }
});

test("the complete private page has accessible static landmarks and no leaked backstage vocabulary", () => {
  const html = renderPrivateStorySignalPage(buildPrivateStorySignalProjection(admitted));
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /<a class="skip" href="#main">Skip to content<\/a>/);
  assert.match(html, /<main id="main"/);
  assert.match(html, /<h1>Worth a look<\/h1>/);
  assert.match(html, /<section class="story-signal-feed" aria-label="Worth-a-look signals">/);
  assert.doesNotMatch(html, /HELD_MNAR|held_mnar|join_coverage|join_rate|snapshot_sha|source_errors|gate_id|reason_codes/i);
  assert.doesNotMatch(html, /shocking|massive|surge|suspicious|p[- ]?value|anomaly score|scandal meter/i);
  assert.doesNotMatch(html, /for informational purposes only|not a substitute for|interpret with caution|data may be incomplete/i);
});
