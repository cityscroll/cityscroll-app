#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";

const SCHEMA = "cityscroll.site-artifact-identity.v1";
const BUILD_CONTRACT = "cityscroll.pages-build.v1";

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag.startsWith("--")) fail(`unexpected argument: ${flag}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${flag}`);
    options.set(flag.slice(2), value);
    index += 1;
  }
  return { command, options };
}

function option(options, name, fallback) {
  return options.has(name) ? options.get(name) : fallback;
}

function sourceIdentity(options) {
  const lockfile = option(options, "lockfile", "worker/package-lock.json");
  const commitSha = git("rev-parse", "HEAD");
  const expectedCommit = option(options, "commit-sha", commitSha);
  if (commitSha !== expectedCommit) {
    fail(`checked-out commit ${commitSha} does not match expected commit ${expectedCommit}`);
  }

  const treeSha = git("rev-parse", "HEAD^{tree}");
  const lockfileSha256 = fileSha256(lockfile);
  const toolVersion = process.version;
  const identityPayload = {
    schema: SCHEMA,
    build_contract: BUILD_CONTRACT,
    commit_sha: commitSha,
    tree_sha: treeSha,
    lockfile: {
      path: lockfile,
      sha256: lockfileSha256,
    },
    tool: {
      name: "node",
      version: toolVersion,
    },
    build_inputs: {
      source_dir: option(options, "source-dir", "."),
      site_dir: option(options, "site-dir", "_site"),
      review_channel: option(options, "review-channel", ""),
      refresh_decision_outcomes: option(options, "refresh-decision-outcomes", "false"),
    },
  };
  return {
    ...identityPayload,
    build_input_identity: sha256(`${JSON.stringify(identityPayload)}\n`),
  };
}

function listFiles(root) {
  const rootReal = realpathSync(root);
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail(`site artifact contains a symbolic link: ${path}`);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        found.push(path);
      } else {
        fail(`site artifact contains an unsupported entry: ${path}`);
      }
    }
  };
  visit(rootReal);
  return found;
}

function checksumLines(siteDir) {
  const siteRoot = resolve(siteDir);
  return listFiles(siteRoot).map((path) => {
    const artifactPath = `${siteDir.replace(/\\/g, "/").replace(/\/$/, "")}/${relative(siteRoot, path).split(sep).join("/")}`;
    return `${fileSha256(path)}  ${artifactPath}`;
  });
}

function writeStamp(options) {
  const siteDir = option(options, "site-dir", "_site");
  const checksumsPath = option(options, "checksums", "_site.sha256");
  const manifestPath = option(options, "manifest", "_site.identity.json");
  const lines = checksumLines(siteDir);
  if (lines.length === 0) fail(`${siteDir} contains no files`);
  writeFileSync(checksumsPath, `${lines.join("\n")}\n`, "utf8");

  const manifest = {
    ...sourceIdentity(options),
    site: {
      checksum_manifest: checksumsPath,
      checksum_manifest_sha256: fileSha256(checksumsPath),
      file_count: lines.length,
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`stamped ${siteDir} (${lines.length} files, identity ${manifest.build_input_identity})\n`);
}

function verifyChecksums(siteDir, checksumsPath) {
  const expectedLines = readFileSync(checksumsPath, "utf8").trimEnd().split("\n");
  if (expectedLines.length === 0 || expectedLines[0] === "") fail(`${checksumsPath} is empty`);

  const expected = new Map();
  for (const line of expectedLines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) fail(`invalid checksum line: ${line}`);
    const [, digest, artifactPath] = match;
    if (expected.has(artifactPath)) fail(`duplicate checksum path: ${artifactPath}`);
    expected.set(artifactPath, digest);
  }

  const actualLines = checksumLines(siteDir);
  const actualPaths = new Set();
  for (const line of actualLines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    const [, digest, artifactPath] = match;
    actualPaths.add(artifactPath);
    if (!expected.has(artifactPath)) fail(`unlisted site file: ${artifactPath}`);
    if (expected.get(artifactPath) !== digest) fail(`checksum mismatch: ${artifactPath}`);
  }
  for (const artifactPath of expected.keys()) {
    if (!actualPaths.has(artifactPath)) fail(`missing site file: ${artifactPath}`);
  }
  return actualLines.length;
}

function verifyStamp(options) {
  const siteDir = option(options, "site-dir", "_site");
  const checksumsPath = option(options, "checksums", "_site.sha256");
  const manifestPath = option(options, "manifest", "_site.identity.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expectedIdentity = sourceIdentity(options);

  for (const field of ["schema", "build_contract", "commit_sha", "tree_sha", "build_input_identity"]) {
    if (manifest[field] !== expectedIdentity[field]) {
      fail(`${field} mismatch: expected ${expectedIdentity[field]}, received ${manifest[field]}`);
    }
  }
  if (JSON.stringify(manifest.lockfile) !== JSON.stringify(expectedIdentity.lockfile)) fail("lockfile identity mismatch");
  if (JSON.stringify(manifest.tool) !== JSON.stringify(expectedIdentity.tool)) fail("tool version mismatch");
  if (JSON.stringify(manifest.build_inputs) !== JSON.stringify(expectedIdentity.build_inputs)) fail("build inputs mismatch");
  if (manifest.site?.checksum_manifest !== checksumsPath) fail("checksum manifest path mismatch");
  if (manifest.site?.checksum_manifest_sha256 !== fileSha256(checksumsPath)) fail("checksum manifest digest mismatch");

  const fileCount = verifyChecksums(siteDir, checksumsPath);
  if (manifest.site?.file_count !== fileCount) fail("site file count mismatch");
  process.stdout.write(`verified ${siteDir} (${fileCount} files, identity ${manifest.build_input_identity})\n`);
}

function emitIdentity(options) {
  const identity = sourceIdentity(options);
  const githubOutput = option(options, "github-output", "");
  if (githubOutput) {
    appendFileSync(githubOutput, [
      `build-input-identity=${identity.build_input_identity}`,
      `tree-sha=${identity.tree_sha}`,
      `lockfile-sha256=${identity.lockfile.sha256}`,
      `tool-version=${identity.tool.version}`,
      "",
    ].join("\n"), "utf8");
  } else {
    process.stdout.write(`${JSON.stringify(identity, null, 2)}\n`);
  }
}

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "identity") emitIdentity(options);
  else if (command === "stamp") writeStamp(options);
  else if (command === "verify") verifyStamp(options);
  else fail("usage: site_artifact_identity.mjs <identity|stamp|verify> [--name value ...]");
} catch (error) {
  process.stderr.write(`site artifact identity: ${error.message}\n`);
  process.exitCode = 1;
}
