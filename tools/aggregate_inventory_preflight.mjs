/**
 * Merge-group aggregation preflight for the shipped-site inventory.
 *
 * The merge queue validates a pull request against the tip of main it is
 * *combined with*, not the base the branch was cut from. A branch cut before a
 * newly required global gate landed — for example the site-production
 * determinism inventory in architecture/site-production-determinism.json,
 * introduced after some open branches were already green — can pass every check
 * on its own head yet fail the instant it is combined with current main in a
 * merge group. Under the queue's ALLGREEN grouping that failure ejects every
 * other green pull request batched alongside it, so a single stale branch
 * repeatedly evicts innocent work and burns queue cycles.
 *
 * The branch's own checks never see the violation because they were computed
 * against its stale base: the gate — and the inventory it guards — may not even
 * exist in that checkout, so nothing evaluates the new module. GitHub does not
 * re-run a green branch when main advances, so the stale pass persists until the
 * merge group finally builds the combined tree and fails.
 *
 * This preflight reproduces that combined tree ahead of the queue. It merges the
 * live base branch into the pull-request head in a throwaway checkout and runs
 * the aggregate shipped-site inventory check against the result. A branch that
 * would poison a merge group turns red on its own checks first, before it ever
 * reaches the queue, and is fixed rather than left to eject batched work.
 *
 *   node tools/aggregate_inventory_preflight.mjs            # merge origin/main into HEAD
 *   node tools/aggregate_inventory_preflight.mjs --fetch    # fetch origin/main first (CI)
 *   node tools/aggregate_inventory_preflight.mjs --base main --head my-branch --repo DIR
 *
 * The inventory is the aggregate invariant proven to have ejected green work;
 * other combined-tree invariants (for example architecture-id uniqueness) can be
 * folded into simulateMergeGroup the same way as they earn their own evidence.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lintSiteProduction, SITE_INVENTORY_PATH } from "./determinism_lint.mjs";
import { isolatedGitEnv } from "./architecture_evidence_shards.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function git(repo, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: isolatedGitEnv() });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

function revParse(repo, ref) {
  return git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).stdout.trim();
}

export function parseArgs(argv) {
  const args = { repo: ROOT, base: "origin/main", head: "HEAD", fetch: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--fetch") args.fetch = true;
    else if (token === "--repo") args.repo = argv[(i += 1)];
    else if (token === "--base") args.base = argv[(i += 1)];
    else if (token === "--head") args.head = argv[(i += 1)];
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

/**
 * Merge `base` into `head` in a throwaway checkout and evaluate the shipped-site
 * inventory against the combined tree — the same tree a merge group builds.
 * Returns the resolved endpoints, any inventory issues, and whether the branch
 * merges cleanly at all (a dirty merge is itself a queue-blocking signal).
 */
export function simulateMergeGroup({ repo = ROOT, base = "origin/main", head = "HEAD", fetch = false } = {}) {
  let fetched = false;
  if (fetch) {
    // A single-branch or shallow CI checkout may not track the base branch yet.
    // The fetch is best-effort: if it fails but the base already resolves (an
    // existing remote-tracking ref), that is enough to simulate the merge and a
    // transient network or credential hiccup must not fail the branch's checks.
    const branch = base.replace(/^origin\//, "");
    fetched = git(repo, ["fetch", "--no-tags", "origin", branch], { allowFailure: true }).status === 0;
  }
  // Resolve both endpoints before building the checkout so a bad ref fails
  // loudly rather than silently merging nothing. FETCH_HEAD is the fallback for
  // a checkout that fetched the base branch without a remote-tracking ref.
  const headSha = revParse(repo, head);
  let baseSha;
  try {
    baseSha = revParse(repo, base);
  } catch (error) {
    if (!fetched) throw error;
    baseSha = revParse(repo, "FETCH_HEAD");
  }

  const holder = mkdtempSync(path.join(tmpdir(), "cityscroll-merge-group-preflight-"));
  const combined = path.join(holder, "combined");
  try {
    git(repo, ["worktree", "add", "--detach", "--force", combined, headSha]);
    const merge = git(
      combined,
      [
        "-c",
        "user.email=preflight@cityscroll.invalid",
        "-c",
        "user.name=merge-group preflight",
        "merge",
        "--no-ff",
        "--no-edit",
        baseSha,
      ],
      { allowFailure: true },
    );
    if (merge.status !== 0) {
      const conflicts = git(combined, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true })
        .stdout.split(/\r?\n/)
        .filter(Boolean);
      git(combined, ["merge", "--abort"], { allowFailure: true });
      return {
        baseSha,
        headSha,
        conflict: true,
        conflicts,
        covered: [],
        issues: [
          `the branch does not merge cleanly into ${base}; the merge queue will reject the combined tree`,
          ...conflicts.map((file) => `conflict: ${file}`),
        ],
      };
    }
    const report = lintSiteProduction({ root: combined });
    return { baseSha, headSha, conflict: false, conflicts: [], covered: report.covered, issues: report.issues };
  } finally {
    git(repo, ["worktree", "remove", "--force", combined], { allowFailure: true });
    rmSync(holder, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  let result;
  try {
    result = simulateMergeGroup(args);
  } catch (error) {
    process.stderr.write(`merge-group preflight could not run: ${error.message}\n`);
    return 2;
  }

  process.stdout.write(
    `merge-group preflight: ${args.head} (${result.headSha.slice(0, 9)}) combined with ${args.base} (${result.baseSha.slice(0, 9)})\n`,
  );
  if (result.issues.length) {
    if (result.conflict) {
      process.stderr.write("the branch does not merge cleanly into the base the merge queue will build:\n");
    } else {
      process.stderr.write(
        `${SITE_INVENTORY_PATH} does not describe the combined tree the merge queue will build:\n`,
      );
    }
    process.stderr.write(`${result.issues.map((issue) => `  ${issue}`).join("\n")}\n`);
    if (!result.conflict) {
      process.stderr.write(
        "\nRebase this branch on current main, then run `node tools/determinism_lint.mjs --write-site-inventory` and commit the result.\n",
      );
    }
    return 1;
  }
  process.stdout.write(
    `combined tree inventory is complete (${result.covered.length} production site modules covered).\n`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
