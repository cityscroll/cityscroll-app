// Contract test: the City-Record-HTML-in-match-evidence bug (see docs/drift-inventory.md #2),
// fixed once already in commit 3ff6825 for the emailed digest (worker/src/lib/digest.mjs) but
// never given a test that runs the SAME fixture through both sides. This is exactly the
// "shared fixture, both implementations must produce identical output" floor the drift-guard
// task asked for on this specific pair.
//
// The two sides have a documented, deliberately different contract, not a bug: the worker's
// matchEvidence() self-strips HTML defensively (raw City Record fields reach it directly);
// index.html's matchEvidence() expects the caller to have already run cleanText() first (every
// real call site does — matchText() in index.html always cleans before calling it). This test
// exercises that real contract — worker gets the raw HTML, site gets it pre-cleaned the way
// every actual call site provides it — and then asserts the two land on the same field/snippet,
// so a future change to either side's stripping can't quietly re-diverge them.
//
//   node --test test/contract/match_evidence_html.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSite } from "./site_extract.mjs";
import { matchEvidence as workerMatchEvidence } from "../../worker/src/lib/digest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = JSON.parse(readFileSync(join(ROOT, "test/contract/fixtures/match_evidence_html.json"), "utf8"));

const { cleanText, locateAnyTerm, matchEvidence: siteMatchEvidence } = loadSite(["cleanText", "locateAnyTerm", "matchEvidence"]);

// Site cleanText and worker stripHtml now share site/text_clean.mjs entity decode, so snippets
// compare directly (no secondary entity-normalize pass). Raw tags must still be gone.

function joined(ev) {
  if (!ev) return "";
  if (ev.field === "description") return `${ev.before}${ev.hit}${ev.after}`;
  return ev.term || ev.hit || "";
}

for (const { title, rawDescription, keywords, note } of fixtures) {
  test(`matchEvidence agrees on field + snippet content — ${note}`, () => {
    const workerEv = workerMatchEvidence(title, rawDescription, keywords);
    const siteEv = siteMatchEvidence(cleanText(title), cleanText(rawDescription), keywords);

    assert.equal(siteEv?.field, workerEv?.field, `field mismatch: site=${siteEv?.field} worker=${workerEv?.field}`);

    const workerText = joined(workerEv);
    const siteText = joined(siteEv);
    assert.equal(siteText, workerText);

    // Angle brackets may remain as decoded text from &lt;/&gt; entities (then re-escaped at
    // HTML render time); raw HTML *tags* must not survive stripping.
    assert.doesNotMatch(workerText, /<\/?[a-z][^>]*>/i, "worker snippet must contain no raw tags");
    assert.doesNotMatch(siteText, /<\/?[a-z][^>]*>/i, "site snippet must contain no raw tags");
  });
}
