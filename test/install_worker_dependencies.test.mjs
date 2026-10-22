import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { withTempDirSync } from "../tools/lib/with_temp_dir.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "tools/install_worker_dependencies.sh");
const EXPECTED_VERSION = "10.15.1";
const REAL_NODE = process.execPath;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeStub(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** PATH that can run the installer without inheriting host pnpm/corepack shims. */
function hermeticPath(binDir) {
  writeStub(
    binDir,
    "node",
    `#!/bin/bash\nexec "${REAL_NODE}" "$@"\n`,
  );
  // Deliberately omit the real Node bin directory: on this host it also
  // contains pnpm and corepack, which would break absence/mismatch fixtures.
  return `${binDir}:/usr/bin:/bin`;
}

function runInstaller(binDir, { storeDir, extraEnv = {} } = {}) {
  return spawnSync("bash", [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: hermeticPath(binDir),
      CITYSCROLL_PNPM_STORE_DIR: storeDir,
      ...extraEnv,
    },
  });
}

function writeRecordingPnpm(binDir, logPath, storeEcho) {
  return writeStub(
    binDir,
    "pnpm",
    `#!/bin/bash
printf 'argv0=%s\\n' "$0" >> "${logPath}"
printf 'args=%s\\n' "$*" >> "${logPath}"
if [[ "$#" -eq 1 && "$1" == "--version" ]]; then
  echo "${EXPECTED_VERSION}"
  exit 0
fi
if [[ "$#" -ge 2 && "$1" == "store" && "$2" == "path" ]]; then
  echo "${storeEcho}"
  exit 0
fi
if [[ "$*" == *"--frozen-lockfile"* && "$*" == *"--store-dir"* && "$*" == *"install"* ]]; then
  exit 0
fi
echo "unexpected pnpm args: $*" >&2
exit 2
`,
  );
}

function writeRecordingCorepack(binDir, logPath, storeEcho) {
  return writeStub(
    binDir,
    "corepack",
    `#!/bin/bash
printf 'argv0=%s\\n' "$0" >> "${logPath}"
printf 'args=%s\\n' "$*" >> "${logPath}"
pin="pnpm@${EXPECTED_VERSION}"
if [[ "$1" != "$pin" ]]; then
  echo "unexpected corepack package manager: $1" >&2
  exit 2
fi
shift
if [[ "$#" -eq 1 && "$1" == "--version" ]]; then
  echo "${EXPECTED_VERSION}"
  exit 0
fi
if [[ "$#" -ge 2 && "$1" == "store" && "$2" == "path" ]]; then
  echo "${storeEcho}"
  exit 0
fi
if [[ "$*" == *"--frozen-lockfile"* && "$*" == *"--store-dir"* && "$*" == *"install"* ]]; then
  exit 0
fi
echo "unexpected corepack pnpm args: $*" >&2
exit 2
`,
  );
}

test("withTempDirSync removes the stub bin on success", () => {
  let captured;
  withTempDirSync("action-pnpm-success", (bin) => {
    captured = bin;
    writeStub(bin, "pnpm", "#!/bin/bash\necho ok\n");
    assert.equal(existsSync(bin), true);
  });
  assert.equal(existsSync(captured), false);
});

test("withTempDirSync removes the stub bin after a thrown failure", () => {
  let captured;
  assert.throws(() => {
    withTempDirSync("action-pnpm-fail", (bin) => {
      captured = bin;
      writeStub(bin, "pnpm", "#!/bin/bash\necho ok\n");
      assert.equal(existsSync(bin), true);
      throw new Error("force failure path");
    });
  }, /force failure path/);
  assert.equal(existsSync(captured), false);
});

test("prefers PATH pnpm and runs the real version/store/frozen-lockfile vector", () => {
  withTempDirSync("action-pnpm-vector", (bin) => {
    withTempDirSync("action-pnpm-store", (storeDir) => {
      const logPath = join(bin, "pnpm-argv.log");
      const pnpmPath = writeRecordingPnpm(bin, logPath, storeDir);
      writeStub(
        bin,
        "corepack",
        `#!/bin/bash\necho "corepack must not run when matching PATH pnpm is selected" >&2\nexit 97\n`,
      );

      const result = runInstaller(bin, { storeDir });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const log = readFileSync(logPath, "utf8");
      assert.match(log, new RegExp(`argv0=${escapeRegExp(pnpmPath)}`));
      assert.match(log, /args=--version/);
      assert.match(log, /args=.*install/);
      assert.match(log, /--frozen-lockfile/);
      assert.match(log, new RegExp(`--store-dir ${escapeRegExp(storeDir)}`));
      assert.doesNotMatch(log, /corepack/);
      assert.equal(existsSync(storeDir), true);
      // Store must stay outside the checkout (installer enforces this).
      assert.equal(storeDir.startsWith(`${ROOT}/`), false);
    });
  });
});

test("falls back to corepack pnpm@pin with a hermetic PATH (no host pnpm shim)", () => {
  withTempDirSync("corepack-pnpm-vector", (bin) => {
    withTempDirSync("corepack-pnpm-store", (storeDir) => {
      const logPath = join(bin, "corepack-argv.log");
      writeRecordingCorepack(bin, logPath, storeDir);
      // No pnpm stub at all — absence must not see host ~/.local/node/bin/pnpm.

      const result = runInstaller(bin, { storeDir });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const log = readFileSync(logPath, "utf8");
      assert.match(log, new RegExp(`args=pnpm@${EXPECTED_VERSION} --version`));
      assert.match(log, new RegExp(`args=pnpm@${EXPECTED_VERSION} .*install`));
      assert.match(log, /--frozen-lockfile/);
      assert.match(log, new RegExp(`--store-dir ${escapeRegExp(storeDir)}`));
      assert.equal(existsSync(join(bin, "pnpm")), false);
    });
  });
});

test("ignores a drifted PATH pnpm and falls back to corepack under a hermetic PATH", () => {
  withTempDirSync("wrong-pnpm-vector", (bin) => {
    withTempDirSync("wrong-pnpm-store", (storeDir) => {
      const logPath = join(bin, "corepack-argv.log");
      writeStub(
        bin,
        "pnpm",
        `#!/bin/bash\nif [[ "$*" == "--version" ]]; then echo "9.0.0"; exit 0; fi\necho "drifted pnpm should not install" >&2; exit 2\n`,
      );
      writeRecordingCorepack(bin, logPath, storeDir);

      const result = runInstaller(bin, { storeDir });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const log = readFileSync(logPath, "utf8");
      assert.match(log, new RegExp(`args=pnpm@${EXPECTED_VERSION} --version`));
      assert.match(log, /--frozen-lockfile/);
      assert.match(log, new RegExp(`--store-dir ${escapeRegExp(storeDir)}`));
    });
  });
});

test("rejects a store directory inside the checkout", () => {
  withTempDirSync("inside-store-pnpm", (bin) => {
    const insideStore = join(ROOT, "worker", ".pnpm-store-should-reject");
    mkdirSync(insideStore, { recursive: true });
    try {
      writeRecordingPnpm(bin, join(bin, "pnpm-argv.log"), insideStore);
      writeStub(bin, "corepack", "#!/bin/bash\nexit 97\n");
      const result = runInstaller(bin, { storeDir: insideStore });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /dependency store must be outside the checkout/);
    } finally {
      // Exact-owned cleanup of the checkout-side probe dir only.
      spawnSync("rm", ["-rf", insideStore], { encoding: "utf8" });
    }
  });
});
