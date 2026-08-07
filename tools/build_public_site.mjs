#!/usr/bin/env node

import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

function readConfigList(config, key) {
  const match = config.match(new RegExp(`^${key}:\\n((?:[ \\t]+- .*\\n?)*)`, "m"));
  if (!match) return [];
  return [...match[1].matchAll(/^[ \t]+- (.+)$/gm)].map((entry) => entry[1].trim());
}

function isExcluded(relativePath, excluded) {
  const parts = relativePath.split(sep);
  return excluded.some((entry) => {
    const normalized = entry.replaceAll("/", sep);
    return relativePath === normalized
      || relativePath.startsWith(`${normalized}${sep}`)
      || parts.includes(normalized);
  });
}

function copyTree(sourceRoot, destinationRoot) {
  const configPath = join(sourceRoot, "_config.yml");
  const config = statSync(configPath, { throwIfNoEntry: false })
    ? readFileSync(configPath, "utf8")
    : "";
  const excluded = readConfigList(config, "exclude");
  const included = new Set(readConfigList(config, "include"));

  rmSync(destinationRoot, { recursive: true, force: true });
  mkdirSync(destinationRoot, { recursive: true });

  function visit(sourceDir, destinationDir, prefix = "") {
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relativePath === "_config.yml" || isExcluded(relativePath, excluded)) continue;
      if (entry.name.startsWith(".") || entry.name === ".git") continue;
      if (entry.name.startsWith("_") && !included.has(relativePath)) continue;

      const sourcePath = join(sourceDir, entry.name);
      const destinationPath = join(destinationDir, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(destinationPath, { recursive: true });
        visit(sourcePath, destinationPath, relativePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        mkdirSync(dirname(destinationPath), { recursive: true });
        cpSync(sourcePath, destinationPath, { dereference: false });
      }
    }
  }

  visit(sourceRoot, destinationRoot);
}

const args = parseArgs(process.argv.slice(2));
const cwd = process.cwd();
const sourceDir = resolve(cwd, args["source-dir"] || ".");
const siteSource = statSync(join(sourceDir, "site", "index.html"), { throwIfNoEntry: false })
  ? join(sourceDir, "site")
  : sourceDir;
const siteDir = resolve(cwd, args["site-dir"] || "_site");

if (siteDir === sourceDir || siteDir === siteSource || siteDir.startsWith(`${sourceDir}${sep}`) && siteDir.startsWith(`${siteSource}${sep}`)) {
  throw new Error(`Refusing to overwrite source tree: ${siteDir}`);
}

copyTree(siteSource, siteDir);
console.log(`Built public site from ${relative(cwd, siteSource) || "."} to ${relative(cwd, siteDir) || "."}`);
