import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";

const awareness = readFileSync(new URL("../site/location_awareness.js", import.meta.url), "utf8");
const map = readFileSync(new URL("../site/app/map.mjs", import.meta.url), "utf8");
const boardExactAddress = readFileSync(new URL("../site/board_exact_address.mjs", import.meta.url), "utf8");
const homeLocalEntry = readFileSync(new URL("../site/home_local_entry.mjs", import.meta.url), "utf8");
const core = readFileSync(new URL("../site/app/core.mjs", import.meta.url), "utf8");
const boot = readFileSync(new URL("../site/app/boot.mjs", import.meta.url), "utf8");
const land = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");
const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const siteRoot = resolve(new URL("../site", import.meta.url).pathname);

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    // Committed data and third-party vendor builds are not CityScroll gesture
    // gates. MapLibre ships an unused GeolocateControl that mentions
    // getCurrentPosition; Near You never mounts that control.
    if (name === "data" || name === "vendor") return [];
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
  // Directory exact-address location is asked only after the resident presses
  // the panel button; never on directory load or mount. Parameter defaults use
  // braces, so assert against the module source rather than brace-sliced body.
  assert.match(boardExactAddress, /locationBtn\.addEventListener\("click"/);
  assert.match(boardExactAddress, /geolocation\.getCurrentPosition/);
  assert.equal((boardExactAddress.match(/\bgetCurrentPosition\b/g) || []).length, 2);
  assert.ok(
    boardExactAddress.indexOf('locationBtn.addEventListener("click"')
      < boardExactAddress.indexOf("geolocation.getCurrentPosition"),
  );
  assert.doesNotMatch(
    boardExactAddress.slice(0, boardExactAddress.indexOf('locationBtn.addEventListener("click"')),
    /getCurrentPosition/,
  );
  // Homepage place entry asks only after Use my location is pressed.
  assert.match(homeLocalEntry, /locationBtn\.addEventListener\("click"/);
  assert.match(homeLocalEntry, /geolocation\.getCurrentPosition/);
  assert.equal((homeLocalEntry.match(/\bgetCurrentPosition\b/g) || []).length, 2);
  assert.ok(
    homeLocalEntry.indexOf('locationBtn.addEventListener("click"')
      < homeLocalEntry.indexOf("geolocation.getCurrentPosition"),
  );
  assert.doesNotMatch(
    homeLocalEntry.slice(0, homeLocalEntry.indexOf('locationBtn.addEventListener("click"')),
    /getCurrentPosition/,
  );
  assert.equal((awareness.match(/\brequestCurrentArea\(/g) || []).length, 2);
  assert.deepEqual(
    sourceFiles(siteRoot)
      .filter((path) => readFileSync(path, "utf8").includes("getCurrentPosition"))
      .map((path) => relative(siteRoot, path))
      .sort(),
    ["app/map.mjs", "board_exact_address.mjs", "home_local_entry.mjs", "location_awareness.js"],
  );
  assert.doesNotMatch(`${core}\n${boot}`, /maybeAutoLocateLand|resolveLandEntryLocation\(/);
  assert.doesNotMatch(`${core}\n${boot}\n${land}`, /navigator\.permissions\.query|permissions\.query/);
});

test("Zoning defaults to active and every zero-result scope renders a widen control", () => {
  assert.match(index, /id="lstatus"[^>]*><option value="all"/);
  assert.match(index, /id="lstage"[\s\S]*?value="active" selected/);
  assert.match(index, /id="lfuture"[\s\S]*?value="any" selected/);
  assert.match(land, /landEmptyStateHTML/);
  assert.match(land, /data-land-widen/);
  assert.match(land, /wireLandEmptyState/);
  assert.match(land, /resetLandFilters/);
});
