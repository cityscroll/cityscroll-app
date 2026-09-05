/**
 * The set of files the public site build publishes, derived from one place.
 *
 * tools/build_public_site.mjs copies this set into the Pages payload and
 * tools/check_pages_bundle_sizes.mjs measures it, so a path the build stops
 * publishing is a path the budget check stops measuring. Keeping the traversal
 * and the site/_config.yml include/exclude rules here is what makes those two
 * statements the same statement rather than two implementations that can drift.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

export function publicSiteSourceRoot(sourceDir) {
  return statSync(join(sourceDir, "site", "index.html"), { throwIfNoEntry: false })
    ? join(sourceDir, "site")
    : sourceDir;
}

function readConfigList(config, key) {
  const match = config.match(new RegExp(`^${key}:\\n((?:[ \\t]+- .*\\n?)*)`, "m"));
  if (!match) return [];
  return [...match[1].matchAll(/^[ \t]+- (.+)$/gm)].map((entry) => entry[1].trim());
}

export function readPublicSiteConfig(siteSource) {
  const configPath = join(siteSource, "_config.yml");
  const config = statSync(configPath, { throwIfNoEntry: false })
    ? readFileSync(configPath, "utf8")
    : "";
  return {
    excluded: readConfigList(config, "exclude"),
    included: new Set(readConfigList(config, "include")),
  };
}

export function isExcludedFromPublicSite(relativePath, excluded) {
  const parts = relativePath.split(sep);
  return excluded.some((entry) => {
    const normalized = entry.replaceAll("/", sep);
    return relativePath === normalized
      || relativePath.startsWith(`${normalized}${sep}`)
      || parts.includes(normalized);
  });
}

/**
 * Walk the site source the way the build walks it, invoking `onFile` for every
 * file the payload receives. Directories the payload never receives are not
 * descended into, so an excluded tree costs nothing to skip.
 */
export function walkPublicSitePayload(siteSource, onFile, { excluded, included } = readPublicSiteConfig(siteSource)) {
  const visit = (sourceDir, prefix = "") => {
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relativePath === "_config.yml" || isExcludedFromPublicSite(relativePath, excluded)) continue;
      if (entry.name.startsWith(".") || entry.name === ".git") continue;
      if (entry.name.startsWith("_") && !included.has(relativePath)) continue;

      const sourcePath = join(sourceDir, entry.name);
      if (entry.isDirectory()) visit(sourcePath, relativePath);
      else if (entry.isFile() || entry.isSymbolicLink()) onFile({ sourcePath, relativePath, entry });
    }
  };
  visit(siteSource);
}

export function publicSitePayloadFiles(siteSource) {
  const files = [];
  walkPublicSitePayload(siteSource, ({ sourcePath, relativePath }) => {
    files.push({ path: sourcePath, relativePath, bytes: statSync(sourcePath).size });
  });
  return files;
}
