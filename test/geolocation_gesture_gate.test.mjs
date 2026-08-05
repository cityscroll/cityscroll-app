import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";

const awareness = readFileSync(new URL("../site/location_awareness.js", import.meta.url), "utf8");
const map = readFileSync(new URL("../site/app/map.mjs", import.meta.url), "utf8");
const core = readFileSync(new URL("../site/app/core.mjs", import.meta.url), "utf8");
const boot = readFileSync(new URL("../site/app/boot.mjs", import.meta.url), "utf8");
const land = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");
const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const siteRoot = resolve(new URL("../site", import.meta.url).pathname);

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    if (name === "data") return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:html|m?js)$/.test(name) ? [path] : [];
  });
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  for (let cursor = source.indexOf("{", start); cursor < source.length; cursor += 1) {
    if (source[cursor] === "{") depth += 1;
    if (source[cursor] === "}" && --depth === 0) return source.slice(start, cursor + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test("every geolocation request is downstream of an explicit click handler", () => {
  const request = extractFunction(awareness, "requestCurrentArea");
  const bind = extractFunction(awareness, "bindLocationControl");
  const mapGate = extractFunction(map, "wireGeolocation");

  assert.match(request, /geolocation\.getCurrentPosition/);
  assert.match(bind, /addEventListener\("click", async function/);
  assert.match(bind, /requestCurrentArea\(settings\)/);
  assert.match(mapGate, /addEventListener\("click", \(\) =>/);
  assert.match(mapGate, /navigator\.geolocation\.getCurrentPosition/);
  assert.equal((awareness.match(/\brequestCurrentArea\(/g) || []).length, 2);
  assert.deepEqual(
    sourceFiles(siteRoot)
      .filter((path) => readFileSync(path, "utf8").includes("getCurrentPosition"))
      .map((path) => relative(siteRoot, path))
      .sort(),
    ["app/map.mjs", "location_awareness.js"],
  );
  assert.doesNotMatch(`${core}\n${boot}`, /maybeAutoLocateLand|resolveLandEntryLocation\(/);
  assert.doesNotMatch(`${core}\n${boot}\n${land}`, /navigator\.permissions\.query|permissions\.query/);
});

test("Zoning defaults to all and every zero-result scope renders a widen control", () => {
  assert.match(index, /id="lstatus"[^>]*><option value="all"/);
  assert.match(index, /data-land-status="all" aria-pressed="true"/);
  assert.match(land, /landEmptyStateHTML/);
  assert.match(land, /data-land-widen/);
  assert.match(land, /wireLandEmptyState/);
  assert.match(land, /resetLandFilters/);
});
