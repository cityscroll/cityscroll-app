import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") { depth += 1; opened = true; }
    if (source[i] === "}" && opened && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}

const pickerMarkup = index.match(/<select id="langSelect"[\s\S]*?<\/select>/)?.[0] || "";
const pickerCodes = [...pickerMarkup.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
const runtime = new Function(
  "window",
  "location",
  "history",
  `const SELECTABLE_LANGS=${JSON.stringify(pickerCodes)};\n` +
    functionSource("explicitUrlLanguage") + "\n" +
    functionSource("initialLanguage") + "\n" +
    functionSource("languageURL") + "\n" +
    functionSource("syncLanguageURL") + "\n" +
    "return { explicitUrlLanguage, initialLanguage, languageURL, syncLanguageURL };",
);

test("every language picker code is accepted as an explicit visit override", () => {
  const tools = runtime({}, {}, {});
  for (const code of pickerCodes) {
    assert.equal(tools.explicitUrlLanguage(`?lang=${encodeURIComponent(code)}`), code);
    assert.equal(tools.initialLanguage(`?lang=${encodeURIComponent(code)}`, "ru"), code);
  }
});

test("explicit language wins, then a saved preference, then English", () => {
  const tools = runtime({}, {}, {});
  assert.equal(tools.initialLanguage("?lang=es", "ru"), "es");
  assert.equal(tools.initialLanguage("", "ru"), "ru");
  assert.equal(tools.initialLanguage("", "bogus"), "en");
  for (const search of ["?lang=", "?lang=bogus", "?lang=ES", "?lang=%"]){
    assert.equal(tools.initialLanguage(search, "pl"), "pl");
  }
});

test("language URLs preserve other query state and put the parameter before the hash", () => {
  const tools = runtime({}, {}, {});
  assert.equal(
    tools.languageURL("https://cityscroll.org/?view=compact#notice/20260716022", "zh-Hans", "https://cityscroll.org/"),
    "https://cityscroll.org/?view=compact&lang=zh-Hans#notice/20260716022",
  );
  assert.equal(
    tools.languageURL("https://cityscroll.org/?view=compact&lang=es#alerts?notice=1", "en", "https://cityscroll.org/"),
    "https://cityscroll.org/?view=compact#alerts?notice=1",
  );
  assert.equal(
    tools.languageURL("https://a856-cityrecord.nyc.gov/RequestDetail/1", "es", "https://cityscroll.org/"),
    "https://a856-cityrecord.nyc.gov/RequestDetail/1",
  );
});

test("picker synchronization replaces the current address without adding history", () => {
  const calls = [];
  const location = { href: "https://cityscroll.org/?view=compact#notice/20260716022" };
  const history = {
    state: { route: "notice" },
    replaceState(...args) { calls.push(args); },
  };
  const tools = runtime({}, location, history);
  tools.syncLanguageURL("es");
  assert.deepEqual(calls, [[
    { route: "notice" },
    "",
    "/?view=compact&lang=es#notice/20260716022",
  ]]);
});
