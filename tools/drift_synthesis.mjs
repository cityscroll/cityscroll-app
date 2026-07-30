#!/usr/bin/env node
// tools/drift_synthesis.mjs — local runner for the cross-implementation drift check: layer 2
// of docs/drift-inventory.md's guard. test/contract/ is the deterministic floor (a fixture test
// per testable pair, wired into required CI). This script covers the remainder — drift that
// isn't a pure function with a fixture, or is a documented judgment-shaped gap — by asking
// Claude Code to review a PR's diff against the committed inventory and post one plain-language
// comment if it spots likely cross-implementation drift.
//
// This does NOT run in GitHub Actions. It runs wherever an operator already has both `gh` and
// the Claude Code CLI (`claude`) authenticated, invoked by hand or by whatever schedules a call
// per PR touching site/worker code. No repo secret, no GitHub App install — it uses the
// operator's own already-authenticated CLIs, the same as running `gh pr comment` by hand would.
//
// Usage:
//   node tools/drift_synthesis.mjs --pr <number> [--repo owner/name] [--dry-run]
//
// --dry-run prints the review to stdout instead of posting/updating a PR comment.
//
// Behavior: fetches the PR's diff (`gh pr diff`), reads docs/drift-inventory.md, asks Claude
// (model pinned, no tool access needed — everything it needs is already in the prompt) to
// review, then posts ONE comment per PR — a repeat run edits that same comment (found via a
// hidden marker) rather than piling up duplicates.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "claude-sonnet-5";
const COMMENT_MARKER = "<!-- drift-synthesis-comment -->";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 });
}

function main() {
  const prNumber = arg("pr");
  if (!prNumber) {
    console.error("usage: node tools/drift_synthesis.mjs --pr <number> [--repo owner/name] [--dry-run]");
    process.exit(1);
  }
  const repoFlag = arg("repo");
  const repoArgs = repoFlag ? ["--repo", repoFlag] : [];
  const repo = repoFlag || run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();

  const inventory = readFileSync(join(ROOT, "docs", "drift-inventory.md"), "utf8");
  const diff = run("gh", ["pr", "diff", prNumber, ...repoArgs]);

  const prompt = buildPrompt({ repo, prNumber, inventory, diff });
  const review = run("claude", [
    "-p", prompt,
    "--model", MODEL,
    "--disallowedTools", "Bash,Edit,Write,WebFetch,WebSearch",
  ]).trim();

  const body = `${COMMENT_MARKER}\n${review}`;

  if (hasFlag("dry-run")) {
    console.log(body);
    return;
  }
  postOrUpdateComment({ repo, prNumber, body });
}

function buildPrompt({ repo, prNumber, inventory, diff }) {
  return [
    `REPO: ${repo}`,
    `PR NUMBER: ${prNumber}`,
    "",
    "crol-list is a static site (site/index.html and site/i18n.js/site/nl_parse.js/",
    "site/external_awards.js) plus a Cloudflare Worker (worker/src/). The two can't share code across",
    "that boundary, so a fixed set of rules is implemented independently on both sides \"by",
    "hand\" — the document below (docs/drift-inventory.md) is the committed list of every place",
    "this happens, which pairs already have an automated cross-check (test/contract/), and which",
    "are documented one-way gaps.",
    "",
    "--- docs/drift-inventory.md ---",
    inventory,
    "--- end docs/drift-inventory.md ---",
    "",
    "--- PR diff ---",
    diff,
    "--- end PR diff ---",
    "",
    "Your ONLY job is spotting cross-implementation drift in this diff: places where it changes",
    "a rule on one side (site/index.html/site/i18n.js/site/nl_parse.js/site/external_awards.js) without a matching",
    "change on the worker side (worker/src/**), or vice versa — including a NEW dual-implemented",
    "rule this diff introduces that isn't in the inventory yet. Do not review anything else",
    "(style, security, performance, accessibility, tests) — those are out of scope for this check.",
    "",
    "For each pair already listed as \"tested\" in the inventory, a contract test already catches",
    "drift automatically — do not re-flag those unless the diff appears to be trying to route",
    "around the test (e.g. duplicating logic under a new name). Focus on:",
    "- Untested and one-way-gap pairs listed in the document",
    "- Any new rule this diff adds to one side that looks like it should have a counterpart on",
    "  the other, given the existing dual-implementation pattern",
    "",
    "Respond in plain, professional language — a public civic-tech project's PR, not an internal",
    "tool's output. No internal jargon, no mention of any internal automation or process by name,",
    "no transcript-style narration of your own reasoning steps.",
    "",
    "Format your entire response as:",
    "## Cross-implementation drift check",
    "",
    "If nothing found: one line saying so plainly, e.g. \"No cross-implementation drift found in",
    "this diff.\" If something found: a short bullet list, each bullet naming the file/line on",
    "both sides and the one-sentence risk in plain language — mirror the phrasing style of the",
    "inventory document's own entries. End with one line noting this check is informational and",
    "does not block merging.",
  ].join("\n");
}

function postOrUpdateComment({ repo, prNumber, body }) {
  const comments = JSON.parse(
    run("gh", ["api", `repos/${repo}/issues/${prNumber}/comments`, "--paginate"]),
  );
  const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));

  if (existing) {
    run("gh", ["api", `repos/${repo}/issues/comments/${existing.id}`, "-X", "PATCH", "-f", `body=${body}`]);
    console.log(`Updated existing comment ${existing.html_url}`);
  } else {
    run("gh", ["api", `repos/${repo}/issues/${prNumber}/comments`, "-X", "POST", "-f", `body=${body}`]);
    console.log(`Posted a new comment on PR #${prNumber}`);
  }
}

main();
