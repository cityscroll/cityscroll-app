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

/**
 * Compare a prior porcelain snapshot to the current tracked tree.
 * Suites that may start on an intentionally dirty tree use this so the run
 * cannot introduce additional tracked-path residue.
 */
export function assertTrackedWorkingTreeUnchanged(baselinePorcelain, cwd = process.cwd(), options = {}) {
  const before = String(baselinePorcelain || "").trim();
  const after = trackedWorkingTreePorcelain(cwd, options);
  if (before === after) return;
  const error = new Error(
    `tracked working tree changed during suite:\nbefore:\n${before || "(clean)"}\nafter:\n${after || "(clean)"}`,
  );
  error.code = "TRACKED_WORKING_TREE_CHANGED";
  error.before = before;
  error.after = after;
  throw error;
}
