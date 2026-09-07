import { readFileSync, statSync } from "node:fs";

/**
 * How an explicitly configured credential file failed, in the vocabulary the
 * receipt is allowed to publish. The class names the operator's next move; the
 * path and the file's contents are never part of it, so a receipt can be read
 * and forwarded without carrying a secret or a host layout with it.
 */
export const CREDENTIAL_FAILURES = {
  absent: "absent",
  empty: "empty",
  unreadable: "unreadable",
  "insecure-permissions": "readable by more than its owner; require mode 0600 or stricter",
  "not-a-file": "not a regular file",
  // A credential assembled from several files is configured as a set. One
  // variable left unset is a half-installed identity, which must read as a
  // stated misconfiguration rather than as a quiet fall back to another one.
  unset: "unset while the rest of the credential's variables are configured",
  // The file was readable and non-empty but does not hold what the credential
  // requires — a non-numeric identifier, or a key no parser accepts. The class
  // says which file to reinstall without quoting a byte of it.
  malformed: "not in the form this credential requires",
};

/**
 * Resolve one credential the same way for every secret the cycle needs.
 *
 * Explicit file configuration is authoritative. When a file variable names a
 * path, that file is the only accepted source for the cycle: absent, empty,
 * unreadable, or readable by anyone but its owner all resolve to no credential,
 * and none of them fall back to an inline export or to whatever interactive
 * GitHub CLI session happens to exist on the host. Failing closed is the point.
 * The whole reason the token is a dedicated machine identity is that a monitor
 * finding must never be filed, or an issue closed, under a person's account
 * because a file was misinstalled.
 *
 * An inline export is honoured only where no file variable is configured at
 * all, which is how a rehearsal on a workstation still runs.
 *
 * launchd starts an agent with no login shell, so a file path is the only way a
 * credential reaches the cycle without being written into a checked-in trigger.
 */
export function resolveCredentialSource({
  inlineVars = [],
  fileVars = [],
  env = process.env,
  requireOwnerOnly = false,
  readTextFile = readFileSync,
  statFile = statSync,
} = {}) {
  for (const name of fileVars) {
    const path = String(env[name] || "").trim();
    if (!path) continue;
    // A configured file is the only source from here on, whatever it turns out
    // to hold. Every return below is terminal.
    let stats;
    try {
      stats = statFile(path);
    } catch (error) {
      return { value: null, variable: name, failure: error?.code === "ENOENT" ? "absent" : "unreadable" };
    }
    if (!stats.isFile()) return { value: null, variable: name, failure: "not-a-file" };
    // A token any local account can read is not a machine identity. The
    // installer writes it with umask 177, so anything looser is a mistake to
    // report rather than a permission to use. Only the delivery identity
    // demands this today: tightening the admin key the same way would change
    // whether an already-deployed cycle can publish its heartbeat at all.
    if (requireOwnerOnly && (stats.mode & 0o077)) return { value: null, variable: name, failure: "insecure-permissions" };
    let contents;
    try {
      contents = readTextFile(path, "utf8");
    } catch (error) {
      return { value: null, variable: name, failure: error?.code === "ENOENT" ? "absent" : "unreadable" };
    }
    const value = String(contents).trim();
    if (!value) return { value: null, variable: name, failure: "empty" };
    return { value, variable: name, failure: null };
  }
  for (const name of inlineVars) {
    const value = String(env[name] || "").trim();
    if (value) return { value, variable: name, failure: null };
  }
  return { value: null, variable: null, failure: "unconfigured" };
}

/**
 * The one line a failed resolution is allowed to emit: the variable to fix and
 * the class of failure, and nothing else. No path, no contents, no length.
 */
export function credentialFailureLine({ variable, failure }) {
  return `${variable} names a credential file that is ${CREDENTIAL_FAILURES[failure] || failure};`
    + " continuing without a credential rather than falling back to another identity";
}

export function resolveCredential(options = {}) {
  const { log = console.error } = options;
  const resolution = resolveCredentialSource(options);
  if (resolution.failure && resolution.failure !== "unconfigured") log(credentialFailureLine(resolution));
  return resolution.value;
}
