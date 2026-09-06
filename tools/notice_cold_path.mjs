#!/usr/bin/env node
/**
 * Measure the browser module graph a route must fetch before the application
 * reports itself ready, and generate the preload manifest the edge-rendered
 * Notice document announces.
 *
 * The cold chain is read out of `site/app/main.mjs` rather than restated here:
 * the loader's own awaited sequence, its route-module gate, and its notice
 * branch decide which modules a route boots, so a change to the loader changes
 * this measurement without anyone editing the tool.
 *
 *   node tools/notice_cold_path.mjs                 # report every route
 *   node tools/notice_cold_path.mjs --json          # machine-readable report
 *   node tools/notice_cold_path.mjs --write         # refresh the preload manifest
 *   node tools/notice_cold_path.mjs --check         # fail when the manifest or budget drifts
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, posix, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_ROOT = join(ROOT, "site");
const MAIN_URL_PATH = "/app/main.mjs";
const MANIFEST_PATH = join(SITE_ROOT, "notice_module_preload.mjs");
const BUDGET_PATH = join(ROOT, "architecture", "notice-cold-path-budget.json");

const STATIC_IMPORT_RE = /^\s*(?:import|export)\s+(?:(?:[\w$*\s{},]+?)\s+from\s+)?["']([^"']+)["']/gm;

function isExternalSpecifier(specifier) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(specifier);
}

/** Resolve one import specifier to the URL path the browser would request. */
export function resolveModuleUrl(importerUrlPath, specifier) {
  if (!specifier || isExternalSpecifier(specifier)) return null;
  const path = specifier.split(/[?#]/, 1)[0];
  if (!path) return null;
  const base = path.startsWith("/") ? path : posix.join(posix.dirname(importerUrlPath), path);
  return posix.normalize(base.startsWith("/") ? base : `/${base}`);
}

function sourcePathFor(urlPath) {
  const candidate = resolve(SITE_ROOT, `.${urlPath}`);
  if (candidate !== SITE_ROOT && !candidate.startsWith(`${SITE_ROOT}/`)) return null;
  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
}

function readModule(urlPath) {
  const source = sourcePathFor(urlPath);
  return source ? readFileSync(source, "utf8") : null;
}

/** The modules one module statically imports, as URL paths. */
export function staticImports(urlPath) {
  const source = readModule(urlPath);
  if (source === null) return [];
  const out = [];
  for (const match of source.matchAll(STATIC_IMPORT_RE)) {
    const resolved = resolveModuleUrl(urlPath, match[1]);
    if (resolved && sourcePathFor(resolved)) out.push(resolved);
  }
  return [...new Set(out)];
}

function moduleBytes(urlPath) {
  const source = sourcePathFor(urlPath);
  return source ? statSync(source).size : 0;
}

/**
 * Read the loader's awaited boot sequence for one route.
 *
 * `route` is "notice" or "other": the loader gates the five lens groups on the
 * Notice route only, so the same source yields two different chains.
 */
export function bootChain(route) {
  const source = readModule(MAIN_URL_PATH);
  if (source === null) throw new Error(`missing ${MAIN_URL_PATH}`);
  const loaders = new Map();
  const loaderBlock = source.match(/const routeModuleLoaders\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/);
  if (!loaderBlock) throw new Error("routeModuleLoaders literal not found in main.mjs");
  for (const entry of loaderBlock[1].matchAll(/(\w+)\s*:\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']\s*\)/g)) {
    loaders.set(entry[1], resolveModuleUrl(MAIN_URL_PATH, entry[2]));
  }

  const body = source.slice(source.indexOf("async function loadApplication()"));
  const chain = [MAIN_URL_PATH];
  const push = (urlPath) => { if (urlPath && !chain.includes(urlPath)) chain.push(urlPath); };
  // The shell-wide enhancement runs before the loader branches on the route.
  push(resolveModuleUrl(MAIN_URL_PATH, "../home_default_watch.mjs"));

  const STATEMENT_RE = new RegExp([
    /await import\(\s*(?:"([^"]+)"|'([^']+)'|NOTICE_CONTEXT_MODULE_PATH)\s*\)/,
    /|await ensureLensModule\(\s*"(\w+)"\s*\)/,
    /|await ensureRouteModulesForHash\(/,
    /|await globalThis\.ensureNoticeContext\(\)/,
  ].map((part) => part.source).join(""), "g");

  for (const match of body.matchAll(STATEMENT_RE)) {
    const [text, doubleQuoted, singleQuoted, lensName] = match;
    if (doubleQuoted || singleQuoted) {
      push(resolveModuleUrl(MAIN_URL_PATH, doubleQuoted || singleQuoted));
      continue;
    }
    if (text.includes("NOTICE_CONTEXT_MODULE_PATH") || text.includes("ensureNoticeContext")) {
      // The notice-context island is started early and awaited in the notice branch.
      if (route === "notice") push(resolveModuleUrl(MAIN_URL_PATH, "./notice-context.mjs"));
      continue;
    }
    if (lensName) {
      if (route !== "notice") push(loaders.get(lensName));
      continue;
    }
    // ensureRouteModulesForHash(): the Notice route resolves to the property gate,
    // which chains the rules gate ahead of itself.
    if (route === "notice") { push(loaders.get("rules")); push(loaders.get("property")); }
  }
  // The notice branch's terminal import only runs on a Notice route.
  if (route !== "notice") {
    const index = chain.indexOf(resolveModuleUrl(MAIN_URL_PATH, "./authority-award.mjs"));
    if (index >= 0) chain.splice(index, 1);
  }
  return chain;
}

/**
 * Walk one boot chain into the complete module graph the browser fetches, the
 * bytes it transfers, and the depth of the request waterfall.
 *
 * A stage costs one request round trip plus the depth of whatever new modules
 * its own static imports reveal — that nesting is what a preload hint removes.
 */
export function measureChain(chain) {
  const discovered = new Set();
  const ordered = [];
  let serialRequestStages = 0;
  for (const entry of chain) {
    if (!sourcePathFor(entry)) continue;
    let frontier = discovered.has(entry) ? [] : [entry];
    let depth = 0;
    while (frontier.length) {
      depth += 1;
      const next = [];
      for (const urlPath of frontier) {
        if (discovered.has(urlPath)) continue;
        discovered.add(urlPath);
        ordered.push(urlPath);
        for (const dependency of staticImports(urlPath)) {
          if (!discovered.has(dependency)) next.push(dependency);
        }
      }
      frontier = [...new Set(next)];
    }
    serialRequestStages += depth;
  }
  return {
    modules: ordered,
    moduleCount: ordered.length,
    bytes: ordered.reduce((total, urlPath) => total + moduleBytes(urlPath), 0),
    awaitedStages: chain.filter((entry) => sourcePathFor(entry)).length,
    serialRequestStages,
  };
}

/** The Notice route's cold boot: chain, graph, bytes, waterfall depth. */
export function measureNoticeColdPath() {
  return measureChain(bootChain("notice"));
}

/** The same measurement for every other route, where no lens group is gated. */
export function measureLensRouteColdPath() {
  return measureChain(bootChain("other"));
}

/** The Home route paints from its own entry, not the application loader. */
export function measureHomeColdPath() {
  return measureChain([MAIN_URL_PATH, "/home_default_watch.mjs", "/home_entry.mjs"]);
}

const MANIFEST_HEADER = `// Generated by tools/notice_cold_path.mjs — do not edit by hand.
//
// Every module a cold Notice boot fetches before the application reports itself
// ready, apart from the entry module the document already requests. The
// edge-rendered Notice document announces these so the browser can request them
// in parallel instead of discovering them one import at a time.
// Run \`node tools/notice_cold_path.mjs --write\` after changing the loader or any
// module on the chain; \`--check\` fails when this file no longer matches.
`;

export function renderManifest(modules) {
  // The document already requests the entry module through its own script tag.
  const hinted = modules.filter((urlPath) => urlPath !== MAIN_URL_PATH);
  const body = hinted.map((urlPath) => `  ${JSON.stringify(urlPath)},`).join("\n");
  return `${MANIFEST_HEADER}\nexport const NOTICE_MODULE_PRELOADS = Object.freeze([\n${body}\n]);\n`;
}

function readBudget() {
  return JSON.parse(readFileSync(BUDGET_PATH, "utf8"));
}

function formatReport(label, measurement) {
  return `${label}: ${measurement.moduleCount} modules, ${measurement.bytes} bytes, `
    + `${measurement.awaitedStages} awaited stages, ${measurement.serialRequestStages} serial request stages`;
}

export function main(argv = process.argv.slice(2)) {
  const notice = measureNoticeColdPath();
  if (argv.includes("--write")) {
    writeFileSync(MANIFEST_PATH, renderManifest(notice.modules));
    process.stdout.write(`wrote ${notice.modules.length - 1} preload entries to site/notice_module_preload.mjs\n`);
    return 0;
  }
  if (argv.includes("--check")) {
    const failures = [];
    const expected = renderManifest(notice.modules);
    const actual = existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, "utf8") : "";
    if (actual !== expected) {
      failures.push("site/notice_module_preload.mjs is stale — run node tools/notice_cold_path.mjs --write");
    }
    const budget = readBudget();
    if (notice.moduleCount > budget.maxModules) {
      failures.push(`Notice cold path loads ${notice.moduleCount} modules, ceiling is ${budget.maxModules}`);
    }
    if (notice.bytes > budget.maxBytes) {
      failures.push(`Notice cold path transfers ${notice.bytes} bytes, ceiling is ${budget.maxBytes}`);
    }
    if (notice.serialRequestStages > budget.maxSerialRequestStages) {
      failures.push(`Notice cold path has ${notice.serialRequestStages} serial request stages, ceiling is ${budget.maxSerialRequestStages}`);
    }
    for (const failure of failures) process.stderr.write(`notice-cold-path: ${failure}\n`);
    if (!failures.length) process.stdout.write(`notice-cold-path: ${formatReport("notice", notice)}\n`);
    return failures.length ? 1 : 0;
  }
  const report = {
    notice,
    lensRoute: measureLensRouteColdPath(),
    home: measureHomeColdPath(),
  };
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${formatReport("notice", report.notice)}\n`);
  process.stdout.write(`${formatReport("lens route (money/land/exams/staffing/meetings ungated)", report.lensRoute)}\n`);
  process.stdout.write(`${formatReport("home", report.home)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
