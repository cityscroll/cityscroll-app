// Characterization tests for the changelog editorial gate:
// tools/gen_changelog.mjs's computeEntryAddition() now requires the `changelog:major`
// label in addition to a "## What this means for you" section before a merged PR earns a
// changelog.html entry (see tools/changelog_extract.mjs's header comment for why the
// marker section alone stopped being a significance signal).
//
// Before this gate existed: recent changelog.html entries had drifted into a near-mirror
// of the merged-PR log — every PR that carried a marker section got a line, regardless of
// whether a visitor would notice or care. Real production examples of the regression, all
// PR bodies pulled verbatim from this repo's own history:
//   - PR #77 (below) is a CI-only reliability fix; its own "What this means for you" text
//     admits as much ("No visible change to the site") yet still rendered as a changelog
//     entry.
//   - PR #55 (below) is a real bug fix (a broken click path), user-visible but not the kind
//     of change the pre-2026-07-10 curated page would have called out on its own.
//   - PR #70 (below) is a genuinely major feature debut (external-awards coverage) — the
//     kind of entry the page exists to surface.
//
// After: only a PR carrying BOTH the section and the label produces an entry. #77 and #55
// (unlabeled, as they actually shipped) produce nothing; #70, labeled `changelog:major` as
// it should have been, produces its entry.
import test from "node:test";
import assert from "node:assert/strict";
import { computeEntryAddition } from "../tools/gen_changelog.mjs";
import { MAJOR_LABEL } from "../tools/changelog_extract.mjs";

const PR_77_INTERNAL_TOOLING_BODY = `## Summary
Wires a pre-merge reading-level simulation into CI.

## What this means for you

No visible change to the site. A future code change that would make the changelog page
harder to read now gets flagged on its own pull request, before it merges, instead of
after.

## Test plan
- [x] node --test test/*.test.mjs — 260/260 pass
`;

const PR_55_MINOR_FIX_BODY = `## Summary
Fixes a click handler that silently no-op'd.

## What this means for you

Typing a query into the Alerts "Narrow by keyword" field and clicking Preview now works whether or not you've clicked a topic chip first — it's resolved the same way the "Ask" box already handles free-text queries, and you'll always see either a populated preview or a clear "we understood this as…" summary, never silence.

## Test plan
- [x] Reproduced the reported failure live against production before making any change
`;

const PR_70_MAJOR_TEXT =
  "When you open a notice or agency profile for a public authority that files its contract awards outside the City Record — like the School Construction Authority, NYC Health + Hospitals, NYCHA, or the Economic Development Corporation — the site now checks the authority's own open-data filing and shows what it found there, naming and linking the source and when it was last updated. If an agency's awards genuinely aren't published anywhere as open data, the site now says so plainly instead of leaving you guessing.";

const PR_70_MAJOR_BODY = `## Motivation
Several public authorities post their solicitations in the City Record but file the resulting awards elsewhere.

## What this means for you

${PR_70_MAJOR_TEXT}

## Validation
- Full Node and Worker test suites pass.
`;

test("an internal/tooling PR (real PR #77, unlabeled) produces no entry even though it carries the marker section", () => {
  const result = computeEntryAddition([], {
    number: 77,
    url: "https://github.com/cityscroll/crol-list/pull/77",
    mergedAt: "2026-07-17",
    body: PR_77_INTERNAL_TOOLING_BODY,
    labels: ["bug"],
  });
  assert.equal(result.reason, "not-major");
  assert.equal(result.text, null);
  assert.equal(result.entries.length, 0);
});

test("a minor-fix PR (real PR #55, unlabeled) produces no entry even though the fix is genuinely user-visible", () => {
  const result = computeEntryAddition([], {
    number: 55,
    url: "https://github.com/cityscroll/crol-list/pull/55",
    mergedAt: "2026-07-15",
    body: PR_55_MINOR_FIX_BODY,
    labels: [],
  });
  assert.equal(result.reason, "not-major");
  assert.equal(result.entries.length, 0);
});

test("a major user-facing PR (real PR #70), labeled changelog:major, produces its entry", () => {
  const result = computeEntryAddition([], {
    number: 70,
    url: "https://github.com/cityscroll/crol-list/pull/70",
    mergedAt: "2026-07-17",
    body: PR_70_MAJOR_BODY,
    labels: ["enhancement", MAJOR_LABEL],
  });
  assert.equal(result.reason, "added");
  assert.equal(result.text, PR_70_MAJOR_TEXT);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].pr, 70);
});

test("the changelog:major label alone, with no marker section, still produces no entry", () => {
  const result = computeEntryAddition([], {
    number: 99,
    url: "https://example.invalid/99",
    mergedAt: "2026-07-20",
    body: "## Summary\nJust a summary, no impact section.\n",
    labels: [MAJOR_LABEL],
  });
  assert.equal(result.reason, "no-marker");
  assert.equal(result.entries.length, 0);
});

test("an already-recorded PR number stays a no-op regardless of label", () => {
  const existing = [{ pr: 70, merged_at: "2026-07-17", url: "", text: "already here" }];
  const result = computeEntryAddition(existing, {
    number: 70,
    url: "https://example.invalid/70",
    mergedAt: "2026-07-17",
    body: PR_70_MAJOR_BODY,
    labels: [MAJOR_LABEL],
  });
  assert.equal(result.reason, "already-recorded");
  assert.equal(result.entries, existing);
});

// A consolidated entry (several related PRs folded into one user story, see AGENTS.md's
// changelog section) must keep every folded-in PR number "already recorded" — otherwise a
// PR that consolidation absorbed into entry #80's merged_prs would look unrecorded the next
// time this function runs and the bot would append a stray duplicate entry for it.
test("a PR folded into a consolidated entry's merged_prs stays a no-op, not just the primary pr", () => {
  const existing = [
    {
      pr: 80,
      merged_at: "2026-07-17",
      url: "https://example.invalid/80",
      text: "The consolidated external-awards story.",
      merged_prs: [
        { pr: 70, url: "https://example.invalid/70" },
        { pr: 76, url: "https://example.invalid/76" },
        { pr: 80, url: "https://example.invalid/80" },
      ],
    },
  ];
  for (const number of [70, 76, 80]) {
    const result = computeEntryAddition(existing, {
      number,
      url: `https://example.invalid/${number}`,
      mergedAt: "2026-07-17",
      body: PR_70_MAJOR_BODY,
      labels: [MAJOR_LABEL],
    });
    assert.equal(result.reason, "already-recorded", `PR #${number} should already be recorded`);
    assert.equal(result.entries, existing);
  }
});
