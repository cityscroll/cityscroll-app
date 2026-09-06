import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { ROUTE_ISLAND_MODULES, SITE_MODULES } from "./helpers/site_source.mjs";
import { computeModuleGraphDigest } from "../tools/site_module_architecture.mjs";
import { bootChain } from "../tools/notice_cold_path.mjs";

const evidence = JSON.parse(
  readFileSync(new URL("../docs/evidence/index-module-split.json", import.meta.url), "utf8"),
);
const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const loader = readFileSync(new URL("../site/app/main.mjs", import.meta.url), "utf8");
const nearYou = readFileSync(new URL("../site/near-you/index.html", import.meta.url), "utf8");
const loaderModules = [...loader.matchAll(/import\("\.\/(.+?)"\)/g)].map(
  (match) => match[1],
);
const applicationModules = readdirSync(new URL("../site/app/", import.meta.url))
  .filter((name) => name.endsWith(".mjs") && name !== "main.mjs")
  .sort();

function moduleSource(name) {
  return readFileSync(new URL(`../site/app/${name}`, import.meta.url), "utf8");
}

function behaviorSource(name) {
  return moduleSource(name).split(
    "\n// Publish live bindings for neighboring modules and legacy inline handlers.",
  )[0].replaceAll('import("../', 'import("./');
}

test("index.html delegates application behavior to the ordered ES-module loader", () => {
  assert.match(index, /<script type="module" src="app\/main\.mjs"><\/script>/);
  assert.doesNotMatch(index, /<script>\s*const SODA/);
  // The route-gated lenses are registered in one block and awaited in place, so the
  // registry is compared as a set and the wire order is read out of the boot chain
  // the gate actually produces.
  assert.deepEqual([...loaderModules].sort(), [...SITE_MODULES].sort());
  const bootOrder = bootChain("other")
    .filter((path) => path.startsWith("/app/"))
    .map((path) => path.slice("/app/".length));
  assert.deepEqual(bootOrder, [
    "main.mjs",
    "core.mjs",
    "traversal.mjs",
    "contracts-rum.mjs",
    "money-list.mjs",
    "search-share.mjs",
    "exams.mjs",
    "staffing.mjs",
    "land.mjs",
    "feed-actions.mjs",
    "result-match.mjs",
    "procurement-lifecycle.mjs",
    "procurement-phase.mjs",
    "subsidy.mjs",
    "meetings.mjs",
    "entities.mjs",
    "entity_identity_report.mjs",
    "workspace.mjs",
    "now.mjs",
    "routing.mjs",
    "boot.mjs",
  ]);
});

test("every application module is registered exactly once in the import graph", () => {
  assert.equal(new Set(loaderModules).size, loaderModules.length, "duplicate loader imports");
  assert.equal(new Set(ROUTE_ISLAND_MODULES).size, ROUTE_ISLAND_MODULES.length, "duplicate route islands");
  assert.deepEqual([...loaderModules, ...ROUTE_ISLAND_MODULES].sort(), applicationModules);
  assert.doesNotMatch(loader, /map\.mjs/);
  assert.match(nearYou, /<script type="module" src="\/app\/map\.mjs"><\/script>/);
  assert.doesNotMatch(index, /<script[^>]+app\/map\.mjs/);
});

test("Property stays behind route activation while routing state remains eager", () => {
  assert.match(loader, /property:\s*\(\)\s*=>\s*import\("\.\/property\.mjs"\)/);
  assert.match(loader, /await ensureRouteModulesForHash\(location\.hash\)/);
  assert.match(loader, /await import\("\.\/routing\.mjs"\)/);
  assert.ok(
    loader.indexOf("await ensureRouteModulesForHash(location.hash)")
      < loader.indexOf('await import("./routing.mjs")'),
    "initial deep links must load their route module before eager routing runs",
  );
  assert.match(moduleSource("core.mjs"), /routeModules\.ensure\(name\)/);
  assert.match(
    moduleSource("boot.mjs"),
    /await globalThis\.CrolRouteModules\?\.ensureForHash\(targetHash\)/,
  );
});

test("Meetings stays off the Rules route activation path", () => {
  const routeMap = loader.slice(
    loader.indexOf("function routeModuleForHash"),
    loader.indexOf("const ROUTE_COMPANION_MODULES"),
  );
  assert.ok(routeMap.includes('tab==="rules"'));
  assert.ok(routeMap.includes('path==="/browse/rules/"'));
  // Rules resolves before every later branch, so a Rules route never activates the
  // Meetings lens even though Meetings is now gated in the same map.
  assert.ok(
    routeMap.indexOf('return "rules"') < routeMap.indexOf('tab==="meetings"'),
    "the rules branch must resolve before the meetings branch",
  );
  assert.equal(bootChain("other").includes("/app/rules.mjs"), false, "rules stays behind its gate");

  const meetingsSource = moduleSource("feed-actions.mjs");
  const listPaint = meetingsSource.indexOf('announce(t("meetings_entries_announce"');
  const deferredEdges = meetingsSource.indexOf("communityBoardEdgeToolsLoad().then");
  assert.ok(listPaint >= 0, "Meetings list paint marker is present");
  assert.ok(deferredEdges > listPaint, "community-board edge hydration remains after list paint");
});

test("every application module stays below the short-context working bar", () => {
  for (const name of [...SITE_MODULES, ...ROUTE_ISLAND_MODULES]) {
    const bytes = Buffer.byteLength(moduleSource(name));
    assert.ok(bytes < evidence.after.working_bar_bytes, `${name}: ${bytes} bytes`);
  }
});

test("module-graph digest is derived from the registered modules at check time", () => {
  const source = SITE_MODULES.map(behaviorSource).join("\n");
  const computed = computeModuleGraphDigest();
  assert.deepEqual(computed, {
    normalized_source_bytes: Buffer.byteLength(source),
    normalized_source_sha256: createHash("sha256").update(source).digest("hex"),
    module_count: SITE_MODULES.length,
  });
});

// Historical split evidence (before/after token measurements on representative tasks)
// remains in docs/evidence/index-module-split.json for the modular-split write-up.
// One-time migration assertions (hard-coded after_bytes + token_reduction >= 9.5)
// were retired: they re-proved the split forever and broke on every intentional module edit.
// Inspect the live fingerprint with: node tools/site_module_architecture.mjs --print
