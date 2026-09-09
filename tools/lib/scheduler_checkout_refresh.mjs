import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { persistScheduleResult } from "../external_schedule_outbox.mjs";

export const CHECKOUT_FETCH_TIMEOUT_MS = 5_000;
export const CHECKOUT_REFUSAL_CYCLES = 24;
export const CHECKOUT_REFRESH_HANDOFF = "CITYSCROLL_CHECKOUT_REFRESH_RESULT";
const ISSUE_TITLE = "Scheduler configuration: checkout refresh refused";

// Git must address the supplied checkout even when called from a Git hook.
function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_COMMON_DIR"]) delete env[key];
  return env;
}

/** A bounded, shell-free Git process; cancellation also kills its transports. */
export function runCheckoutGit(root, args, { signal, spawnImpl = spawn } = {}) {
  return new Promise((resolveResult) => {
    if (signal?.aborted) return resolveResult({ code: 1, stdout: "", timed_out: true });
    const grouped = process.platform !== "win32";
    const child = spawnImpl("git", ["-C", root, ...args], {
      env: gitEnv(), detached: grouped, stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let timedOut = false;
    const cancel = () => {
      timedOut = true;
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* The process may have exited just before the deadline. */ }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(0, 64 * 1024); });
    const finish = (code) => {
      signal?.removeEventListener("abort", cancel);
      resolveResult({ code: code ?? 1, stdout, timed_out: timedOut });
    };
    child.on("error", () => finish(1));
    child.on("close", finish);
  });
}

/** Refresh only a clean default branch. Refusals never interrupt the cycle. */
export async function refreshSchedulerCheckout(root, {
  runGit = runCheckoutGit, fetchTimeoutMs = CHECKOUT_FETCH_TIMEOUT_MS,
} = {}) {
  const git = (args, signal) => runGit(root, args, { signal });
  const head = await git(["rev-parse", "HEAD"]);
  const before = head.code === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
  const receipt = { status: "refused", revision_before: before, revision_after: before, reason: null };
  const refuse = (reason) => ({ ...receipt, reason });
  if (!before) return refuse("revision-unresolved");
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0) return refuse("detached-head");
  const clean = async () => {
    const status = await git(["status", "--porcelain=v1", "--untracked-files=normal"]);
    return status.code !== 0 ? "status-unresolved" : status.stdout.trim() ? "dirty-tree" : null;
  };
  const dirty = await clean();
  if (dirty) return refuse(dirty);

  // Discovery and fetch share one deadline, including credential helpers. Do
  // not trust a cached origin/HEAD after the publisher changes its default.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const remote = await git(["ls-remote", "--symref", "origin", "HEAD"], controller.signal);
    if (remote.timed_out || controller.signal.aborted) return refuse("fetch-timeout");
    if (remote.code !== 0) return refuse("fetch-failed");
    const defaultBranch = /^ref: refs\/heads\/([^\s]+)\s+HEAD$/m.exec(remote.stdout)?.[1];
    if (!defaultBranch) return refuse("default-branch-unresolved");
    if (branch.stdout.trim() !== defaultBranch) return refuse("not-default-branch");
    // Fetch only the advertised branch into FETCH_HEAD. No force refspec, tag
    // updates, submodule fetches, or background maintenance are needed.
    const fetched = await git(["fetch", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance",
      "--refmap=", "origin", `refs/heads/${defaultBranch}`], controller.signal);
    if (fetched.timed_out || controller.signal.aborted) return refuse("fetch-timeout");
    if (fetched.code !== 0) return refuse("fetch-failed");
  } finally {
    clearTimeout(timer);
  }
  const target = await git(["rev-parse", "FETCH_HEAD^{commit}"]);
  if (target.code !== 0 || !/^[0-9a-f]{40}$/.test(target.stdout.trim())) return refuse("fetched-revision-unresolved");
  const after = target.stdout.trim();
  // Recheck after the network wait so edits or a branch switch during a fetch
  // cannot turn into an automatic merge on a different checkout state.
  const currentBranch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const currentHead = await git(["rev-parse", "HEAD"]);
  if (currentBranch.code !== 0 || currentHead.code !== 0 || currentBranch.stdout !== branch.stdout || currentHead.stdout.trim() !== before) {
    receipt.revision_after = /^[0-9a-f]{40}$/.test(currentHead.stdout.trim()) ? currentHead.stdout.trim() : null;
    return refuse("checkout-changed");
  }
  const changed = await clean();
  if (changed) return refuse(changed);
  if (before === after) return { ...receipt, status: "current" };
  const ancestor = await git(["merge-base", "--is-ancestor", before, after]);
  if (ancestor.code !== 0) return refuse(ancestor.code === 1 ? "diverged" : "ancestry-unresolved");
  // Disable configured autostash and hooks as well as rejecting non-FF merges.
  const merge = await git(["-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false",
    "merge", "--ff-only", "--no-autostash", after]);
  if (merge.code !== 0) return refuse("fast-forward-failed");
  return { ...receipt, status: "updated", revision_after: after };
}

/** Persist the consecutive-refusal count and use only the issue outbox. */
export async function recordCheckoutRefresh(stateDir, refresh, now) {
  const dir = join(stateDir, "checkout-refresh");
  const path = join(dir, "latest.json");
  let previous = null;
  try { previous = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const refused = refresh.status === "refused";
  const count = refused ? (previous?.consecutive_refusals || 0) + 1 : 0;
  const observedAt = now.toISOString();
  const episode = refused ? previous?.refusal_started_at || observedAt : null;
  const receipt = { ...refresh, consecutive_refusals: count, refusal_started_at: episode };
  if (count >= CHECKOUT_REFUSAL_CYCLES || (!refused && previous?.consecutive_refusals >= CHECKOUT_REFUSAL_CYCLES)) {
    const body = refused
      ? `Checkout refresh has been refused for at least ${CHECKOUT_REFUSAL_CYCLES} consecutive cycles. Reason: ${refresh.reason}. The scheduler continues on revision ${refresh.revision_after || "unknown"}. Restore a clean checkout on origin's default branch that can fast-forward, and check Git network access. This is a scheduler-configuration finding.`
      : `Checkout refresh recovered. The scheduler now runs revision ${refresh.revision_after}.`;
    await persistScheduleResult({
      stateDir, jobId: "scheduler-checkout-refresh", runKey: `${refused ? "refused" : "recovered"}-${episode || previous.refusal_started_at}`,
      now, result: { observed_at: observedAt, status: refused ? "configuration-error" : "healthy", body, checkout_refresh: receipt },
      issue: { mode: refused ? "open" : "close", title: ISSUE_TITLE, body },
    });
  }
  await mkdir(dir, { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await rename(temp, path);
  return receipt;
}

/** A fresh process loads updated imports before any monitor or repair runs. */
export function restartRefreshedCycle(root, argv, receipt, { spawnImpl = spawn, env = process.env } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawnImpl(process.execPath, argv, {
      cwd: root, stdio: "inherit", env: { ...env, [CHECKOUT_REFRESH_HANDOFF]: JSON.stringify(receipt) },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolveResult(code ?? 1));
  });
}
