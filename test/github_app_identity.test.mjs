import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, createVerify } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { chmod, readdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  APP_MINT_FAILURES,
  GITHUB_APP_FILE_VARS,
  REQUIRED_INSTALLATION_PERMISSIONS,
  TOKEN_REFRESH_MARGIN_MS,
  appCredentialFailureLine,
  buildAppJwt,
  createInstallationTokenSource,
  grantIsExactlyRequired,
  permissionDiff,
  reachesExactlyThisRepository,
  resolveGitHubAppCredential,
} from "../tools/github_app_identity.mjs";
import {
  GITHUB_CLIENT_METHODS,
  publishHeartbeat,
  resolveDeliveryIdentity,
} from "../tools/external_schedule_runner.mjs";
import { createGitHubClient, persistScheduleResult, replayOutbox } from "../tools/external_schedule_outbox.mjs";
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
 * A stubbed exchange. It answers the access-token mint, the installation's
 * repository list, and every repository request, and records what it was asked,
 * so a test can assert which credential actually authorized a call without any
 * of them leaving the process.
 *
 * The repository list is answered separately from the mint on purpose, because
 * that is the shape of the real provider: an unscoped mint reports a permission
 * set and a selection but never a list, so the breadth of an installation is
 * only knowable from the second request.
 */
function stubTransport({ mints = [], reach = ["cityscroll/cityscroll-app"], reachTotal = null, reachStatus = 200, repoStatus = 200 } = {}) {
  const calls = [];
  let minted = 0;
  return {
    calls,
    get minted() { return minted; },
    get reads() { return calls.filter((call) => call.url.includes("/installation/repositories")).length; },
    async fetchImpl(url, options = {}) {
      calls.push({ url, method: options.method || "GET", authorization: options.headers?.Authorization || null, body: options.body ?? null });
      if (url.includes("/access_tokens")) {
        const answer = mints[Math.min(minted, mints.length - 1)];
        minted += 1;
        if (answer.status && !answer.body) return { ok: false, status: answer.status, async json() { return {}; } };
        return { ok: true, status: 201, async json() { return answer.body; } };
      }
      if (url.includes("/installation/repositories")) {
        if (reachStatus !== 200) return { ok: false, status: reachStatus, async json() { return {}; } };
        return {
          ok: true,
          status: 200,
          async json() {
            return { total_count: reachTotal ?? reach.length, repositories: reach.map((full_name) => ({ full_name })) };
          },
        };
      }
      return { ok: true, status: repoStatus, async json() { return []; } };
    },
  };
}

/**
 * A mint response in the shape an unscoped exchange actually returns: a token,
 * an expiry, the installation's own permissions, and its selection — and no
 * repository list, which is exactly why one is read separately.
 */
function mintBody({ token = "ghs-installation-token", expiresAt = "2026-09-06T12:00:00.000Z", permissions = { issues: "write", metadata: "read" }, selection = "selected" } = {}) {
  return { token, expires_at: expiresAt, permissions, repository_selection: selection };
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
    // The exchange asks for nothing in particular. A request that narrowed the
    // token would be answered with the narrowing echoed back, and the scope
    // assertions below would then be reading the request rather than the grant.
    assert.equal(exchanges[0].body, null, "the mint must not narrow the token it is asserting about");

    // What the cycle may publish about the identity: enough to tell two
    // identities apart, and nothing replayable.
    const summary = source.summary();
    assert.deepEqual(summary, {
      identity_kind: "app",
      app_id: APP_ID,
      installation_id: INSTALLATION_ID,
      permissions: ["issues:write", "metadata:read"],
      repository_selection: "selected",
      repositories: ["cityscroll/cityscroll-app"],
      failure: null,
      token_expires_at: "2026-09-06T13:00:00.000Z",
    });
    const published = JSON.stringify(summary);
    assert.equal(published.includes("token-one"), false);
    assert.equal(published.includes("token-two"), false);
    assert.equal(published.includes("PRIVATE KEY"), false);
    assert.equal(published.includes(dir), false);
  });
});

/**
 * One cycle, as launchd actually runs one: a whole process that starts, mints,
 * and exits. Returns what the cycle could observe about its own identity, and
 * never the token itself — a fingerprint is enough to tell two apart.
 */
const CYCLE_SOURCE = `
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolveGitHubAppCredential, createInstallationTokenSource } from "SOURCE_MODULE";

const resolved = resolveGitHubAppCredential();
if (resolved.failure) throw new Error(\`credential: \${resolved.variable}:\${resolved.failure}\`);
const source = createInstallationTokenSource({
  credential: resolved.credential,
  owner: "cityscroll",
  repo: "cityscroll-app",
  apiBase: process.env.PROBE_API_BASE,
});
const token = await source.token();
process.stdout.write(JSON.stringify({
  mints: source.mints,
  failure: source.failure,
  summary: source.summary(),
  // A fingerprint, so two cycles can be compared without either token being
  // written down by the very test that says they never are.
  token_fingerprint: token ? createHash("sha256").update(token).digest("hex") : null,
  // Everything this process could see: its whole environment, and every file
  // in the directory it shares with the cycle before it.
  env: { ...process.env },
  visible_files: readdirSync(process.env.PROBE_SHARED_DIR).sort(),
}));
`;

const run = promisify(execFile);

test("a new cycle mints its own token and inherits nothing from the cycle before it", async () => {
  await withTempDir("crol-app-fresh-cycle", async (dir) => {
    const app = await installedApp(dir);
    const fingerprint = (value) => createHash("sha256").update(value).digest("hex");
    // A different token for each exchange, so two cycles sharing one would be
    // visible rather than merely unproven.
    const ISSUED = ["ghs-cycle-one-fixture-token", "ghs-cycle-two-fixture-token"];
    const EXPIRES = ["2026-09-06T12:00:00.000Z", "2026-09-06T13:00:00.000Z"];

    const exchanges = [];
    const repositoryReads = [];
    const server = createServer((request, response) => {
      const authorization = request.headers.authorization || "";
      if (request.url.includes("/access_tokens")) {
        const issued = ISSUED[Math.min(exchanges.length, ISSUED.length - 1)];
        const expires = EXPIRES[Math.min(exchanges.length, EXPIRES.length - 1)];
        exchanges.push({ assertion: authorization.replace(/^Bearer /, ""), issued });
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          token: issued,
          expires_at: expires,
          permissions: { issues: "write", metadata: "read" },
          repository_selection: "selected",
        }));
        return;
      }
      repositoryReads.push({ presented: authorization.replace(/^Bearer /, "") });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ total_count: 1, repositories: [{ full_name: "cityscroll/cityscroll-app" }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    try {
      const cyclePath = join(dir, "cycle.mjs");
      const moduleUrl = new URL("../tools/github_app_identity.mjs", import.meta.url).href;
      await writeFile(cyclePath, CYCLE_SOURCE.replace("SOURCE_MODULE", moduleUrl), "utf8");

      // The three credential files are all a cycle is given, and both cycles are
      // given exactly the same thing. Nothing else is carried between them: no
      // inherited environment, no shared working state, no handle of any kind.
      const cycleEnv = {
        ...app,
        PROBE_API_BASE: `http://127.0.0.1:${port}`,
        PROBE_SHARED_DIR: dir,
        PATH: process.env.PATH,
      };
      const before = (await readdir(dir)).sort();

      // Run each cycle with this directory as its working directory, so a token
      // written to a relative path is caught by the sweep below rather than
      // landing somewhere the test never looks.
      const options = { env: cycleEnv, cwd: dir };
      const cycleOne = JSON.parse((await run(process.execPath, [cyclePath], options)).stdout);
      const between = (await readdir(dir)).sort();
      const cycleTwo = JSON.parse((await run(process.execPath, [cyclePath], options)).stdout);
      const after = (await readdir(dir)).sort();

      // Each process performed its own exchange, signing its own assertion.
      assert.equal(exchanges.length, 2, "each cycle must mint for itself");
      assert.equal(cycleOne.mints, 1);
      assert.equal(cycleTwo.mints, 1);
      // Each exchange presented a real assertion this App's key made. Note that
      // the two can be byte-identical and that is correct rather than
      // suspicious: RS256 is deterministic, and two cycles a second apart sign
      // identical claims. Byte-distinctness is therefore not evidence of a
      // fresh exchange — the count above and the token provenance below are.
      for (const exchange of exchanges) {
        const [header, payload, signature] = exchange.assertion.split(".");
        assert.equal(exchange.assertion.split(".").length, 3);
        assert.equal(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).iss, APP_ID);
        const verifier = createVerify("RSA-SHA256");
        verifier.update(`${header}.${payload}`);
        verifier.end();
        assert.equal(verifier.verify(PUBLIC_KEY, Buffer.from(signature, "base64url")), true,
          "each cycle must present an assertion made by the App's own key");
      }

      // And each used the token from its own exchange, not the other's.
      assert.equal(cycleOne.token_fingerprint, fingerprint(ISSUED[0]));
      assert.equal(cycleTwo.token_fingerprint, fingerprint(ISSUED[1]));
      assert.notEqual(cycleOne.token_fingerprint, cycleTwo.token_fingerprint);
      assert.equal(cycleOne.summary.token_expires_at, EXPIRES[0]);
      assert.equal(cycleTwo.summary.token_expires_at, EXPIRES[1], "a new cycle's expiry is its own, not the previous cycle's");
      assert.deepEqual(repositoryReads.map((read) => read.presented), ISSUED,
        "each cycle must read its scope back under the token it just minted");

      // Nothing was left behind for a later cycle to find. A token that reached
      // any file here would be a long-lived credential in all but name, which is
      // the property this identity exists to avoid.
      assert.deepEqual(between, before, "a cycle must write nothing beside its credential files");
      assert.deepEqual(after, before);
      for (const name of after) {
        const contents = await readFile(join(dir, name), "utf8");
        for (const issued of ISSUED) {
          assert.equal(contents.includes(issued), false, `a minted token was left readable in ${name}`);
        }
      }

      // And nothing reached the second cycle through its environment: it began
      // with the same three paths the first one did, and no token among them.
      assert.deepEqual(Object.keys(cycleTwo.env).sort(), Object.keys(cycleOne.env).sort());
      for (const [name, value] of Object.entries(cycleTwo.env)) {
        for (const issued of ISSUED) {
          assert.equal(String(value).includes(issued), false, `a token reached the next cycle through ${name}`);
        }
      }
      assert.deepEqual(cycleTwo.visible_files, before,
        "the second cycle must see nothing the first one did not start with");
      // The proof depends on the second cycle having actually succeeded.
      assert.equal(cycleTwo.failure, null);
      assert.equal(cycleTwo.summary.identity_kind, "app");
      assert.deepEqual(cycleTwo.summary.repositories, ["cityscroll/cityscroll-app"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("the agreed grant is the only one accepted: exactly this repository, exactly these permissions", async () => {
  await withTempDir("crol-app-exact", async (dir) => {
    const { credential } = resolveGitHubAppCredential({ env: await installedApp(dir) });

    // The grant the site owner agreed to, and the only one that resolves to a
    // usable identity: one repository, two permissions, at those two levels.
    const exact = stubTransport({ mints: [{ body: mintBody() }] });
    const accepted = createInstallationTokenSource({
      credential, owner: OWNER, repo: REPO, fetchImpl: exact.fetchImpl, now: () => NOW,
    });
    assert.equal(await accepted.token(), "ghs-installation-token");
    assert.equal(accepted.failure, null);
    assert.deepEqual(accepted.summary().permissions, ["issues:write", "metadata:read"]);
    assert.deepEqual(accepted.summary().repositories, ["cityscroll/cityscroll-app"]);
    assert.equal(accepted.summary().repository_selection, "selected");
    // The list is read back once per mint and not once per request.
    assert.equal(exact.reads, 1);
    assert.equal(await accepted.token(), "ghs-installation-token");
    assert.equal(exact.reads, 1);

    const cases = [
      // Broader than agreed, in each of the ways an installation can be.
      // A second repository is still a grant nobody agreed to, even though this
      // repository is in the list and every request would have succeeded.
      ["repository-scope-too-broad", { mints: [{ body: mintBody() }], reach: ["cityscroll/cityscroll-app", "cityscroll/cityscroll-notes"] }],
      // Installed on every repository the account owns.
      ["repository-scope-too-broad", { mints: [{ body: mintBody({ selection: "all" }) }] }],
      // One page shows one repository and the installation says there are more.
      ["repository-scope-too-broad", { mints: [{ body: mintBody() }], reachTotal: 2 }],
      // A permission that was never agreed, at any level.
      ["permissions-not-exact", { mints: [{ body: mintBody({ permissions: { issues: "write", metadata: "read", contents: "read" } }) }] }],
      ["permissions-not-exact", { mints: [{ body: mintBody({ permissions: { issues: "write", metadata: "read", administration: "write" } }) }] }],
      // Narrower than agreed is equally not the agreed grant: an identity
      // missing metadata:read cannot read its own installation back, so it can
      // never be shown to be scoped as agreed.
      ["permissions-not-exact", { mints: [{ body: mintBody({ permissions: { issues: "write" } }) }] }],
      ["permissions-not-exact", { mints: [{ body: mintBody({ permissions: { issues: "write", metadata: "write" } }) }] }],
      // Cannot do the job at all, which stays its own class.
      ["issues-write-missing", { mints: [{ body: mintBody({ permissions: { issues: "read", metadata: "read" } }) }] }],
      ["issues-write-missing", { mints: [{ body: mintBody({ permissions: { metadata: "read" } }) }] }],
      // Installed somewhere else entirely.
      ["repository-not-covered", { mints: [{ body: mintBody() }], reach: ["someone-else/other-app"] }],
      ["repository-not-covered", { mints: [{ body: mintBody() }], reach: [] }],
      // The list itself could not be read, so the scope is unproven — which is
      // not the same as proven wrong, and is not treated as proven right.
      ["repository-list-unreadable", { mints: [{ body: mintBody() }], reachStatus: 403 }],
    ];

    for (const [failure, options] of cases) {
      const transport = stubTransport(options);
      const source = createInstallationTokenSource({
        credential, owner: OWNER, repo: REPO, fetchImpl: transport.fetchImpl, now: () => NOW,
      });
      assert.equal(await source.token(), null, `${failure} must resolve to no credential`);
      assert.equal(source.failure, `${failure}:201`);
      assert.ok(APP_MINT_FAILURES[failure], `${failure} must be a published class`);
      // The class travels on the summary, so a cycle reports why it has no
      // identity rather than reporting an identity with nothing in it.
      assert.equal(source.summary().failure, `${failure}:201`);
      assert.equal(source.summary().token_expires_at, null);
      // A rejected grant is not retried request after request.
      assert.equal(await source.token(), null);
      assert.equal(transport.minted, 1);
      // And nothing was delivered under it: the repository was never touched.
      assert.equal(transport.calls.some((call) => call.url.includes("/repos/")), false);
    }

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

test("a grant broader than the agreed one takes the cycle offline before anything is replayed", async () => {
  await withTempDir("crol-app-ensure", async (dir) => {
    const { credential } = resolveGitHubAppCredential({ env: await installedApp(dir) });
    const transport = stubTransport({
      mints: [{ body: mintBody() }],
      reach: ["cityscroll/cityscroll-app", "cityscroll/somewhere-else"],
    });
    const source = createInstallationTokenSource({
      credential, owner: OWNER, repo: REPO, fetchImpl: transport.fetchImpl, now: () => NOW,
    });
    // ensure() is what a cycle calls before it delivers: it proves the identity
    // and hands back the class, so a too-broad grant is a stated offline reason
    // rather than an error against whichever intent was replayed first.
    assert.equal(await source.ensure(), "repository-scope-too-broad:201");
    assert.equal(source.summary().identity_kind, "app");
    assert.equal(source.summary().repositories.length, 0);
    assert.equal(transport.calls.some((call) => call.url.includes("/repos/")), false);
  });
});

test("the exact-grant predicates name each way a grant can differ", () => {
  assert.equal(grantIsExactlyRequired({ issues: "write", metadata: "read" }), true);
  assert.equal(grantIsExactlyRequired({ metadata: "read", issues: "write" }), true, "key order is not part of a grant");
  assert.equal(grantIsExactlyRequired(REQUIRED_INSTALLATION_PERMISSIONS), true);
  assert.equal(grantIsExactlyRequired({ issues: "write", metadata: "read", contents: "read" }), false);
  assert.equal(grantIsExactlyRequired({ issues: "write" }), false);
  assert.equal(grantIsExactlyRequired({}), false);
  assert.equal(grantIsExactlyRequired(null), false);

  assert.deepEqual(permissionDiff({ issues: "write", metadata: "read", contents: "read" }), {
    extra: ["contents"], missing: [], wrong: [],
  });
  assert.deepEqual(permissionDiff({ issues: "write" }), { extra: [], missing: ["metadata"], wrong: [] });
  assert.deepEqual(permissionDiff({ issues: "read", metadata: "read" }), { extra: [], missing: [], wrong: ["issues"] });

  assert.equal(reachesExactlyThisRepository(["cityscroll/cityscroll-app"], 1, OWNER, REPO), true);
  // The provider's own spelling is not guaranteed to match the runner's.
  assert.equal(reachesExactlyThisRepository(["CityScroll/CityScroll-App"], 1, OWNER, REPO), true);
  assert.equal(reachesExactlyThisRepository(["cityscroll/cityscroll-app", "cityscroll/other"], 2, OWNER, REPO), false);
  assert.equal(reachesExactlyThisRepository(["cityscroll/cityscroll-app"], 4, OWNER, REPO), false, "the count is the provider's, not the page's");
  assert.equal(reachesExactlyThisRepository([], 0, OWNER, REPO), false);
  assert.equal(reachesExactlyThisRepository(["someone-else/other"], 1, OWNER, REPO), false);
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

/** Every file the cycle left behind, as one flat list of path and text. */
async function filesUnder(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    found.push({ path, text: await readFile(path, "utf8") });
  }
  return found;
}

test("no surface a cycle produces carries the key, the assertion, or a minted token", async () => {
  await withTempDir("crol-app-no-leak", async (stateDir) => {
    // Distinctive fixtures, so an assertion fails on a real leak rather than on
    // a coincidence, and names which byte escaped.
    const MINTED_TOKEN = "ghs-fixture-minted-token-must-never-be-published";
    const SECRETS = [
      ["the minted installation token", MINTED_TOKEN],
      ["the App private key", PRIVATE_PEM.toString().trim()],
      // A reflowed or re-wrapped copy of the key would not match the whole PEM,
      // so one distinctive interior line of the key material is checked too.
      ["a line of the App private key", PRIVATE_PEM.toString().trim().split("\n").slice(3, 4)[0]],
    ];

    const priorKey = process.env.CITYSCROLL_ADMIN_KEY;
    process.env.CITYSCROLL_ADMIN_KEY = "secret";
    const logged = [];
    try {
      const app = await installedApp(stateDir);
      // Mints once, then refuses every repository request, so this exercises a
      // delivery failure under a good credential.
      const transport = stubTransport({ mints: [{ body: mintBody({ token: MINTED_TOKEN }) }], repoStatus: 500 });
      transport.fetchImpl = (function wrap(inner) {
        return async (url, options = {}) => {
          const response = await inner(url, options);
          return url.includes("/repos/") ? { ok: false, status: 500, async json() { return {}; } } : response;
        };
      })(transport.fetchImpl);

      const identity = resolveDeliveryIdentity({
        env: app,
        apiBase: "https://api.example.test",
        fetchImpl: transport.fetchImpl,
        now: () => NOW,
        log: (line) => logged.push(line),
      });
      assert.equal(identity.kind, "app");

      // One pending intent, so a failed delivery has something to record
      // against and the outbox writes a last_error to disk.
      await persistScheduleResult({
        stateDir,
        jobId: "leak-probe",
        runKey: "2026-09-06T11-00",
        result: { status: "degraded", observed_at: NOW.toISOString() },
        issue: { mode: "open", title: "A probe intent", body: "A probe intent body." },
      });
      const replay = await replayOutbox({ stateDir, now: NOW, github: identity.github });
      assert.equal(replay.status, "degraded", "the delivery must actually have failed for this to prove anything");
      assert.equal(replay.errors.length, 1);

      // The assertion is only knowable after a mint has happened.
      const exchange = transport.calls.find((call) => call.url.includes("/access_tokens"));
      const jwt = String(exchange.authorization).replace(/^Bearer /, "");
      assert.match(jwt, /^[\w-]+\.[\w-]+\.[\w-]+$/);
      SECRETS.push(["the signed App assertion", jwt]);
      SECRETS.push(["the assertion signature", jwt.split(".")[2]]);

      const summary = identity.source.summary();
      const heartbeat = await publishHeartbeat(stateDir, NOW, ["leak-probe"], {
        runId: RUN_ID,
        sourceRevision: REVISION,
        outboxDelivery: "credentialed",
        outboxDeliveryIdentity: identity.kind,
        outboxDeliveryTokenExpiresAt: summary.token_expires_at,
        fetchImpl: async () => ({ ok: false, status: 503 }),
      });

      // (e) a failed mint, whose error reaches the outbox as an intent's
      // last_error and reaches an operator as a thrown message.
      const refused = stubTransport({ mints: [{ status: 401 }] });
      const brokenIdentity = resolveDeliveryIdentity({
        env: app,
        apiBase: "https://api.example.test",
        fetchImpl: refused.fetchImpl,
        now: () => NOW,
        log: (line) => logged.push(line),
      });
      const mintError = await brokenIdentity.github.listIssues().then(() => null, (error) => error);
      assert.ok(mintError, "a failed mint must raise rather than request with no credential");
      const brokenReplay = await replayOutbox({ stateDir, now: NOW, github: brokenIdentity.github });

      // The five surfaces, each named where it fails.
      const receipt = JSON.stringify({
        delivery: { status: "credentialed", reason: null, ...summary },
        replayBefore: replay,
        replayAfter: brokenReplay,
        heartbeat,
      });
      const surfaces = [
        ["(b) a log line the cycle wrote", logged.join("\n")],
        ["(c) the cycle receipt", receipt],
        ["(d) a heartbeat field", JSON.stringify(heartbeat)],
        ["(e) the error message from a failed mint", String(mintError?.stack || mintError)],
        ["(e) the error message from a failed delivery", replay.errors.join("\n")],
        ["(e) the error recorded against an intent after a failed mint", brokenReplay.errors.join("\n")],
        ["the published identity summary", JSON.stringify(summary)],
      ];
      // (a) every file the cycle wrote, including the outbox intent's
      // last_error and the persisted heartbeat.
      const written = await filesUnder(stateDir);
      assert.ok(written.some((file) => file.path.includes("outbox")), "the cycle must have written an outbox intent");
      assert.ok(written.some((file) => file.path.includes("heartbeat")), "the cycle must have written a heartbeat");
      for (const file of written) {
        // The three credential files are the credential; they are not a surface
        // the cycle produced, and asserting against them would be circular.
        if (Object.values(app).includes(file.path)) continue;
        surfaces.push([`(a) the file the cycle wrote at ${file.path.slice(stateDir.length + 1)}`, file.text]);
      }

      for (const [surface, text] of surfaces) {
        for (const [name, secret] of SECRETS) {
          assert.ok(secret && secret.length > 8, `${name} is not a usable fixture`);
          assert.equal(text.includes(secret), false, `${name} appears in ${surface}`);
        }
      }

      // The proof is only worth something if these surfaces carry real content.
      assert.match(logged.join("\n") + receipt, /exchange-refused:401/);
      assert.ok(written.find((file) => file.path.includes("outbox")).text.includes("last_error"));
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
