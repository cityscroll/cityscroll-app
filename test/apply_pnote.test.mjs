// The how-to-respond explainer note must describe the buttons actually rendered above it:
// no "Email a response" callout when a solicitation lists no contact email.
//
//   node --test           (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
const i18nSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "i18n.js"), "utf8");

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

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t, tn } = new Function("window", i18nSrc + "\nreturn { t: window.t, tn: window.tn };")(windowStub);

const { buildApply } = new Function(
  "t", "tn", "window",
  extractConst("PASSPORT") +
  extractFn("cleanText") +
  extractFn("fdt") +
  extractFn("daysLeft") +
  extractFn("telHref") +
  extractFn("mailtoFor") +
  extractFn("buildApply") +
  "return { buildApply };"
)(t, tn, windowStub);

const base = {
  request_id: "20260101001",
  pin: "80126P0001",
  short_title: "Snow removal services",
  agency_name: "Sanitation",
  type_of_notice_description: "Solicitation",
  due_date: new Date(Date.now() + 10 * 86400000).toISOString(),
};

test("no contact email: explainer skips the Email-a-response callout and leads with PASSPort", () => {
  const html = buildApply({ ...base, email: null, contact_phone: null });
  assert.doesNotMatch(html, /Email a response/, "no button for a button that isn't there");
  assert.match(html, /no direct contact/i);
  assert.match(html, /PASSPort/);
});

test("no contact email: no mailto action is rendered either", () => {
  const html = buildApply({ ...base, email: null, contact_phone: null });
  assert.doesNotMatch(html, /mailto:/);
});

test("email present: explainer renders the existing Email-a-response copy unchanged", () => {
  const html = buildApply({ ...base, email: "procurement@example.gov", contact_phone: null });
  assert.match(html, /Email a response/);
  assert.match(html, /mailto:procurement@example\.gov/);
  assert.doesNotMatch(html, /no direct contact/i);
});

test("phone but no email: still no Email-a-response button, still the no-contact-email note", () => {
  const html = buildApply({ ...base, email: null, contact_phone: "212-555-0100" });
  assert.doesNotMatch(html, /Email a response/);
  assert.match(html, /no direct contact/i);
  assert.match(html, /tel:/);
});
