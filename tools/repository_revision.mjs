import { execFileSync } from "node:child_process";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Resolve the capture branch tip even when Actions checked out its synthetic
 * pull-request merge commit. Local capture runs have no pull-request event and
 * use HEAD directly.
 */
function captureHead(cwd, mainRef) {
  const candidate = process.env.GITHUB_HEAD_SHA;
  if (candidate) {
    try {
      return git(["rev-parse", "--verify", `${candidate}^{commit}`], cwd);
    } catch {
      // Fall through to the merge-parent detection below.
    }
  }
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    try {
      const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"], cwd).split(/\s+/);
      if (parents.length === 3) {
        const [, firstParent, branchParent] = parents;
        if (git(["merge-base", firstParent, mainRef], cwd) === firstParent) return branchParent;
      }
    } catch {
      // Fall back to HEAD so the merge-base command reports the real failure.
    }
  }
  return "HEAD";
}

/** Return the commit shared by the capture branch and the fetched default branch. */
export function resolveRepositoryRevision(cwd, mainRef = "origin/main") {
  return git(["merge-base", captureHead(cwd, mainRef), mainRef], cwd);
}

/** Return the branch tip for optional, explicitly non-authoritative detail. */
export function branchHead(cwd) {
  return git(["rev-parse", "HEAD"], cwd);
}
