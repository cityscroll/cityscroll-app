#!/usr/bin/env node
/**
 * Board neighborhood journey production verifier.
 *
 *   node tools/verify_board_neighborhood_journey.mjs \
 *     --base-url https://cityscroll.org \
 *     --out docs/evidence/board-neighborhood-journey/readback.json
 *
 * Invokes the Playwright capture harness. Exits non-zero when browser or
 * published-data assertions are unmet, when the served Pages revision does not
 * yet contain the recorded delivery commit, or when required subjects are
 * absent from the served origin.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAPTURE = join(ROOT, "tools/capture_board_neighborhood_journey.py");
const DEFAULT_OUT = join(ROOT, "docs/evidence/board-neighborhood-journey/readback.json");
const DEFAULT_BASE = "https://cityscroll.org/";

function resolvePython() {
  const candidates = [
    process.env.CITYSCROLL_BROWSER_PYTHON,
    process.env.CROL_A11Y_VENV ? join(process.env.CROL_A11Y_VENV, "bin/python3") : null,
    join(process.env.HOME || "", ".local/share/cityscroll/a11y-python/bin/python3"),
    "python3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "python3" || existsSync(candidate)) return candidate;
  }
  return "python3";
}

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.CROL_BASE || DEFAULT_BASE,
    out: DEFAULT_OUT,
    manifestOut: join(ROOT, "docs/evidence/board-neighborhood-journey/capture-manifest.json"),
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--out") args.out = resolve(argv[++i]);
    else if (arg === "--manifest-out") args.manifestOut = resolve(argv[++i]);
    else if (arg === "--check") args.check = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(`Usage: node tools/verify_board_neighborhood_journey.mjs [options]

Options:
  --base-url URL       Production origin (default ${DEFAULT_BASE})
  --out PATH           Read-back JSON path
  --manifest-out PATH  Capture-manifest JSON path
  --check              Validate committed receipts without hitting production
`);
    return;
  }
  if (!existsSync(CAPTURE)) {
    console.error(`capture harness missing at ${CAPTURE}`);
    process.exitCode = 2;
    return;
  }

  const python = resolvePython();
  const cmd = [CAPTURE];
  if (args.check) cmd.push("--check");
  else {
    cmd.push("--base-url", args.baseUrl);
  }
  cmd.push("--out", args.out, "--manifest-out", args.manifestOut);

  const result = spawnSync(python, cmd, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CITYSCROLL_BROWSER_PYTHON: python,
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(String(result.error.message || result.error));
    process.exitCode = 2;
    return;
  }
  process.exitCode = Number.isInteger(result.status) ? result.status : 2;
}

main();
