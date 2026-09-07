import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  APP_MINT_FAILURES,
  GITHUB_APP_FILE_VARS,
  TOKEN_REFRESH_MARGIN_MS,
  appCredentialFailureLine,
  buildAppJwt,
  createInstallationTokenSource,
  resolveGitHubAppCredential,
} from "../tools/github_app_identity.mjs";
import {
  GITHUB_CLIENT_METHODS,
  publishHeartbeat,
  resolveDeliveryIdentity,
} from "../tools/external_schedule_runner.mjs";
import { createGitHubClient } from "../tools/external_schedule_outbox.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

// One key pair for the whole file: generating RSA material is the slowest thing
// here and nothing in these cases depends on a fresh one.
const KEY_PAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = KEY_PAIR.privateKey.export({ type: "pkcs8", format: "pem" });
const PUBLIC_KEY = KEY_PAIR.publicKey;

// A file that looks like a key file and is not one. The delimiters are
// assembled rather than written out, so this repository never carries a literal
// private-key header even in a fixture that exists to be rejected.
const PEM_DELIMITER = "-".repeat(5);
const PEM_SHAPED_BUT_INVALID = [
  `${PEM_DELIMITER}BEGIN PRIVATE KEY${PEM_DELIMITER}`,
  "this is not key material",
  `${PEM_DELIMITER}END PRIVATE KEY${PEM_DELIMITER}`,
  "",
].join("\n");

const APP_ID = "1234567";
const INSTALLATION_ID = "98765432";
const OWNER = "cityscroll";
const REPO = "cityscroll-app";
const NOW = new Date("2026-09-06T11:00:00.000Z");
const RUN_ID = "2026-09-06T11-00:runner-7:4821";
const REVISION = "dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace";

async function writeCredentialFile(path, contents, mode = 0o600) {
  await writeFile(path, contents, { encoding: "utf8", mode });
  await chmod(path, mode);
  return path;
}

/** The three files as an operator who installed them correctly would have them. */
async function installedApp(dir, overrides = {}) {
  return {
    [GITHUB_APP_FILE_VARS.appId]: await writeCredentialFile(join(dir, "app-id"), `${overrides.appId ?? APP_ID}\n`),
    [GITHUB_APP_FILE_VARS.installationId]: await writeCredentialFile(join(dir, "installation-id"), `${overrides.installationId ?? INSTALLATION_ID}\n`),
    [GITHUB_APP_FILE_VARS.privateKey]: await writeCredentialFile(join(dir, "app-key.pem"), overrides.privateKey ?? PRIVATE_PEM),
  };
}

/**
 * A stubbed exchange. It answers the access-token mint and every repository
 * request, and records what it was asked, so a test can assert which credential
 * actually authorized a call without any of them leaving the process.
 */
function stubTransport({ mints = [], repoStatus = 200 } = {}) {
  const calls = [];
  let minted = 0;
  return {
    calls,
    get minted() { return minted; },
    async fetchImpl(url, options = {}) {
      calls.push({ url, method: options.method || "GET", authorization: options.headers?.Authorization || null });
      if (url.includes("/access_tokens")) {
        const answer = mints[Math.min(minted, mints.length - 1)];
        minted += 1;
        if (answer.status && !answer.body) return { ok: false, status: answer.status, async json() { return {}; } };
        return { ok: true, status: 201, async json() { return answer.body; } };
      }
      return { ok: true, status: repoStatus, async json() { return []; } };
    },
  };
}

function mintBody({ token = "ghs-installation-token", expiresAt = "2026-09-06T12:00:00.000Z", permissions = { issues: "write", metadata: "read" }, selection = "selected", repositories = [{ full_name: "cityscroll/cityscroll-app" }] } = {}) {
  return { token, expires_at: expiresAt, permissions, repository_selection: selection, repositories };
}

test("no GitHub App variable at all is a distinct, quiet case, not a failure", () => {
  const resolved = resolveGitHubAppCredential({ env: { GH_TOKEN_FILE: "/somewhere/token" } });
  assert.equal(resolved.configured, false);
  assert.equal(resolved.failure, "unconfigured");
  assert.equal(resolved.credential, null);
});

test("every way one of the three App files can fail resolves to no credential, named", async () => {
  await withTempDir("crol-app-credential", async (dir) => {
    const good = await installedApp(dir);

    const cases = [
      // A named path that is not there at all.
      [GITHUB_APP_FILE_VARS.appId, "absent", { ...good, [GITHUB_APP_FILE_VARS.appId]: join(dir, "missing-app-id") }],
      // Present but holding nothing.
      [GITHUB_APP_FILE_VARS.installationId, "empty", { ...good, [GITHUB_APP_FILE_VARS.installationId]: await writeCredentialFile(join(dir, "empty-installation"), "  \n") }],
      // A key any local account can read is not a machine identity.
      [GITHUB_APP_FILE_VARS.privateKey, "insecure-permissions", { ...good, [GITHUB_APP_FILE_VARS.privateKey]: await writeCredentialFile(join(dir, "loose-key.pem"), PRIVATE_PEM, 0o644) }],
      [GITHUB_APP_FILE_VARS.appId, "insecure-permissions", { ...good, [GITHUB_APP_FILE_VARS.appId]: await writeCredentialFile(join(dir, "group-app-id"), `${APP_ID}\n`, 0o640) }],
      // A directory where a file was named.
      [GITHUB_APP_FILE_VARS.installationId, "not-a-file", { ...good, [GITHUB_APP_FILE_VARS.installationId]: dir }],
      // Half-installed: the App path is selected, one variable never arrived.
      [GITHUB_APP_FILE_VARS.privateKey, "unset", { ...good, [GITHUB_APP_FILE_VARS.privateKey]: "" }],
      [GITHUB_APP_FILE_VARS.installationId, "unset", { ...good, [GITHUB_APP_FILE_VARS.installationId]: "" }],
      // Readable and non-empty, but not what the credential requires.
      [GITHUB_APP_FILE_VARS.appId, "malformed", { ...good, [GITHUB_APP_FILE_VARS.appId]: await writeCredentialFile(join(dir, "worded-app-id"), "the-app\n") }],
      [GITHUB_APP_FILE_VARS.installationId, "malformed", { ...good, [GITHUB_APP_FILE_VARS.installationId]: await writeCredentialFile(join(dir, "worded-installation"), "installation-one\n") }],
      [GITHUB_APP_FILE_VARS.privateKey, "malformed", { ...good, [GITHUB_APP_FILE_VARS.privateKey]: await writeCredentialFile(join(dir, "garbage-key.pem"), PEM_SHAPED_BUT_INVALID) }],
      // An App signs RS256, so a key of another type is a misinstallation.
      [GITHUB_APP_FILE_VARS.privateKey, "malformed", { ...good, [GITHUB_APP_FILE_VARS.privateKey]: await writeCredentialFile(join(dir, "ec-key.pem"), generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" })) }],
    ];

    for (const [variable, failure, env] of cases) {
      const resolved = resolveGitHubAppCredential({ env });
      assert.equal(resolved.configured, true, `${variable}/${failure} must still count as the App path being selected`);
      assert.equal(resolved.credential, null, `${variable}/${failure} must resolve to no credential`);
      assert.equal(resolved.variable, variable);
      assert.equal(resolved.failure, failure);
      // The line an operator reads names a variable and a class and nothing
      // else: no path, no contents, no length.
      const line = appCredentialFailureLine(resolved);
      assert.ok(line.startsWith(`${variable} is `), line);
      assert.equal(line.includes(dir), false, "the failure line must not carry a host path");
      assert.equal(line.includes(APP_ID), false);
    }

    // A file the account cannot read is reported, not skipped past.
    const unreadable = resolveGitHubAppCredential({
      env: good,
      readTextFile() { const error = new Error("denied"); error.code = "EACCES"; throw error; },
    });
    assert.equal(unreadable.failure, "unreadable");
    assert.equal(unreadable.credential, null);

    // And the correctly installed set resolves whole.
    const resolved = resolveGitHubAppCredential({ env: good });
    assert.equal(resolved.failure, null);
    assert.equal(resolved.credential.appId, APP_ID);
    assert.equal(resolved.credential.installationId, INSTALLATION_ID);
    assert.equal(resolved.credential.privateKey.asymmetricKeyType, "rsa");
  });
});

test("the App assertion is a short-lived RS256 signature this key actually made", async () => {
  await withTempDir("crol-app-jwt", async (dir) => {
    const { credential } = resolveGitHubAppCredential({ env: await installedApp(dir) });
    const jwt = buildAppJwt({ appId: credential.appId, privateKey: credential.privateKey, now: NOW });
    const [header, payload, signature] = jwt.split(".");
    assert.equal(jwt.split(".").length, 3);
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), { alg: "RS256", typ: "JWT" });

    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const seconds = Math.floor(NOW.getTime() / 1000);
    assert.equal(claims.iss, APP_ID);
    // Backdated, because the scheduler host's clock is not GitHub's and an
    // assertion issued a second into the future is rejected outright.
    assert.ok(claims.iat < seconds, "the assertion must be backdated for clock skew");
    assert.ok(seconds - claims.iat <= 300, "the backdate must stay a skew margin, not a lifetime");
    // Inside GitHub's own ten-minute cap, measured from the backdated issue.
    assert.ok(claims.exp > seconds, "the assertion must still be live now");
    assert.ok(claims.exp - claims.iat <= 600, "the assertion must not exceed the ten-minute maximum");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();
    assert.equal(verifier.verify(PUBLIC_KEY, Buffer.from(signature, "base64url")), true);
  });
});

test("a minted installation token is held for the cycle and refreshed before it expires", async () => {
  await withTempDir("crol-app-mint", async (dir) => {
    const { credential } = resolveGitHubAppCredential({ env: await installedApp(dir) });
    const transport = stubTransport({ mints: [
      { body: mintBody({ token: "token-one", expiresAt: "2026-09-06T12:00:00.000Z" }) },
      { body: mintBody({ token: "token-two", expiresAt: "2026-09-06T13:00:00.000Z" }) },
    ] });
    let clock = NOW;
    const source = createInstallationTokenSource({
      credential, owner: OWNER, repo: REPO,
      apiBase: "https://api.example.test",
      fetchImpl: transport.fetchImpl,
      now: () => clock,
    });

    assert.equal(await source.token(), "token-one");
    // A token comfortably ahead of expiry is reused rather than re-minted, so
    // an ordinary cycle spends one exchange and not one per request.
    clock = new Date("2026-09-06T11:30:00.000Z");
    assert.equal(await source.token(), "token-one");
    assert.equal(source.mints, 1);

    // Inside the safety margin it is replaced, so a request is never authorized
    // by a credential that may expire while it is in flight.
    clock = new Date(new Date("2026-09-06T12:00:00.000Z").getTime() - TOKEN_REFRESH_MARGIN_MS + 1000);
    assert.equal(await source.token(), "token-two");
    assert.equal(source.mints, 2);

    // The assertion is what authorizes the exchange, and it is never the token.
    const exchanges = transport.calls.filter((call) => call.url.includes("/access_tokens"));
    assert.equal(exchanges.length, 2);
    assert.equal(exchanges[0].method, "POST");
    assert.equal(exchanges[0].url, `https://api.example.test/app/installations/${INSTALLATION_ID}/access_tokens`);
    assert.match(exchanges[0].authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);

    // What the cycle may publish about the identity: enough to tell two
    // identities apart, and nothing replayable.
    const summary = source.summary();
    assert.deepEqual(summary, {
      identity_kind: "app",
      app_id: APP_ID,
      installation_id: INSTALLATION_ID,
      permissions: ["issues:write", "metadata:read"],
      repository_selection: "selected",
      token_expires_at: "2026-09-06T13:00:00.000Z",
    });
    const published = JSON.stringify(summary);
    assert.equal(published.includes("token-one"), false);
    assert.equal(published.includes("token-two"), false);
    assert.equal(published.includes("PRIVATE KEY"), false);
    assert.equal(published.includes(dir), false);
  });
});

test("a token that cannot reach this repository, or cannot write issues, is no credential", async () => {
  await withTempDir("crol-app-assert", async (dir) => {
    const { credential } = resolveGitHubAppCredential({ env: await installedApp(dir) });
    const cases = [
      // Installed somewhere else entirely.
      ["repository-not-covered", mintBody({ repositories: [{ full_name: "someone-else/other-app" }] })],
      // Selected, but this repository was never added to the selection.
      ["repository-not-covered", mintBody({ repositories: [] })],
      // Reaches the repository, but was never granted the one permission the
      // issue loop exists to use.
      ["issues-write-missing", mintBody({ permissions: { issues: "read", metadata: "read" } })],
      ["issues-write-missing", mintBody({ permissions: { metadata: "read" } })],
    ];
    for (const [failure, body] of cases) {
      const transport = stubTransport({ mints: [{ body }] });
      const source = createInstallationTokenSource({
        credential, owner: OWNER, repo: REPO, fetchImpl: transport.fetchImpl, now: () => NOW,
      });
      assert.equal(await source.token(), null);
      assert.equal(source.failure, `${failure}:201`);
      assert.ok(APP_MINT_FAILURES[failure], `${failure} must be a published class`);
      // A rejected assertion is not retried request after request.
      assert.equal(await source.token(), null);
      assert.equal(transport.minted, 1);
    }

    // An installation covering every repository on the account covers this one.
    const all = stubTransport({ mints: [{ body: mintBody({ selection: "all", repositories: undefined }) }] });
    const wide = createInstallationTokenSource({
      credential, owner: OWNER, repo: REPO, fetchImpl: all.fetchImpl, now: () => NOW,
    });
    assert.equal(await wide.token(), "ghs-installation-token");

    // A refused exchange names the status, so a wrong key reads differently
    // from a wrong installation.
    const refused = stubTransport({ mints: [{ status: 401 }] });
    const rejected = createInstallationTokenSource({
      credential, owner: OWNER, repo: REPO, fetchImpl: refused.fetchImpl, now: () => NOW,
    });
    assert.equal(await rejected.token(), null);
    assert.equal(rejected.failure, "exchange-refused:401");
    assert.equal(rejected.summary().token_expires_at, null);
  });
});

test("the App identity is authoritative over the token file for the whole cycle", async () => {
  await withTempDir("crol-app-precedence", async (dir) => {
    const tokenFile = await writeCredentialFile(join(dir, "github-token"), "file-resident-token\n");
    const app = await installedApp(dir);
    const logged = [];

    // Configured together, the App wins and the token file is never consulted.
    const transport = stubTransport({ mints: [{ body: mintBody({ token: "minted-token" }) }] });
    const identity = resolveDeliveryIdentity({
      env: { ...app, GH_TOKEN_FILE: tokenFile, GH_TOKEN: "inline-token" },
      apiBase: "https://api.example.test",
      fetchImpl: transport.fetchImpl,
      now: () => NOW,
      log: (line) => logged.push(line),
    });
    assert.equal(identity.kind, "app");
    assert.equal(identity.reason, null);
    assert.deepEqual(logged, []);
    await identity.github.listIssues();
    const repoCall = transport.calls.at(-1);
    assert.equal(repoCall.url, "https://api.example.test/repos/cityscroll/cityscroll-app/issues?state=open&per_page=100");
    assert.equal(repoCall.authorization, "Bearer minted-token");

    // A half-installed App does not fall through to the token file: it reports
    // its own reason and delivers nothing.
    const broken = resolveDeliveryIdentity({
      env: { ...app, [GITHUB_APP_FILE_VARS.privateKey]: "", GH_TOKEN_FILE: tokenFile },
      fetchImpl: transport.fetchImpl,
      now: () => NOW,
      log: (line) => logged.push(line),
    });
    assert.equal(broken.kind, null);
    assert.equal(broken.github, null);
    assert.equal(broken.reason, `${GITHUB_APP_FILE_VARS.privateKey}:unset`);
    assert.match(logged.at(-1), /^outbox delivery is offline: GH_APP_PRIVATE_KEY_FILE is unset/);
    assert.equal(logged.at(-1).includes(dir), false);

    // With no App configured, the token file behaves exactly as it did before.
    const file = resolveDeliveryIdentity({
      env: { GH_TOKEN_FILE: tokenFile },
      apiBase: "https://api.example.test",
      fetchImpl: transport.fetchImpl,
      now: () => NOW,
      log: (line) => logged.push(line),
    });
    assert.equal(file.kind, "file");
    assert.equal(file.reason, null);
    assert.equal(file.summary.token_expires_at, null);
    await file.github.listIssues();
    assert.equal(transport.calls.at(-1).authorization, "Bearer file-resident-token");

    // And an unconfigured host still names both routes in the one line it logs.
    const none = resolveDeliveryIdentity({ env: {}, fetchImpl: transport.fetchImpl, now: () => NOW, log: (line) => logged.push(line) });
    assert.equal(none.kind, null);
    assert.equal(none.reason, "github-token-unconfigured");
    assert.match(logged.at(-1), /GH_APP_ID_FILE, GH_APP_INSTALLATION_ID_FILE and GH_APP_PRIVATE_KEY_FILE/);
  });
});

test("the refreshing client answers for the whole shared client surface", async () => {
  // The App path resolves its credential per request, so it wraps the shared
  // client rather than being it. A method added there and missed here would be
  // a call the issue loop simply could not make under an App identity.
  const shared = createGitHubClient({ token: "unused-by-this-assertion", owner: OWNER, repo: REPO });
  assert.deepEqual([...GITHUB_CLIENT_METHODS].sort(), Object.keys(shared).sort());
});

test("a cycle whose mint failed raises rather than writing with no credential", async () => {
  await withTempDir("crol-app-unauthenticated", async (dir) => {
    const transport = stubTransport({ mints: [{ status: 403 }] });
    const identity = resolveDeliveryIdentity({
      env: await installedApp(dir),
      fetchImpl: transport.fetchImpl,
      now: () => NOW,
      log: () => {},
    });
    await assert.rejects(() => identity.github.listIssues(), /no usable installation token: exchange-refused:403/);
    // Nothing reached the repository: the failure is at the credential, not a
    // request GitHub had to refuse.
    assert.equal(transport.calls.some((call) => call.url.includes("/repos/")), false);
  });
});

test("the heartbeat says which identity the cycle used and when its token expires", async () => {
  await withTempDir("crol-app-heartbeat", async (stateDir) => {
    const priorKey = process.env.CITYSCROLL_ADMIN_KEY;
    process.env.CITYSCROLL_ADMIN_KEY = "secret";
    try {
      const heartbeat = await publishHeartbeat(stateDir, NOW, [], {
        runId: RUN_ID,
        sourceRevision: REVISION,
        outboxDelivery: "credentialed",
        outboxDeliveryIdentity: "app",
        outboxDeliveryTokenExpiresAt: "2026-09-06T12:00:00.000Z",
        fetchImpl: async () => ({ ok: false, status: 503 }),
      });
      // "credentialed" still states only that a token was minted this cycle.
      assert.equal(heartbeat.outbox_delivery, "credentialed");
      assert.equal(heartbeat.outbox_delivery_identity, "app");
      assert.equal(heartbeat.outbox_delivery_token_expires_at, "2026-09-06T12:00:00.000Z");
      const persisted = JSON.parse(await readFile(join(stateDir, "heartbeat", "latest.json"), "utf8"));
      assert.equal(persisted.outbox_delivery_identity, "app");
      assert.equal(persisted.outbox_delivery_token_expires_at, "2026-09-06T12:00:00.000Z");
      // No stronger claim than the one the file path already makes.
      assert.equal(JSON.stringify(persisted).includes("installed"), false);
      assert.equal(JSON.stringify(persisted).includes("operational"), false);

      // A file-backed cycle reports its kind and has no expiry to state.
      const rehearsal = await publishHeartbeat(stateDir, NOW, [], {
        runId: RUN_ID,
        sourceRevision: REVISION,
        outboxDelivery: "credentialed",
        outboxDeliveryIdentity: "file",
        fetchImpl: async () => ({ ok: false, status: 503 }),
      });
      assert.equal(rehearsal.outbox_delivery_identity, "file");
      assert.equal(rehearsal.outbox_delivery_token_expires_at, null);

      // An offline cycle names no identity at all.
      const offline = await publishHeartbeat(stateDir, NOW, [], {
        runId: RUN_ID,
        sourceRevision: REVISION,
        outboxDelivery: "offline",
        outboxDeliveryReason: "GH_APP_PRIVATE_KEY_FILE:malformed",
        fetchImpl: async () => ({ ok: false, status: 503 }),
      });
      assert.equal(offline.outbox_delivery_identity, null);
      assert.equal(offline.outbox_delivery_token_expires_at, null);
      assert.equal(offline.outbox_delivery_reason, "GH_APP_PRIVATE_KEY_FILE:malformed");
    } finally {
      if (priorKey == null) delete process.env.CITYSCROLL_ADMIN_KEY; else process.env.CITYSCROLL_ADMIN_KEY = priorKey;
    }
  });
});

test("the App path is documented as three files, with the read-only checks that prove it", async () => {
  const docs = await readFile(new URL("../docs/external-schedule-outbox.md", import.meta.url), "utf8");
  const template = await readFile(new URL("../ops/launchd/com.cityscroll.external-schedules.plist.template", import.meta.url), "utf8");
  const installer = await readFile(new URL("../tools/install_external_schedule_launchd.sh", import.meta.url), "utf8");
  for (const variable of Object.values(GITHUB_APP_FILE_VARS)) {
    assert.match(docs, new RegExp(variable), `${variable} is undocumented`);
    assert.match(template, new RegExp(`<key>${variable}</key>`), `${variable} is missing from the trigger`);
    assert.match(installer, new RegExp(`__${variable}__`), `${variable} is not substituted by the installer`);
  }
  // The verification an operator actually runs before anything is delivered.
  assert.match(docs, /Verifying the App before anything is delivered/);
  assert.match(docs, /422/);
  // The rehearsal identity is retained, and said to be retained.
  assert.match(docs, /file-backed token path is not removed/);
});
