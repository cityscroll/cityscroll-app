#!/usr/bin/env node

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverClientModuleGraph,
  repositoryRelativePath,
} from "./client_module_graph.mjs";
import { assertGeneratedOutputs } from "./generation_output_guard.mjs";
import { publicSiteSourceRoot, walkPublicSitePayload } from "./lib/public_site_payload.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.error("Usage: node tools/build_public_site.mjs [--source-dir DIR] [--site-dir DIR]");
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) usage();
    const key = arg.slice(2);
    if (key === "help") usage();
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    result[key] = value;
    index += 1;
  }
  return result;
}

function copyTree(sourceRoot, destinationRoot) {
  rmSync(destinationRoot, { recursive: true, force: true });
  mkdirSync(destinationRoot, { recursive: true });
  walkPublicSitePayload(sourceRoot, ({ sourcePath, relativePath }) => {
    const destinationPath = join(destinationRoot, relativePath.replaceAll("/", sep));
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath, { dereference: false });
  });
}

function publishClientCapabilityModules(sourceDir, siteSource, siteDir) {
  const graph = discoverClientModuleGraph({
    rootDir: siteSource,
    sourceRoots: [siteSource, sourceDir],
  });
  if (graph.missing.length) {
    throw new Error(`Client module graph has missing source modules: ${graph.missing.join(", ")}`);
  }

  for (const { sourcePath } of graph.modules.values()) {
    const repositoryPath = repositoryRelativePath(sourcePath, sourceDir);
    if (!repositoryPath?.startsWith("capabilities/")) continue;
    const destinationPath = join(siteDir, repositoryPath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
}

const args = parseArgs(process.argv.slice(2));
const cwd = process.cwd();
const sourceDir = resolve(cwd, args["source-dir"] || ".");
const siteSource = publicSiteSourceRoot(sourceDir);
const siteDir = resolve(cwd, args["site-dir"] || "_site");

if (siteDir === sourceDir || siteDir === siteSource || siteDir.startsWith(`${sourceDir}${sep}`) && siteDir.startsWith(`${siteSource}${sep}`)) {
  throw new Error(`Refusing to overwrite source tree: ${siteDir}`);
}

copyTree(siteSource, siteDir);
publishClientCapabilityModules(sourceDir, siteSource, siteDir);
assertGeneratedOutputs({
  rootDir: cwd,
  boundary: "public-site-generation",
  outputs: [join(siteDir, "index.html")],
});
console.log(`Built public site from ${relative(cwd, siteSource) || "."} to ${relative(cwd, siteDir) || "."}`);
