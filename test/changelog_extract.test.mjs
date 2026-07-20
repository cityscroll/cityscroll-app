// Characterization tests for tools/changelog_extract.mjs, the parser that decides which
// merged PRs get a changelog.html entry (see CONTRIBUTING.md's "Changelog entries" section).
//
// Both fixtures are real merged-PR bodies from this repo's own history (crol-list #26 and
// #33). Neither PR actually carried the "## What this means for you" marker — the
// convention postdates them — so the "has a marker" fixture is #26's real body with that
// section appended, exactly as a future PR author would write it. #33 is used verbatim: a
// real plumbing PR (a deploy-workflow addition) that should produce nothing.
//
// PR_26_SUMMARY quotes the tagline PR #26 actually shipped ("Track NYC contracts,
// rezonings, and hearings — in plain English."), which the site later replaced (see
// AGENTS.md's i18n section). This is a frozen historical record, not a live copy of the
// current tagline — don't "fix" it to match today's wording, and don't read anything about
// current site copy from it. The assertions below only check the extractor's parsing
// logic, never the tagline text itself.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractUserImpact, hasMajorLabel, MAJOR_LABEL } from "../tools/changelog_extract.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PR_26_SUMMARY = `## Summary
- The front-page notice count now says "today" explicitly (e.g. "36 notices today, from 16 agencies") instead of an unqualified count, so it's clear the number reflects today's notices without having to infer it from the dateline above.
- Digest preview rows for RFP and award items had titles that looked clickable but weren't — only the Respond/contact links worked. Their titles now link to the notice detail page, mirroring the pattern already used for regular-notice rows.
- Added a one-line tagline under the masthead ("Track NYC contracts, rezonings, and hearings — in plain English.") so first-time visitors have a sense of what the site does before hitting the notice count and tabs.

All new/changed strings are translated across the full shipping-language set (es, zh-Hans, ru, bn, ht, ko, fr, pl, ar, ur).
`;

const PR_26_USER_IMPACT_LINE =
  "The homepage now says how many notices came in today, digest email titles are clickable, and a new tagline explains what the site does.";

const PR_26_BODY_WITH_MARKER = `${PR_26_SUMMARY}
## What this means for you
${PR_26_USER_IMPACT_LINE}

## Test plan
- [x] node --test test/*.test.mjs — 22/22 pass
- [x] python3 test/standards/i18n_keys.py — full key parity across all 10 shipping languages
`;

const PR_33_BODY_NO_MARKER = `## Summary
- Add \`.github/workflows/deploy-worker.yml\`: deploys the Cloudflare Worker (api.crol-list.org) on every push to \`main\` that touches \`worker/**\`, via \`cloudflare/wrangler-action@v3.14.1\` (pinned to a full version), plus \`workflow_dispatch\` for manual re-runs.
- Serialize deploys with a \`concurrency: worker-deploy\` group (\`cancel-in-progress: false\`) so two quick merges deploy in order instead of racing.
- Code-only deploy: no \`secrets:\`/\`vars:\` inputs, no \`wrangler secret put\` — avoids the documented gotcha where a \`[vars]\` entry can silently overwrite a live secret of the same name.

Closes the gap where the static site auto-deploys on merge but the API only deployed when someone ran \`wrangler\` by hand.

## Follow-up note
The \`CLOUDFLARE_API_TOKEN\` repo secret still needs to be provisioned (out of scope for this PR).

## Test plan
- [x] YAML parses cleanly
- [ ] gh workflow list shows Deploy worker after merge
`;

test("a merged PR body carrying the marker section produces exactly its user-impact line", () => {
  assert.equal(extractUserImpact(PR_26_BODY_WITH_MARKER), PR_26_USER_IMPACT_LINE);
});

test("a merged PR body with no marker section produces nothing", () => {
  assert.equal(extractUserImpact(PR_33_BODY_NO_MARKER), null);
});

test("an empty or missing body produces nothing", () => {
  assert.equal(extractUserImpact(""), null);
  assert.equal(extractUserImpact(null), null);
  assert.equal(extractUserImpact(undefined), null);
});

test("the marker heading is case-insensitive and tolerates ### instead of ##", () => {
  const body = "## Summary\nSome plumbing.\n\n### WHAT THIS MEANS FOR YOU\nYou can now do the thing.\n";
  assert.equal(extractUserImpact(body), "You can now do the thing.");
});

test("collects a multi-line marker section up to the next heading or blank line", () => {
  const body = "## What this means for you\nFirst line of the statement,\nsecond line continues it.\n\n## Test plan\n- [x] done\n";
  assert.equal(
    extractUserImpact(body),
    "First line of the statement, second line continues it."
  );
});

// The self-updating workflow's own convergence claim (see AGENTS.md's "Changelog" section
// and .github/workflows/update-changelog.yml's header comment): the bot's PR body carries no
// marker BY CONSTRUCTION, so its own eventual merge produces no new entry and the chain
// terminates. This reads the real file the workflow ships (not a copy), so an edit that
// accidentally introduces a marker section breaks this test immediately.
test("the changelog bot's own PR body produces nothing (the loop's convergence point)", () => {
  const botBody = fs.readFileSync(path.join(ROOT, ".github", "changelog-bot-pr-body.md"), "utf8");
  assert.equal(extractUserImpact(botBody), null);
});

// crol-changelogcurate-m6: a bullet-list-formatted marker section used to leak a literal
// "-" into the joined text — real field case, PR #76's harvested entry read "- Every note
// that says your answer lives in another public system now hands you the door: ...".
test("a marker section written as a bullet list has its list markers stripped, not leaked into the joined sentence", () => {
  const body = "## What this means for you\n- Every note now links through.\n- A dead mention says so honestly.\n\n## Test plan\n";
  assert.equal(
    extractUserImpact(body),
    "Every note now links through. A dead mention says so honestly."
  );
});

test("hasMajorLabel matches the changelog:major label case-insensitively among a PR's other labels", () => {
  assert.equal(hasMajorLabel(["enhancement", MAJOR_LABEL]), true);
  assert.equal(hasMajorLabel(["Changelog:Major"]), true);
  assert.equal(hasMajorLabel(["enhancement", "bug"]), false);
  assert.equal(hasMajorLabel([]), false);
  assert.equal(hasMajorLabel(null), false);
  assert.equal(hasMajorLabel(undefined), false);
});
