// Follow-the-dollars only ever queried Checkbook NYC's "pin" field. A measured identifier
// audit found that field matches ~100% of modern (PASSPort-era, post-2013) PINs but only ~13%
// of pre-2013 PINs — because pre-2013 contracts were registered in Checkbook under its older
// "apt_pin" field instead. Before this fix, a pre-2013 award like PIN 82607Y0012 (a plausible
// pre-PASSPort-format PIN — nine digits + letter + four digits, no leading agency-code dash)
// rendered the "no registered contract... yet" message even when Checkbook actually had a
// registered contract for it, filed under apt_pin. checkbookByPin() now retries once against
// apt_pin before reporting a genuine non-match.
//
//   node --test test/checkbook_apt_pin_fallback.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
function extractConst(name) {
  // escXml's own value contains HTML-entity string literals ("&lt;", "&amp;", …) that each end
  // in a literal ";" — a semicolon-stops-the-match regex truncates there. Match to end-of-line
  // instead (same fix forecast_render.test.mjs uses for escUiHtml).
  const m = src.match(new RegExp(`^const ${name} = .*$`, "m"));
  assert.ok(m, `const ${name} not found`);
  return m[0];
}

// Minimal fake DOM, tailored to exactly what checkbookQueryByField() reads off the parsed
// Checkbook XML response (querySelector on the status/result, getElementsByTagName on
// transaction + its child tags) — mirrors the regex shape worker/src/checkbook.mjs's own
// parseCheckbookTransactions() uses server-side for the same XML.
function fakeElement(txXml) {
  return {
    getElementsByTagName(tag) {
      const m = txXml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? [{ textContent: m[1] }] : [];
    },
  };
}
class FakeDoc {
  constructor(xml) { this.xml = xml; }
  querySelector(sel) {
    if (sel !== "response > status > result") return null;
    const m = this.xml.match(/<status>[\s\S]*?<result>([^<]*)<\/result>/);
    return m ? { textContent: m[1] } : null;
  }
  getElementsByTagName(tag) {
    if (tag !== "transaction") return [];
    return [...this.xml.matchAll(/<transaction>([\s\S]*?)<\/transaction>/g)].map((m) => fakeElement(m[1]));
  }
}
class FakeDOMParser {
  parseFromString(str) { return new FakeDoc(str); }
}

const EMPTY_XML = `<response><status><result>success</result></status></response>`;
const successXmlWith = (id) => `<response><status><result>success</result></status>` +
  `<transaction><prime_contract_id>${id}</prime_contract_id><prime_vendor>Acme Snow and Ice LLC</prime_vendor>` +
  `<prime_contract_current_amount>250000</prime_contract_current_amount></transaction></response>`;

function fieldQueried(opts) {
  const { xml } = JSON.parse(opts.body);
  const m = xml.match(/<criteria><name>(pin|apt_pin)<\/name>/);
  return m ? m[1] : null;
}

function load({ API, workerFetch }) {
  return new Function(
    "API", "workerFetch", "DOMParser",
    extractConst("escXml") +
    extractFn("checkbookQueryByField") +
    extractFn("checkbookByPin") +
    "return { checkbookByPin };"
  )(API, workerFetch, FakeDOMParser);
}

test("before (legacy behavior, still true for a genuine non-match): empty pin-field result alone -> null rows", async () => {
  // Characterizes the pre-fix code path in isolation: querying only \"pin\" and finding
  // nothing is what used to be reported straight to the reader as \"no registered contract.\"
  const { checkbookByPin } = load({
    API: "https://api.crol-list.org",
    workerFetch: async () => ({ text: async () => EMPTY_XML }),
  });
  const rows = await checkbookByPin("82607Y0012");
  assert.deepEqual(rows, [], "empty array (not null) is the 'genuinely no match' signal followDollars() renders");
});

test("after: pin field empty, apt_pin field has the pre-2013 contract -> legacy match surfaces", async () => {
  const { checkbookByPin } = load({
    API: "https://api.crol-list.org",
    workerFetch: async (path, opts) => {
      const field = fieldQueried(opts);
      if (field === "pin") return { text: async () => EMPTY_XML };
      if (field === "apt_pin") return { text: async () => successXmlWith("C001-2012") };
      throw new Error("unexpected field: " + field);
    },
  });
  const rows = await checkbookByPin("82607Y0012");
  assert.equal(rows.length, 1, "the apt_pin retry finds the legacy-registered contract");
  assert.equal(rows[0].id, "C001-2012");
  assert.equal(rows[0].vendor, "Acme Snow and Ice LLC");
});

test("pin field already matches (modern PASSPort-era PIN) -> no apt_pin retry needed, same shape as before", async () => {
  let calls = 0;
  const { checkbookByPin } = load({
    API: "https://api.crol-list.org",
    workerFetch: async (path, opts) => {
      calls++;
      const field = fieldQueried(opts);
      if (field === "pin") return { text: async () => successXmlWith("C009-2026") };
      throw new Error("apt_pin should not be queried when pin already matched");
    },
  });
  const rows = await checkbookByPin("85719P0001");
  assert.equal(calls, 1, "no fallback request fired");
  assert.equal(rows[0].id, "C009-2026");
});

test("both pin and apt_pin come back empty -> genuine non-match, same 'no registered contract' state as before", async () => {
  const { checkbookByPin } = load({
    API: "https://api.crol-list.org",
    workerFetch: async () => ({ text: async () => EMPTY_XML }),
  });
  const rows = await checkbookByPin("82607Y0099");
  assert.deepEqual(rows, [], "still an empty array, not null — followDollars() shows the honest 'no match' note");
});

test("proxy/network failure on the primary query -> null (unknown state), no apt_pin retry attempted", async () => {
  let calls = 0;
  const { checkbookByPin } = load({
    API: "https://api.crol-list.org",
    workerFetch: async () => { calls++; throw new Error("network down"); },
  });
  await assert.rejects(() => checkbookByPin("82607Y0012"));
  assert.equal(calls, 1, "a hard failure on the primary query is not retried against apt_pin — followDollars() catches this and stays silent, same as before");
});
