import { execFileSync, spawnSync } from "node:child_process";

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

/**
 * Check whether a retained browser measurement still describes the executing
 * tree. The capture must be in this tree's history, and every declared input
 * must be byte-identical in Git since the capture.
 */
export function retainedMeasurementStatus(cwd, { revision, head = "HEAD", inputPaths }) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new TypeError("retained measurement requires at least one input path");
  }
  const captureRevision = git(["rev-parse", "--verify", `${revision}^{commit}`], cwd);
  const currentRevision = git(["rev-parse", "--verify", `${head}^{commit}`], cwd);
  const ancestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", captureRevision, currentRevision],
    { cwd, stdio: "ignore" },
  ).status === 0;
  if (!ancestor) {
    return {
      ok: false,
      reason: "capture revision is not an ancestor of the executing tree",
      captureRevision,
      currentRevision,
      changedInputs: [],
    };
  }
  const changed = git(
    ["diff", "--name-only", `${captureRevision}..${currentRevision}`, "--", ...inputPaths],
    cwd,
  );
  const changedInputs = changed ? changed.split("\n") : [];
  return {
    ok: changedInputs.length === 0,
    reason: changedInputs.length === 0 ? null : "measured inputs changed after capture",
    captureRevision,
    currentRevision,
    changedInputs,
  };
}
