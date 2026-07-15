// One query brain (w12-01): a real user typed "education contracts over 200k due in the
// next 3 months" into the Alerts quiz's "Narrow by keyword (optional)" field and pressed
// "Preview my digest →" — zero results, because the rfpkw watch type sent the whole
// sentence to SODA as one literal $q phrase, which doesn't substring-match any notice.
// Pasting the SAME text into the "Ask" box worked, because only the Ask box ran it through
// nlResolve()/parseNL() — three controls (quiz preview, Ask, Build-an-alert's own Preview
// button), three different interpretations of the same typed text.
//
// resolveMoneyNarrow() (index.html) is the one place both entry points that share the
// rfpkw watch type — the quiz's #quizgo and the Build-an-alert panel's own #apreview button
// — now resolve a non-literal query: promote it to the "moneynl" shape via NL.alerts.apply(),
// the SAME function the Ask box's apply step already calls, so preview and a saved alert are
// built from ONE interpreted filter. A literal single word or quoted phrase is left alone.
//
//   node --test test/quiz_narrow_resolve.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isLiteralKeyword, parseNL } from "../nl_parse.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "index.html"), "utf8");

function extractFn(name) {
  let start = src.indexOf("async function " + name + "(");
  if (start === -1) start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let depth = 0, seen = false;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") { depth++; seen = true; }
    else if (src[j] === "}" && --depth === 0 && seen) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// Fakes injected the same way forecast_render.test.mjs/apply_pnote.test.mjs inject t/tn/window
// — resolveMoneyNarrow only touches DOM through $(), plus nlResolve/NL/nlTransHTML as globals.
function makeResolver({ watch, aparam }) {
  const fields = {
    "#awatch": { value: watch },
    "#aparam": { value: aparam },
    "#quizgo": { disabled: false },
    "#apreview": { disabled: false },
    "#nltrans-alerts": { innerHTML: "" },
  };
  const $ = (sel) => fields[sel];
  const calls = { nlResolveArgs: null, applyArg: null };
  // Mirrors nlResolve()'s own device-fallback shape ({source:"device", ...parseNL(text)}) --
  // no worker/network in this test, same as the real fallback when the worker is absent.
  const nlResolve = async (text, lens) => {
    calls.nlResolveArgs = [text, lens];
    return { source: "device", ...parseNL(text) };
  };
  const NL = {
    alerts: {
      chips: (f) => [(f.keywords && f.keywords.length) ? `about ${f.keywords.join("/")}` : ""],
      apply: (f) => { calls.applyArg = f; },
    },
  };
  const nlTransHTML = (chips) => `<div role="status">${chips.join("")}</div>`;
  const resolveMoneyNarrow = new Function(
    "$", "nlResolve", "NL", "isLiteralKeyword", "nlTransHTML",
    extractFn("resolveMoneyNarrow") + "\nreturn resolveMoneyNarrow;"
  )($, nlResolve, NL, isLiteralKeyword, nlTransHTML);
  return { resolveMoneyNarrow, calls, fields };
}

test("before: quiznarrow's rfpkw watch sent the whole sentence to SODA as one literal $q string and matched nothing; after: it resolves through the SAME parseNL() the Ask box uses", async () => {
  const fixture = "education contracts over 200k due in the next 3 months";
  const { resolveMoneyNarrow, calls } = makeResolver({ watch: "rfpkw", aparam: fixture });
  const resolved = await resolveMoneyNarrow();
  assert.equal(resolved, true, "a non-literal rfpkw query must be promoted to the interpreted path");
  assert.deepEqual(calls.nlResolveArgs, [fixture, "alerts"], "routes through nlResolve(text,'alerts') — the SAME entry point the Ask box calls");
  assert.ok(calls.applyArg, "NL.alerts.apply() must receive the interpreted filter");
  assert.ok(calls.applyArg.keywords.includes("education"), `keywords: ${JSON.stringify(calls.applyArg.keywords)}`);
  assert.equal(calls.applyArg.minAmount, 200000, "amount>=200000 recognized");
  assert.equal(calls.applyArg.months, 3, "due<=90d (~3 months) recognized");
});

test("a literal single-word keyword is left alone — no worker round-trip, caller runs its own preview unchanged", async () => {
  const { resolveMoneyNarrow, calls } = makeResolver({ watch: "rfpkw", aparam: "asbestos" });
  const resolved = await resolveMoneyNarrow();
  assert.equal(resolved, false);
  assert.equal(calls.nlResolveArgs, null, "literal keywords never hit nlResolve/the worker");
  assert.equal(calls.applyArg, null);
});

test("a quoted phrase is also literal — left alone, unchanged", async () => {
  const { resolveMoneyNarrow, calls } = makeResolver({ watch: "rfpkw", aparam: '"community board"' });
  const resolved = await resolveMoneyNarrow();
  assert.equal(resolved, false);
  assert.equal(calls.nlResolveArgs, null);
});

test("non-rfpkw watches (meetings, bigaward, ...) are untouched even with multi-word text — only the money-shaped watch routes through NL", async () => {
  const { resolveMoneyNarrow, calls } = makeResolver({ watch: "meetings", aparam: "community board" });
  const resolved = await resolveMoneyNarrow();
  assert.equal(resolved, false);
  assert.equal(calls.nlResolveArgs, null);
});

test("empty #aparam is untouched (nothing to interpret)", async () => {
  const { resolveMoneyNarrow, calls } = makeResolver({ watch: "rfpkw", aparam: "  " });
  assert.equal(await resolveMoneyNarrow(), false);
  assert.equal(calls.nlResolveArgs, null);
});

test("isLiteralKeyword: single words and quoted phrases are literal; multi-word amount/time/topic phrasing is not", () => {
  assert.equal(isLiteralKeyword("asbestos"), true);
  assert.equal(isLiteralKeyword('"community board"'), true);
  assert.equal(isLiteralKeyword("'community board'"), true);
  assert.equal(isLiteralKeyword(""), true);
  assert.equal(isLiteralKeyword("   "), true);
  assert.equal(isLiteralKeyword("education contracts over 200k due in the next 3 months"), false);
  assert.equal(isLiteralKeyword("construction RFPs under $500k"), false);
});
