/**
 * Secret-transport regression: sentinel token must never appear on launcher
 * admission argv, child process argv, or written receipts/logs.
 * Synthetic sentinel only — never load a real credential file.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, "run_with_cloudflare_deploy_token.sh");
const FENCE = join(HERE, "worker_deploy_fence.mjs");
const SENTINEL = "SENTINEL_cfut_TRANSPORT_TEST_ONLY_not_a_real_credential";

function buildAdmissionCommand(wrapperPath, childArgs) {
  // Exact shape a process launcher prints after `--`.
  return [wrapperPath, "--", ...childArgs].join(" ");
}

function buildFenceEnv(root) {
  return {
    ...process.env,
    WORKER_DEPLOY_FENCE_ROOT: root,
    WORKER_DEPLOY_FENCE_WINDOW: "secret-transport-test-window",
    WORKER_DEPLOY_OWNER: "secret-transport-test-owner",
    WORKER_DEPLOY_FENCE_REQUIRED: "true",
  };
}

function runFence(command, env) {
  return spawnSync(process.execPath, [FENCE, command], { env, encoding: "utf8" });
}

test("launcher admission command never contains the sentinel token", () => {
  const admission = buildAdmissionCommand(WRAPPER, [
    "npx",
    "wrangler@4.126.0",
    "versions",
    "deploy",
    "rollback@95%",
    "candidate@5%",
    "--yes",
  ]);
  assert.equal(admission.includes(SENTINEL), false);
  assert.equal(/CLOUDFLARE_API_TOKEN=/.test(admission), false);
  assert.equal(/cfut_/.test(admission), false);
  assert.match(admission, /run_with_cloudflare_deploy_token\.sh -- npx wrangler@4\.126\.0 versions deploy/);
});

test("wrapper refuses token assignment on argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-deploy-secret-transport-"));
  try {
    const tokenFile = join(dir, "token.key");
    writeFileSync(tokenFile, `${SENTINEL}\n`, { mode: 0o600 });
    const result = spawnSync(
      WRAPPER,
      ["--", "CLOUDFLARE_API_TOKEN=should-refuse", "true"],
      {
        env: { ...process.env, CLOUDFLARE_API_TOKEN_FILE: tokenFile, HOME: dir },
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing token/);
    assert.equal(result.stdout.includes(SENTINEL), false);
    assert.equal(result.stderr.includes(SENTINEL), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapper loads token from file into child env only; absent from child argv and receipts", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-deploy-secret-transport-"));
  try {
    const tokenFile = join(dir, "token.key");
    const fenceRoot = join(dir, "fence");
    const receiptPath = join(dir, "child-receipt.json");
    const childScript = join(dir, "child.mjs");
    writeFileSync(tokenFile, `${SENTINEL}\n`, { mode: 0o600 });
    writeFileSync(
      childScript,
      `
import { writeFileSync } from "node:fs";
const receipt = {
  argv: process.argv.slice(1),
  env_has_token: typeof process.env.CLOUDFLARE_API_TOKEN === "string"
    && process.env.CLOUDFLARE_API_TOKEN.length > 0,
  env_token_matches_sentinel: process.env.CLOUDFLARE_API_TOKEN === ${JSON.stringify(SENTINEL)},
  env_has_token_file: process.env.CLOUDFLARE_API_TOKEN_FILE !== undefined,
};
writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify(receipt), { mode: 0o600 });
`,
      { mode: 0o600 },
    );

    const admission = buildAdmissionCommand(WRAPPER, [process.execPath, childScript]);
    assert.equal(admission.includes(SENTINEL), false);

    const fenceEnv = buildFenceEnv(fenceRoot);
    const acquired = runFence("acquire", fenceEnv);
    assert.equal(acquired.status, 0, acquired.stderr);
    const result = spawnSync(WRAPPER, ["--", process.execPath, childScript], {
      env: {
        ...fenceEnv,
        CLOUDFLARE_API_TOKEN_FILE: tokenFile,
        // Ensure parent env does not already carry the sentinel on this test path.
        CLOUDFLARE_API_TOKEN: "",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes(SENTINEL), false);
    assert.equal(result.stderr.includes(SENTINEL), false);

    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.env_has_token, true);
    assert.equal(receipt.env_token_matches_sentinel, true);
    assert.equal(receipt.env_has_token_file, false);
    assert.equal(receipt.argv.some((arg) => String(arg).includes(SENTINEL)), false);
    assert.equal(receipt.argv.some((arg) => /CLOUDFLARE_API_TOKEN=/.test(String(arg))), false);
    assert.equal(JSON.stringify(receipt).includes(SENTINEL), false);
    const released = runFence("release", fenceEnv);
    assert.equal(released.status, 0, released.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unrecognized credentialed commands require the fence by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-deploy-secret-transport-"));
  try {
    const tokenFile = join(dir, "token.key");
    writeFileSync(tokenFile, `${SENTINEL}\n`, { mode: 0o600 });
    const env = { ...process.env, CLOUDFLARE_API_TOKEN_FILE: tokenFile, HOME: dir };
    delete env.WORKER_DEPLOY_FENCE_ROOT;
    delete env.WORKER_DEPLOY_FENCE_WINDOW;
    delete env.WORKER_DEPLOY_OWNER;
    delete env.WORKER_DEPLOY_FENCE_REQUIRED;
    const result = spawnSync(WRAPPER, ["--", "node", "-e", "process.exit(0)"], { env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WORKER_DEPLOY_FENCE_REQUIRED=true is required for credentialed commands/);
    assert.equal(result.stderr.includes(SENTINEL), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only exact read-only Wrangler argv is fence-exempt; extra flags and shell indirection are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-deploy-secret-transport-"));
  try {
    const tokenFile = join(dir, "token.key");
    const fakeBin = join(dir, "bin");
    const fakeNpx = join(fakeBin, "npx");
    writeFileSync(tokenFile, `${SENTINEL}\n`, { mode: 0o600 });
    mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
    writeFileSync(fakeNpx, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(fakeNpx, 0o700);
    const env = {
      ...process.env,
      CLOUDFLARE_API_TOKEN_FILE: tokenFile,
      HOME: dir,
      PATH: `${fakeBin}:${process.env.PATH}`,
    };
    delete env.WORKER_DEPLOY_FENCE_ROOT;
    delete env.WORKER_DEPLOY_FENCE_WINDOW;
    delete env.WORKER_DEPLOY_OWNER;
    delete env.WORKER_DEPLOY_FENCE_REQUIRED;
    const readOnly = spawnSync(WRAPPER, ["--", "npx", "wrangler@4.126.0", "versions", "list", "--json"], { env, encoding: "utf8" });
    assert.equal(readOnly.status, 0, readOnly.stderr);
    const restorerReadOnly = spawnSync(
      WRAPPER,
      ["--", "npx", "--yes", "wrangler@4.126.0", "versions", "list", "--name", "cityscroll-worker"],
      { env, encoding: "utf8" },
    );
    assert.equal(restorerReadOnly.status, 0, restorerReadOnly.stderr);
    const extraFlag = spawnSync(WRAPPER, ["--", "npx", "wrangler@4.126.0", "versions", "list", "--json", "--upload"], { env, encoding: "utf8" });
    assert.notEqual(extraFlag.status, 0);
    assert.match(extraFlag.stderr, /WORKER_DEPLOY_FENCE_REQUIRED=true/);
    const shellIndirect = spawnSync(WRAPPER, ["--", "sh", "-c", "npx wrangler@4.126.0 versions list --json"], { env, encoding: "utf8" });
    assert.notEqual(shellIndirect.status, 0);
    assert.match(shellIndirect.stderr, /WORKER_DEPLOY_FENCE_REQUIRED=true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy env TOKEN=value cmd admission shape is rejected by policy helper", async () => {
  const { admissionCommandExposesDeployToken } = await import("./lib/worker_deploy_secret_transport.mjs");
  const bad = `env CLOUDFLARE_API_TOKEN=${SENTINEL} CLOUDFLARE_ACCOUNT_ID=acct npx wrangler@4.126.0 versions deploy a@95% b@5% --yes`;
  const good = buildAdmissionCommand(WRAPPER, [
    "npx",
    "wrangler@4.126.0",
    "versions",
    "deploy",
    "a@95%",
    "b@5%",
    "--yes",
  ]);
  assert.equal(admissionCommandExposesDeployToken(bad), true);
  assert.equal(admissionCommandExposesDeployToken(good), false);
});

test("curl Bearer-on-argv is rejected; -H @file is accepted", async () => {
  const {
    admissionCommandExposesDeployToken,
    curlArgvExposesBearerToken,
    buildCurlArgvWithAuthHeaderFile,
  } = await import("./lib/worker_deploy_secret_transport.mjs");

  const badCurl = [
    "curl",
    "-fsS",
    "-H",
    `Authorization: Bearer ${SENTINEL}`,
    "https://api.cloudflare.com/client/v4/accounts/x/workers/scripts/y/deployments",
  ];
  assert.equal(curlArgvExposesBearerToken(badCurl), true);
  assert.equal(admissionCommandExposesDeployToken(badCurl.join(" ")), true);

  const dir = mkdtempSync(join(tmpdir(), "worker-deploy-curl-auth-"));
  try {
    const hdr = join(dir, "auth.hdr");
    writeFileSync(hdr, `Authorization: Bearer ${SENTINEL}\n`, { mode: 0o600 });
    const safe = buildCurlArgvWithAuthHeaderFile({
      authHeaderFile: hdr,
      url: "https://api.cloudflare.com/client/v4/accounts/x/workers/scripts/y/deployments",
      extraArgs: ["-H", "Accept: application/json"],
    });
    assert.equal(curlArgvExposesBearerToken(safe), false);
    assert.equal(safe.includes(SENTINEL), false);
    assert.equal(safe.some((a) => String(a).includes(SENTINEL)), false);
    assert.ok(safe.includes(`@${hdr}`));
    assert.equal(admissionCommandExposesDeployToken(safe.join(" ")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("buildSafeDeployChildArgv rejects sentinel and wraps wrangler", async () => {
  const { buildSafeDeployChildArgv, admissionCommandExposesDeployToken } = await import(
    "./lib/worker_deploy_secret_transport.mjs"
  );
  const argv = buildSafeDeployChildArgv({
    wrapperPath: WRAPPER,
    childArgv: ["npx", "wrangler@4.126.0", "versions", "deploy", "a@100%", "--yes"],
  });
  assert.equal(argv[0], WRAPPER);
  assert.equal(argv[1], "--");
  assert.equal(admissionCommandExposesDeployToken(argv.join(" ")), false);
  assert.throws(
    () =>
      buildSafeDeployChildArgv({
        wrapperPath: WRAPPER,
        childArgv: [`CLOUDFLARE_API_TOKEN=${SENTINEL}`, "npx", "wrangler"],
      }),
    /must not embed deploy token/,
  );
});
