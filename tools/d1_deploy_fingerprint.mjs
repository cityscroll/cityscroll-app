#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const D1_DEPLOY_FINGERPRINT_SCHEMA = "cityscroll.d1-deploy-fingerprint.v1";
export const D1_PUBLICATION_STATE_SCHEMA = "cityscroll.d1-publication-state.v1";
export const D1_PUBLICATION_RECEIPT_SCHEMA = "cityscroll.d1-publication-receipt.v1";

export const DEFAULT_FINGERPRINT_INPUTS = Object.freeze([
  "tools/build_worker_d1_read_models.mjs",
  "tools/d1_deploy_fingerprint.mjs",
  "site/keyword_search_index_shards.mjs",
  "site/data/ocp_awards_warehouse_lookup.json",
  "worker/wrangler.toml",
  "worker/src/data/entity_intelligence_lookup.json",
  "worker/src/data/keyword_search_index_shards",
  "worker/migrations",
]);

export async function resolveFingerprintInputs({
  root = ROOT,
  baseInputs = DEFAULT_FINGERPRINT_INPUTS,
} = {}) {
  const manifestModulePath = resolve(root, "tools/d1_manifest.mjs");
  if (!existsSync(manifestModulePath)) return [...baseInputs];
  const manifestModule = await import(pathToFileURL(manifestModulePath).href);
  if (typeof manifestModule.fingerprintInputs !== "function") {
    throw new Error("tools/d1_manifest.mjs must export fingerprintInputs()");
  }
  const declared = manifestModule.fingerprintInputs();
  if (!Array.isArray(declared) || declared.some((path) => typeof path !== "string" || !path)) {
    throw new Error("fingerprintInputs() must return an array of repository-relative paths");
  }
  return [...new Set([...baseInputs, "tools/d1_manifest.mjs", ...declared])];
}

function pathKey(root, path) {
  return relative(root, path).split(sep).join("/");
}

function collectFiles(root, inputPaths) {
  const files = [];
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`fingerprint input must not be a symlink: ${pathKey(root, path)}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(resolve(path, entry));
      return;
    }
    if (!stat.isFile()) throw new Error(`fingerprint input is not a regular file: ${pathKey(root, path)}`);
    files.push(path);
  };
  for (const input of [...inputPaths].sort()) visit(resolve(root, input));
  return files.sort((left, right) => pathKey(root, left).localeCompare(pathKey(root, right)));
}

export function computeDeployFingerprint({
  root = ROOT,
  inputPaths = DEFAULT_FINGERPRINT_INPUTS,
  contract = D1_DEPLOY_FINGERPRINT_SCHEMA,
} = {}) {
  const absoluteRoot = resolve(root);
  const hash = createHash("sha256");
  hash.update(`${contract}\0`, "utf8");
  const files = collectFiles(absoluteRoot, inputPaths);
  for (const path of files) {
    const bytes = readFileSync(path);
    hash.update(`${pathKey(absoluteRoot, path)}\0${bytes.byteLength}\0`, "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
  }
  return {
    schema: D1_DEPLOY_FINGERPRINT_SCHEMA,
    fingerprint: hash.digest("hex"),
    files: files.map((path) => pathKey(absoluteRoot, path)),
  };
}

export function loadPublishedState(path) {
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (
    state?.schema !== D1_PUBLICATION_STATE_SCHEMA
    || state?.status !== "published"
    || !/^[a-f0-9]{64}$/.test(state?.fingerprint || "")
  ) {
    throw new Error("D1 publication state is malformed");
  }
  return state;
}

export function decidePublication({ fingerprint, priorState = null, force = false }) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint || "")) throw new Error("invalid D1 deploy fingerprint");
  const unchanged = priorState?.fingerprint === fingerprint;
  const shouldPublish = Boolean(force) || !unchanged;
  const reason = force
    ? "operator_bypass"
    : unchanged
      ? "fingerprint_unchanged"
      : priorState
        ? "fingerprint_changed"
        : "published_state_missing";
  return {
    shouldPublish,
    receipt: {
      schema: D1_PUBLICATION_RECEIPT_SCHEMA,
      fingerprint,
      previous_fingerprint: priorState?.fingerprint || null,
      decision: shouldPublish ? "publish" : "skip",
      reason,
      operator_bypass: Boolean(force),
      d1_writes: shouldPublish
        ? { commands: null, rows: null }
        : { commands: 0, rows: 0 },
    },
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeGithubOutput(path, values) {
  if (!path) return;
  appendFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function parseArgs(argv) {
  const args = { command: argv[2] };
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unknown argument: ${token}`);
    args[token.slice(2)] = argv[++index];
  }
  return args;
}

function required(args, name) {
  if (!args[name]) throw new Error(`Missing --${name}`);
  return args[name];
}

function parseBoolean(value) {
  if (value === "true") return true;
  if (value === "false" || value == null || value === "") return false;
  throw new Error(`Expected true or false, got: ${value}`);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === "fingerprint") {
    const root = args.root || ROOT;
    const inputPaths = await resolveFingerprintInputs({ root });
    const result = computeDeployFingerprint({ root, inputPaths });
    writeGithubOutput(args["github-output"], { fingerprint: result.fingerprint });
    console.log(JSON.stringify(result));
    return;
  }
  if (args.command === "decide") {
    const fingerprint = required(args, "fingerprint");
    const priorState = loadPublishedState(required(args, "state"));
    const result = decidePublication({
      fingerprint,
      priorState,
      force: parseBoolean(args.force),
    });
    writeJson(required(args, "receipt"), result.receipt);
    writeGithubOutput(args["github-output"], {
      "should-publish": String(result.shouldPublish),
      decision: result.receipt.decision,
    });
    console.log(JSON.stringify(result.receipt));
    return;
  }
  if (args.command === "mark-published") {
    const fingerprint = required(args, "fingerprint");
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("invalid D1 deploy fingerprint");
    writeJson(required(args, "state"), {
      schema: D1_PUBLICATION_STATE_SCHEMA,
      status: "published",
      fingerprint,
    });
    writeJson(required(args, "receipt"), {
      schema: D1_PUBLICATION_RECEIPT_SCHEMA,
      fingerprint,
      decision: "published",
      reason: parseBoolean(args.force) ? "operator_bypass" : "fingerprint_changed",
      operator_bypass: parseBoolean(args.force),
      d1_writes: { commands: Number(args.commands) || null, rows: null },
    });
    return;
  }
  throw new Error("Expected command: fingerprint, decide, or mark-published");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
