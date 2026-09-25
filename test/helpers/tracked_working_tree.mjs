import { spawnSync } from "node:child_process";

/**
 * Return `git status --porcelain` for tracked paths only.
 * Untracked scratch under ignored paths is out of scope for time-travel hermeticity.
 */
export function trackedWorkingTreePorcelain(cwd = process.cwd(), { paths = [] } = {}) {
  const args = ["status", "--porcelain", "--untracked-files=no"];
  if (paths.length) args.push("--", ...paths);
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim() || `exit ${result.status}`;
    throw new Error(`git status --porcelain failed: ${detail}`);
  }
  return String(result.stdout || "").trim();
}

export function assertTrackedWorkingTreeClean(cwd = process.cwd(), options = {}) {
  const dirty = trackedWorkingTreePorcelain(cwd, options);
  if (!dirty) return;
  const error = new Error(`tracked working tree is dirty after suite:\n${dirty}`);
  error.code = "TRACKED_WORKING_TREE_DIRTY";
  throw error;
}
