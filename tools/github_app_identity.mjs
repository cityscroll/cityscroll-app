import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { CREDENTIAL_FAILURES, resolveCredentialSource } from "./lib/credential_files.mjs";

/**
 * The delivery identity for the issue loop, in its GitHub App form.
 *
 * A machine user is an account: it has a password, a session, a recovery
 * address, and a person who owns it. An App installed on one repository is
 * none of those. Its authority is the installation, its permissions are
 * declared once and visible in the response to every mint, and the credential
 * that actually reaches the runner is an installation token that expires in
 * about an hour, so a leaked receipt or a stale copy stops being useful on its
 * own. The long-lived secret on disk is a private key that never leaves the
 * host and is never sent anywhere: it only signs the short assertion this
 * module exchanges for the token.
 *
 * Nothing here logs the private key, the assertion, or the minted token. The
 * receipts this module produces carry the App id, the installation id, the
 * permission set GitHub reported, and the expiry — enough to tell two
 * identities apart and to see a refresh happen, and nothing that could be
 * replayed by whoever reads them.
 */

/**
 * The three files the operator installs. All three are read the same way as
 * every other credential file: a mode-0600 regular file owned by the scheduler
 * account, authoritative once its variable names a path, and never quietly
 * replaced by an inline export.
 */
export const GITHUB_APP_FILE_VARS = Object.freeze({
  appId: "GH_APP_ID_FILE",
  installationId: "GH_APP_INSTALLATION_ID_FILE",
  privateKey: "GH_APP_PRIVATE_KEY_FILE",
});

/** GitHub's own maximum assertion lifetime is ten minutes. */
const JWT_LIFETIME_SECONDS = 9 * 60;
/**
 * The scheduler host's clock is not GitHub's. An assertion issued a second into
 * the future is rejected outright, so the issued-at is backdated by a margin
 * wide enough to absorb ordinary drift and still far inside the ten-minute cap.
 */
const CLOCK_SKEW_SECONDS = 60;
/**
 * How close to expiry a held token is refreshed rather than used. A cycle can
 * spend ten minutes in one bounded repair task, so a token that merely has not
 * expired yet is not good enough: it has to outlive the request it is about to
 * authorize.
 */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const APP_ID_PATTERN = /^[0-9]{1,20}$/;
const INSTALLATION_ID_PATTERN = /^[0-9]{1,20}$/;

function base64url(input) {
  return Buffer.from(input).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Resolve the three files as one credential.
 *
 * Configuration is a set, not three independent switches: naming any one of the
 * variables declares the App path, and from there every one of the three must
 * resolve or the whole credential resolves to nothing with the offending
 * variable and failure class named. A half-installed App must never leave the
 * cycle running on some other identity it happened to find.
 *
 * `configured: false` is the distinct, quieter case where none of the three is
 * named at all — the deployment simply is not using an App, and the existing
 * file-token path is left to behave exactly as it did before.
 */
export function resolveGitHubAppCredential({
  env = process.env,
  readTextFile = readFileSync,
  statFile = statSync,
} = {}) {
  const named = Object.values(GITHUB_APP_FILE_VARS).filter((name) => String(env[name] || "").trim());
  if (!named.length) return { configured: false, variable: null, failure: "unconfigured", credential: null };

  const parts = {};
  for (const [field, name] of Object.entries(GITHUB_APP_FILE_VARS)) {
    if (!String(env[name] || "").trim()) {
      return { configured: true, variable: name, failure: "unset", credential: null };
    }
    const resolution = resolveCredentialSource({
      fileVars: [name],
      env,
      requireOwnerOnly: true,
      readTextFile,
      statFile,
    });
    if (resolution.failure) return { configured: true, variable: name, failure: resolution.failure, credential: null };
    parts[field] = resolution.value;
  }

  if (!APP_ID_PATTERN.test(parts.appId)) {
    return { configured: true, variable: GITHUB_APP_FILE_VARS.appId, failure: "malformed", credential: null };
  }
  if (!INSTALLATION_ID_PATTERN.test(parts.installationId)) {
    return { configured: true, variable: GITHUB_APP_FILE_VARS.installationId, failure: "malformed", credential: null };
  }
  // The key is parsed here rather than at first signature, so a PEM that no
  // parser accepts is reported as a named misconfiguration in the same cycle
  // summary as every other one instead of surfacing later as a mint failure.
  let privateKey;
  try {
    privateKey = createPrivateKey(parts.privateKey);
  } catch {
    return { configured: true, variable: GITHUB_APP_FILE_VARS.privateKey, failure: "malformed", credential: null };
  }
  if (privateKey.asymmetricKeyType !== "rsa") {
    return { configured: true, variable: GITHUB_APP_FILE_VARS.privateKey, failure: "malformed", credential: null };
  }

  return {
    configured: true,
    variable: null,
    failure: null,
    credential: { appId: parts.appId, installationId: parts.installationId, privateKey },
  };
}

/**
 * The one line a failed App resolution is allowed to emit. Same discipline as
 * the file-token line: a variable and a class, never a path, a length, or a
 * byte of the file.
 */
export function appCredentialFailureLine({ variable, failure }) {
  return `${variable} is ${CREDENTIAL_FAILURES[failure] || failure};`
    + " continuing without a GitHub App identity rather than falling back to another one";
}

/**
 * The short-lived RS256 assertion that proves possession of the App's key.
 *
 * It is signed locally with Node's own crypto and is worth nothing after nine
 * minutes. It is exchanged immediately and never stored, logged, or returned in
 * any receipt.
 */
export function buildAppJwt({
  appId,
  privateKey,
  now = new Date(),
  lifetimeSeconds = JWT_LIFETIME_SECONDS,
  clockSkewSeconds = CLOCK_SKEW_SECONDS,
}) {
  const issued = Math.floor(now.getTime() / 1000) - clockSkewSeconds;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issued, exp: issued + clockSkewSeconds + lifetimeSeconds, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(privateKey, "base64url")}`;
}

/**
 * The grant this identity is allowed to hold, and nothing else.
 *
 * The site owner's decision is an exact scope rather than a sufficient one: the
 * installation reaches this repository and no other, and carries these two
 * permissions at these two levels and no others. Stating it as a contract here
 * lets the runner assert the same thing the intake ceremony asserted when the
 * credential was installed, so a grant widened afterwards is caught by the
 * process that uses it rather than only by the process that created it.
 */
export const REQUIRED_INSTALLATION_PERMISSIONS = Object.freeze({ issues: "write", metadata: "read" });

/**
 * How a reported grant differs from the contract, in three separate senses: a
 * permission that was never agreed, one that was agreed and is absent, and one
 * held at the wrong level. They are kept apart because they are different
 * operator actions — remove a permission, accept a pending one, change a level.
 */
export function permissionDiff(granted, expected = REQUIRED_INSTALLATION_PERMISSIONS) {
  const held = granted && typeof granted === "object" ? granted : {};
  return {
    extra: Object.keys(held).filter((name) => !(name in expected)).sort(),
    missing: Object.keys(expected).filter((name) => !(name in held)).sort(),
    wrong: Object.keys(expected).filter((name) => name in held && held[name] !== expected[name]).sort(),
  };
}

/** Whether a reported grant is the contract exactly, in every one of those senses. */
export function grantIsExactlyRequired(granted) {
  const diff = permissionDiff(granted);
  return !diff.extra.length && !diff.missing.length && !diff.wrong.length;
}

/**
 * Whether an installation's repository list is exactly this repository.
 *
 * `total` is GitHub's own count rather than the length of the page in hand: an
 * installation with more repositories than one page holds must read as broader
 * than agreed, not as whatever the first page happened to show.
 */
export function reachesExactlyThisRepository(names, total, owner, repo) {
  const target = `${owner}/${repo}`.toLowerCase();
  const list = [...new Set(names.map((name) => String(name || "").toLowerCase()))];
  return list.length === 1 && list[0] === target && total === 1;
}

/**
 * The reasons a mint can fail, in the same publishable vocabulary the file path
 * uses: a class an operator can act on, carrying no token and no path.
 */
export const APP_MINT_FAILURES = {
  "exchange-refused": "the installation token exchange was refused",
  "exchange-unreadable": "the installation token exchange returned nothing this cycle could read",
  "repository-list-unreadable": "the installation's repository list could not be read back",
  "repository-not-covered": "the installation does not reach this repository",
  "repository-scope-too-broad": "the installation reaches more than this repository",
  "issues-write-missing": "the installation does not carry issues:write",
  "permissions-not-exact": "the installation's permissions are not exactly issues:write and metadata:read",
};

/**
 * A source of installation tokens for one cycle.
 *
 * The token lives in memory only, for as long as this process runs, and is
 * re-minted when it comes within the refresh margin of expiry — a cycle that
 * outlives an hour therefore keeps working rather than failing halfway through
 * a replay. The repository and permission assertions run against the mint
 * response itself, so the first use of a wrong installation is a stated reason
 * rather than a delivery attempt under an identity nobody intended.
 */
export function createInstallationTokenSource({
  credential,
  owner,
  repo,
  apiBase = "https://api.github.com",
  fetchImpl = fetch,
  now = () => new Date(),
  refreshMarginMs = TOKEN_REFRESH_MARGIN_MS,
  buildJwt = buildAppJwt,
}) {
  const base = String(apiBase).replace(/\/$/, "");
  let held = null;
  let failure = null;
  let mints = 0;

  function expiresSoon(at, moment) {
    return !(at instanceof Date) || Number.isNaN(at.getTime()) || at.getTime() - moment.getTime() <= refreshMarginMs;
  }

  /**
   * The installation's repository list, read back as the installation rather
   * than as the request.
   *
   * This is the one part of the grant a mint response cannot state: an
   * unscoped mint reports `repository_selection` but no list, so an
   * installation on two repositories and an installation on one look
   * identical until the list is asked for. Reading it costs one request per
   * mint — roughly one an hour — which is what an exact scope is worth.
   */
  async function readRepositories(token) {
    let response;
    try {
      response = await fetchImpl(`${base}/installation/repositories?per_page=100`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch {
      return null;
    }
    if (!response?.ok) return null;
    let payload;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    const entries = Array.isArray(payload?.repositories) ? payload.repositories : null;
    if (!entries) return null;
    const names = entries.map((entry) => String(entry?.full_name || "")).filter(Boolean);
    if (names.length !== entries.length) return null;
    return { names, total: Number.isInteger(payload.total_count) ? payload.total_count : names.length };
  }

  async function mint() {
    const moment = now();
    const assertion = buildJwt({ appId: credential.appId, privateKey: credential.privateKey, now: moment });
    let response;
    try {
      response = await fetchImpl(`${base}/app/installations/${encodeURIComponent(credential.installationId)}/access_tokens`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${assertion}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        // Deliberately unscoped. Asking for a narrower token would make the
        // response describe the request rather than the installation: GitHub
        // echoes back the repositories and permissions that were asked for, so
        // an installation granted far more than this identity should hold
        // would still mint a response that looks exactly right. The token is
        // therefore taken at the installation's own scope, and the assertions
        // below establish that this scope is the agreed one.
      });
    } catch {
      // The transport error is deliberately not carried through: it can quote a
      // URL and a host, and the class is what an operator acts on.
      return { token: null, failure: "exchange-refused", status: null };
    }
    if (!response?.ok) return { token: null, failure: "exchange-refused", status: response?.status ?? null };
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { token: null, failure: "exchange-unreadable", status: response.status };
    }
    if (!payload?.token || !payload?.expires_at) return { token: null, failure: "exchange-unreadable", status: response.status };
    const expiresAt = new Date(payload.expires_at);
    if (Number.isNaN(expiresAt.getTime())) return { token: null, failure: "exchange-unreadable", status: response.status };

    // Permissions first, and from the mint response, so the commonest
    // misinstallation is named without spending a second request — and so a
    // grant missing metadata:read is reported as the grant it is rather than
    // as the repository read it would go on to fail.
    const permissions = payload.permissions && typeof payload.permissions === "object" ? payload.permissions : {};
    if (permissions.issues !== "write") return { token: null, failure: "issues-write-missing", status: response.status };
    if (!grantIsExactlyRequired(permissions)) return { token: null, failure: "permissions-not-exact", status: response.status };

    const selection = payload.repository_selection || null;
    if (selection === "all") return { token: null, failure: "repository-scope-too-broad", status: response.status };
    if (selection !== "selected") return { token: null, failure: "exchange-unreadable", status: response.status };

    const reach = await readRepositories(payload.token);
    if (!reach) return { token: null, failure: "repository-list-unreadable", status: response.status };
    const target = `${owner}/${repo}`.toLowerCase();
    if (!reach.names.some((name) => name.toLowerCase() === target)) {
      return { token: null, failure: "repository-not-covered", status: response.status };
    }
    if (!reachesExactlyThisRepository(reach.names, reach.total, owner, repo)) {
      return { token: null, failure: "repository-scope-too-broad", status: response.status };
    }

    return {
      token: payload.token,
      expiresAt,
      permissions,
      repositorySelection: selection,
      repositories: [...reach.names].sort(),
      failure: null,
      status: response.status,
    };
  }

  /**
   * The current installation token, minted on first use and refreshed when it
   * is within the safety margin of expiry. Returns null once a mint has
   * failed, so the cycle reports no delivery identity for the stated reason
   * rather than retrying an assertion GitHub already rejected.
   */
  async function token() {
    if (failure) return null;
    if (held && !expiresSoon(held.expiresAt, now())) return held.token;
    const minted = await mint();
    if (minted.failure) {
      failure = minted.status ? `${minted.failure}:${minted.status}` : minted.failure;
      held = null;
      return null;
    }
    mints += 1;
    held = minted;
    return minted.token;
  }

  return {
    appId: credential.appId,
    installationId: credential.installationId,
    get failure() { return failure; },
    get mints() { return mints; },
    token,
    /**
     * Prove the identity before the cycle delivers under it.
     *
     * The scope assertions live at the mint, so until one has happened the
     * cycle knows only what it was configured with. Minting here makes a grant
     * broader than the agreed one resolve to no credential for the whole cycle
     * — reported by class, with every pending intent's attempt counter
     * untouched — rather than surfacing as a delivery error against the first
     * intent that happened to be replayed.
     */
    async ensure() {
      await token();
      return failure;
    },
    /**
     * What the cycle may publish about this identity: which App, which
     * installation, exactly what GitHub said it may do and where, why it
     * resolved to nothing if it did, and when the held token stops being
     * usable. No token, no assertion, no key, no path.
     */
    summary() {
      return {
        identity_kind: "app",
        app_id: credential.appId,
        installation_id: credential.installationId,
        permissions: held ? Object.entries(held.permissions).map(([name, level]) => `${name}:${level}`).sort() : [],
        repository_selection: held?.repositorySelection || null,
        repositories: held?.repositories || [],
        failure,
        token_expires_at: held ? held.expiresAt.toISOString() : null,
      };
    },
  };
}
