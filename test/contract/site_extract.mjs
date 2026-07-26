// Shared helper for contract tests: pulls named functions/consts straight out of index.html's
// inline <script> so they can run in Node next to the worker's real modules, with no build step.
// Generalized from the brace-matching extractor test/match_evidence.test.mjs wrote first.
//
// This file is the one thing every contract test imports — the site half of "one fixture set,
// both implementations run against it" (see docs/drift-inventory.md). It does not itself
// duplicate any site logic; it just slices index.html's source text.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf8");

// Extracts one function declaration's full source, brace-balanced, starting from wherever
// `function name(` or `async function name(` first appears.
export function extractFn(name, src = INDEX_HTML) {
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

// Extracts one `const NAME = ...;` top-level statement's source, up to the terminating
// semicolon at depth 0 (bracket/brace/paren-aware, so a const object/array literal is safe).
export function extractConst(name, src = INDEX_HTML) {
  const start = src.indexOf("const " + name + " ");
  const start2 = src.indexOf("const " + name + "=");
  const from = start !== -1 ? start : start2;
  assert.notEqual(from, -1, `const ${name} not found in index.html`);
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === ";" && depth === 0) return src.slice(from, j + 1);
  }
  throw new Error(`unterminated const ${name}`);
}

// Builds a sandbox function body out of any number of extracted fn/const source chunks, then
// evaluates it and returns the named bindings — same `new Function(...)` approach already used
// by test/match_evidence.test.mjs, centralized so every contract test shares one code path.
export function loadSite(names, { extra = "", args = [], values = [] } = {}) {
  const body = names.map((n) => (/^[A-Z_][A-Z0-9_]*$/.test(n) ? extractConst(n) : extractFn(n))).join("\n");
  const fn = new Function(...args, extra + body + `\nreturn {${names.join(",")}};`);
  return fn(...values);
}
