// Contract test: the prior-cycle (strict) and near-match (looser) rankers must return
// byte-identical results on both sides for every fixture case (see docs/drift-inventory.md #6,
// #7). worker/src/lib/prior_cycle.mjs's own header calls index.html's copies "the SOURCE OF
// TRUTH" for this heuristic and says it "must not diverge or the Phase 1b client swap ... will
// surface different results than the reader previously saw" — this test is exactly the
// automation that claim depended on someone remembering to run by hand.
//
// Rather than hand-asserting which tier each fixture should land in (easy to get subtly wrong
// re-deriving the 0.5/0.34 score bars by hand), this compares site vs. worker output directly for
// both tiers — the two must agree on the RESULT, whatever it is.
//
//   node --test test/contract/prior_cycle.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSite } from "./site_extract.mjs";
import {
  rankPriorCycleCandidates as workerRankStrict,
  rankNearMatchCandidates as workerRankNear,
} from "../../worker/src/lib/prior_cycle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = JSON.parse(readFileSync(join(ROOT, "test/contract/fixtures/prior_cycle.json"), "utf8"));

const {
  usablePin, pinBase, isBlanketChain,
  priorCycleTitleWords, daysBetween, rankPriorCycleCandidates: siteRankStrict,
  pinPrefixShared, nearMatchReasons, rankNearMatchCandidates: siteRankNear,
} = loadSite([
  "JUNK_PINS", "JUNK_PIN_TEXT_RE", "usablePin",
  "RENEWAL_SUFFIX_RE", "pinBase",
  "isBlanketChain",
  "PRIOR_CYCLE_MIN_GAP_DAYS", "PRIOR_CYCLE_MAX_MATCHES", "PRIOR_CYCLE_STOPWORDS",
  "priorCycleTitleWords", "daysBetween", "rankPriorCycleCandidates",
  "NEAR_MATCH_MIN_SCORE", "NEAR_MATCH_MAX_MATCHES", "NEAR_MATCH_PIN_PREFIX_MIN_LEN", "NEAR_MATCH_AMOUNT_RATIO_MAX",
  "pinPrefixShared", "nearMatchReasons", "rankNearMatchCandidates",
]);

for (const { notice, candidates, note } of fixtures) {
  test(`strict tier agrees across site and worker — ${note}`, () => {
    assert.deepEqual(siteRankStrict(notice, candidates), workerRankStrict(notice, candidates));
  });

  test(`near-match tier agrees across site and worker (fed each side's own strict result) — ${note}`, () => {
    const siteStrict = siteRankStrict(notice, candidates);
    const workerStrict = workerRankStrict(notice, candidates);
    assert.deepEqual(
      siteRankNear(notice, candidates, siteStrict),
      workerRankNear(notice, candidates, workerStrict),
    );
  });
}
