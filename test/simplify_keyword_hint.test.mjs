// A zero-result alert preview should help distinguish "quiet day" from "this filter can never
// match" — long, sentence-like search terms get a hint to simplify to one or two words.
//
//   node --test           (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");

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
function extractConst(name) {
  const m = src.match(new RegExp(`^const ${name} = [^;]*;`, "m"));
  assert.ok(m, `const ${name} not found`);
  return m[0];
}

const { isKeywordWatch, keywordLooksSentenceLike } = new Function(
  extractConst("SECTION_WATCH_LABEL") +
  extractFn("isKeywordWatch") +
  extractConst("AMOUNT_WORD_RE") +
  extractFn("keywordLooksSentenceLike") +
  "return { isKeywordWatch, keywordLooksSentenceLike };"
)();

test("keywordLooksSentenceLike: short keywords stay short", () => {
  assert.equal(keywordLooksSentenceLike("bridge repair"), false);
  assert.equal(keywordLooksSentenceLike("asbestos"), false);
  assert.equal(keywordLooksSentenceLike(""), false);
});

test("keywordLooksSentenceLike: more than three words is sentence-like", () => {
  assert.equal(keywordLooksSentenceLike("looking for a small construction contract"), true);
});

test("keywordLooksSentenceLike: digits or amount words flag even short phrases", () => {
  assert.equal(keywordLooksSentenceLike("under $50,000"), true);
  assert.equal(keywordLooksSentenceLike("five thousand dollars"), true);
  assert.equal(keywordLooksSentenceLike("contract 12345"), true);
});

test("isKeywordWatch: rfpkw and the section watches are free-text keyword search", () => {
  assert.equal(isKeywordWatch("rfpkw"), true);
  assert.equal(isKeywordWatch("property"), true);
  assert.equal(isKeywordWatch("rules"), true);
  assert.equal(isKeywordWatch("meetings"), true);
});

test("isKeywordWatch: entity/place watches use #aparam as a name, not a search phrase", () => {
  assert.equal(isKeywordWatch("entityvendor"), false);
  assert.equal(isKeywordWatch("entityagency"), false);
  assert.equal(isKeywordWatch("rezone"), false);
  assert.equal(isKeywordWatch("bigaward"), false);
});
