import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "tools/install_worker_dependencies.sh");
const EXPECTED_VERSION = "10.15.1";

function writeStub(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function printCommand(binDir, extraEnv = {}) {
  const result = spawnSync("bash", [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
      CITYSCROLL_PNPM_PRINT_COMMAND: "1",
      // Keep node available for reading packageManager.
      ...extraEnv,
    },
  });
  return result;
}

test("prefers a PATH pnpm that already reports the pinned version (action-setup case)", () => {
  const bin = mkdtempSync(join(tmpdir(), "cityscroll-action-pnpm-"));
  mkdirSync(bin, { recursive: true });
  writeStub(
    bin,
    "pnpm",
    `#!/usr/bin/env bash\nif [[ "$*" == "--version" ]]; then echo "${EXPECTED_VERSION}"; exit 0; fi\necho "unexpected pnpm args: $*" >&2; exit 2\n`,
  );
  writeStub(
    bin,
    "corepack",
    `#!/usr/bin/env bash\necho "corepack should not run when action pnpm matches" >&2\nexit 97\n`,
  );
  // Ensure node remains reachable for packageManager read.
  const nodeDir = process.execPath.replace(/\/node$/, "");
  const result = printCommand(bin, { PATH: `${bin}:${nodeDir}:/usr/bin:/bin` });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /^pnpm$/);
  assert.doesNotMatch(result.stdout, /corepack/);
  assert.doesNotMatch(result.stderr, /corepack should not run/);
});

test("falls back to corepack pnpm@pin when PATH has no matching pnpm", () => {
  const bin = mkdtempSync(join(tmpdir(), "cityscroll-corepack-pnpm-"));
  mkdirSync(bin, { recursive: true });
  writeStub(
    bin,
    "corepack",
    `#!/usr/bin/env bash\nif [[ "$1" == "pnpm@${EXPECTED_VERSION}" && "$2" == "--version" ]]; then echo "${EXPECTED_VERSION}"; exit 0; fi\necho "unexpected corepack args: $*" >&2; exit 2\n`,
  );
  const nodeDir = process.execPath.replace(/\/node$/, "");
  const result = printCommand(bin, { PATH: `${bin}:${nodeDir}:/usr/bin:/bin` });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), `corepack pnpm@${EXPECTED_VERSION}`);
});

test("ignores a PATH pnpm whose version drifts from the packageManager pin", () => {
  const bin = mkdtempSync(join(tmpdir(), "cityscroll-wrong-pnpm-"));
  mkdirSync(bin, { recursive: true });
  writeStub(
    bin,
    "pnpm",
    `#!/usr/bin/env bash\nif [[ "$*" == "--version" ]]; then echo "9.0.0"; exit 0; fi\nexit 2\n`,
  );
  writeStub(
    bin,
    "corepack",
    `#!/usr/bin/env bash\nif [[ "$1" == "pnpm@${EXPECTED_VERSION}" && "$2" == "--version" ]]; then echo "${EXPECTED_VERSION}"; exit 0; fi\necho "unexpected corepack args: $*" >&2; exit 2\n`,
  );
  const nodeDir = process.execPath.replace(/\/node$/, "");
  const result = printCommand(bin, { PATH: `${bin}:${nodeDir}:/usr/bin:/bin` });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), `corepack pnpm@${EXPECTED_VERSION}`);
});
