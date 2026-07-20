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

const { buildApply, mailtoFor, icsForRFP } = new Function(
  "t", "tn", "window",
  extractConst("PASSPORT") +
  extractConst("REQ_URL") +
  extractConst("EXT_ATTRS") +
  extractConst("extSR") +
  extractFn("cleanText") +
  extractFn("fdt") +
  extractFn("daysLeft") +
  extractFn("telHref") +
  src.match(/const JUNK_PINS = new Set\(\[[^\]]*\]\);/)[0] +
  extractConst("JUNK_PIN_TEXT_RE") +
  extractFn("usablePin") +
  extractFn("mailtoFor") +
  extractFn("icsForRFP") +
  extractFn("buildApply") +
  "return { buildApply, mailtoFor, icsForRFP };"
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

// mailtoFor()/icsForRFP() checked bare `r.pin` truthiness, not usablePin() -- a
// junk PIN like "TBD" or "See below" (truthy strings) leaked straight into the letter-of-intent
// subject/body and the .ics DESCRIPTION unchanged. usablePin() is the single gate the rest of
// the app already uses for this notice's PIN; these two must use it too.
test("mailtoFor: a junk PIN never appears in the subject or body", () => {
  const junky = { ...base, email: "procurement@example.gov", pin: "See below" };
  const href = mailtoFor(junky);
  const decoded = decodeURIComponent(href);
  assert.doesNotMatch(decoded, /See below/);
  assert.match(decoded, /\(see notice\)/, "falls back to the same placeholder used for a missing PIN");
});
test("mailtoFor: a usable PIN still appears as before", () => {
  const href = mailtoFor({ ...base, email: "procurement@example.gov" });
  const decoded = decodeURIComponent(href);
  assert.match(decoded, new RegExp(`PIN ${base.pin}`));
  assert.match(decoded, new RegExp(`\\(PIN ${base.pin}\\)`));
});
test("icsForRFP: a junk PIN never appears in the calendar DESCRIPTION", () => {
  const junky = { ...base, pin: "N/A" };
  const ics = icsForRFP(junky);
  assert.doesNotMatch(ics, /PIN N\/A/);
  assert.match(ics, /PIN —/, "falls back to the same em-dash used for a missing PIN");
});
