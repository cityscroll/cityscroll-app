import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep, posix } from "node:path";

const MODULE_SCRIPT_RE = /<script\b(?=[^>]*\btype\s*=\s*["']module["'])(?=[^>]*\bsrc\s*=\s*["']([^"']+)["'])[^>]*>/gi;
const BASE_HREF_RE = /<base\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i;
const STATIC_IMPORT_RE = /^\s*(?:import|export)\s+(?:(?:[\w$*\s{},]+?)\s+from\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function walkFiles(root, extension) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && (!extension || entry.name.endsWith(extension))) files.push(path);
    }
  }
  visit(root);
  return files;
}

function isExternalSpecifier(specifier) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(specifier);
}

function stripUrlSuffix(value) {
  return value.split(/[?#]/, 1)[0];
}

function urlPathFromSpecifier(importerUrlPath, specifier, baseUrlPath = null) {
  if (!specifier || isExternalSpecifier(specifier)) return null;
  const path = stripUrlSuffix(specifier);
  if (!path) return null;
  const base = path.startsWith("/")
    ? path
    : posix.join(baseUrlPath || posix.dirname(importerUrlPath), path);
  const normalized = posix.normalize(base.startsWith("/") ? base : `/${base}`);
  return normalized === "/" ? normalized : normalized.replace(/\/$/, "");
}

export function moduleScriptUrls(html, htmlUrlPath) {
  const baseHref = html.match(BASE_HREF_RE)?.[1] || null;
  const baseUrlPath = baseHref && !isExternalSpecifier(baseHref)
    ? urlPathFromSpecifier(htmlUrlPath, baseHref)
    : null;
  return [...html.matchAll(MODULE_SCRIPT_RE)]
    .map((match) => urlPathFromSpecifier(htmlUrlPath, match[1], baseUrlPath))
    .filter(Boolean);
}

export function moduleImportUrls(source, importerUrlPath) {
  const imports = [];
  for (const match of source.matchAll(STATIC_IMPORT_RE)) imports.push(match[1]);
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) imports.push(match[1]);
  return [...new Set(imports
    .map((specifier) => urlPathFromSpecifier(importerUrlPath, specifier))
    .filter(Boolean))];
}

function urlPathForFile(file, root) {
  return `/${relative(root, file).split(sep).join("/")}`;
}

function sourcePathForUrl(urlPath, roots) {
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    const candidate = resolve(resolvedRoot, `.${urlPath}`);
    if (candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}${sep}`)) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

/**
 * Find the modules reachable from every module script in the HTML artifact.
 * sourceRoots lets the build inspect site/ plus repository-level shared modules.
 */
export function discoverClientModuleGraph({ rootDir, sourceRoots = [rootDir] }) {
  const htmlFiles = walkFiles(rootDir, ".html");
  const roots = [];
  for (const file of htmlFiles) {
    const htmlUrlPath = urlPathForFile(file, rootDir);
    const html = readFileSync(file, "utf8");
    roots.push(...moduleScriptUrls(html, htmlUrlPath));
  }

  const modules = new Map();
  const missing = new Set();
  const queue = [...new Set(roots)];
  while (queue.length) {
    const urlPath = queue.shift();
    if (modules.has(urlPath) || missing.has(urlPath)) continue;
    const sourcePath = sourcePathForUrl(urlPath, sourceRoots);
    if (!sourcePath) {
      missing.add(urlPath);
      continue;
    }
    const source = readFileSync(sourcePath, "utf8");
    modules.set(urlPath, { sourcePath, source });
    queue.push(...moduleImportUrls(source, urlPath));
  }

  return {
    htmlFiles,
    roots: [...new Set(roots)],
    modules,
    missing: [...missing].sort(),
  };
}

export function repositoryRelativePath(file, repositoryRoot) {
  const resolvedFile = resolve(file);
  const resolvedRoot = resolve(repositoryRoot);
  if (resolvedFile === resolvedRoot || !resolvedFile.startsWith(`${resolvedRoot}${sep}`)) return null;
  return relative(resolvedRoot, resolvedFile).split(sep).join("/");
}
