// Digest deep-links (w12-12): before this, a digest email's notice link carried nothing about
// the watch that surfaced the item -- following it from an inbox landed on the plain notice
// view, with no sign of why the item matched or what was searched for. This pins the client
// half of the fix: parseWatchParam() reconstructs a watch's {lens, filter} from a link's own
// "?w=" fragment (worker/src/lib/filter.mjs's encodeWatchFilter() is what builds that value —
// see worker/test/filter.test.mjs and worker/test/digest_match_evidence_render.test.mjs for the
// send-side half of the same fix), and matchEvidence()/digEvidenceHTML()/watchChipsFor() render
// the same Matched-evidence + interpretation echo showNotice() now shows on arrival.
//
// The anchor fixture is the card's own real example -- the "education" watch surfacing a
// Comptroller pension-fund notice whose title never says "education" -- reused verbatim from
// worker/test/digest_match_evidence_render.test.mjs's comptrollerRow so both halves of the fix
// are proven against the identical real-world case.
//
//   node --test test/deeplink_watch.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sanitize as workerSanitize, LENSES as WORKER_LENSES } from "../worker/src/lib/filter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "index.html"), "utf8");
const i18nSrc = readFileSync(join(ROOT, "i18n.js"), "utf8");

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
function extractDecl(name) {
  const m = src.match(new RegExp(`(?:^|\\n)const ${name}\\s*=`));
  assert.ok(m, `const ${name} not found`);
  const start = m.index + m[0].indexOf("const");
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === ";" && depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unterminated const ${name}`);
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t, tSection } = new Function(
  "window",
  i18nSrc + "\nreturn { t: window.t, tSection: window.tSection };",
)(windowStub);

const {
  DEEPLINK_LENSES, sanitizeDeepLinkFilter, parseWatchParam, watchChipsFor, parseNoticeHashSegment,
  matchEvidence, digTitleHTML, digEvidenceHTML, matchText, enTitle,
} = new Function(
  "t", "tSection", "window",
  extractFn("cleanText") +
  extractFn("enTitle") +
  extractFn("money") +
  extractDecl("SECTIONS") +
  extractDecl("LENS_IMPLIED_WORDS") +
  extractFn("stripImpliedKeywords") +
  extractFn("nlFeed") +
  extractDecl("NL") +
  extractFn("locateAnyTerm") +
  extractFn("matchEvidence") +
  extractFn("matchText") +
  extractFn("digTitleHTML") +
  extractFn("digEvidenceHTML") +
  extractDecl("DEEPLINK_LENSES") +
  extractDecl("DEEPLINK_CATEGORIES") +
  extractDecl("DEEPLINK_BOROS") +
  extractFn("deeplinkClampField") +
  extractFn("sanitizeDeepLinkFilter") +
  extractFn("parseWatchParam") +
  extractFn("watchChipsFor") +
  extractFn("parseNoticeHashSegment") +
  "return { DEEPLINK_LENSES, sanitizeDeepLinkFilter, parseWatchParam, watchChipsFor, parseNoticeHashSegment, matchEvidence, digTitleHTML, digEvidenceHTML, matchText, enTitle };",
)(t, tSection, windowStub);

// ---- dual-implementation cross-check (same convention as external_awards_registry.test.mjs) --

test("DEEPLINK_LENSES (client) matches worker's LENSES field-for-field", () => {
  assert.deepEqual(DEEPLINK_LENSES, WORKER_LENSES);
});

test("sanitizeDeepLinkFilter (client) and sanitize() (worker) clamp identically for representative inputs", () => {
  const cases = [
    ["money", { keywords: ["Education", "", "x"], agency: "  DOE  ", minAmount: 200000, noticeType: "bogus" }],
    ["property", { keywords: ["hpd sale"], agency: null, extraneous: "drop me" }],
    ["entity", { name: "  Acme Corp  ", kind: "vendor" }],
    ["land", { boro: "brooklyn", status: "all" }],
    ["bogus-lens", { keywords: ["x"] }],
  ];
  for (const [lens, input] of cases) {
    assert.deepEqual(sanitizeDeepLinkFilter(lens, input), workerSanitize(lens, input), `lens=${lens}`);
  }
});

// ---- anchor fixture: the education watch (real Comptroller row) ------------------------------
// Same fixture as worker/test/digest_match_evidence_render.test.mjs's comptrollerRow.

const comptrollerRow = {
  request_id: "20260701099",
  agency_name: "Office of the Comptroller",
  short_title: "NOS - Equity Index Investment Management Products",
  additional_description_1:
    "The New York City Office of the Comptroller, Bureau of Asset Management, is soliciting " +
    "proposals on behalf of the Boards of Trustees of the New York City Employees' Retirement " +
    "System, Teachers' Retirement System, and the Board of Education Retirement System for " +
    "equity index investment management products.",
  other_info_1: "",
};

test("before: the education watch's notice link carried no filter -- a click landed on the plain notice view with no evidence", () => {
  // showNotice(id) with no second argument (the pre-fix call shape) computed no match evidence
  // at all -- there was no `watch` to derive terms from.
  const ev = null;
  assert.equal(digEvidenceHTML(ev), "", "no evidence chrome without a carried watch");
});

test("after: the education watch's ?w= param round-trips to the exact filter encodeWatchFilter() built for it", () => {
  const raw = JSON.stringify({ lens: "money", filter: { keywords: ["education"] } });
  const watch = parseWatchParam(raw);
  assert.deepEqual(watch, { lens: "money", filter: sanitizeDeepLinkFilter("money", { keywords: ["education"] }) });
  assert.deepEqual(watch.filter.keywords, ["education"]);
});

test("after: the reconstructed watch highlights the school-text evidence buried in the description, not the title", () => {
  const watch = parseWatchParam(JSON.stringify({ lens: "money", filter: { keywords: ["education"] } }));
  const title = comptrollerRow.short_title;
  const ev = matchEvidence(title, matchText(comptrollerRow), watch.filter.keywords);
  assert.equal(ev.field, "description");
  assert.match(digEvidenceHTML(ev), /<mark>[Ee]ducation<\/mark>/);
  assert.match(digEvidenceHTML(ev), /Board of <mark>[Ee]ducation<\/mark> Retirement System/, "the snippet shows real context, not just the bare word");
  assert.equal(digTitleHTML(title, ev), enTitle(title), "the title itself is untouched -- the hit isn't there");
});

test("after: the education watch's interpretation echoes as a real chip, same wording NL.alerts.chips() would show", () => {
  const watch = parseWatchParam(JSON.stringify({ lens: "money", filter: { keywords: ["education"] } }));
  const chips = watchChipsFor(watch.lens, watch.filter);
  assert.equal(chips.length, 1);
  assert.match(chips[0], /about <b>education<\/b>/);
});

// ---- variant fixtures (acceptance-criteria boundaries) ---------------------------------------

test("multi-filter watch: every field survives the round trip and echoes as its own chip", () => {
  const raw = JSON.stringify({
    lens: "money",
    filter: { keywords: ["education"], agency: "Office of the Comptroller", minAmount: 100000, months: 6, noticeType: "solicitation" },
  });
  const watch = parseWatchParam(raw);
  assert.deepEqual(watch.filter.keywords, ["education"]);
  assert.equal(watch.filter.agency, "Office of the Comptroller");
  assert.equal(watch.filter.minAmount, 100000);
  assert.equal(watch.filter.months, 6);
  const chips = watchChipsFor("money", watch.filter).join(" ");
  assert.match(chips, /open RFPs/);
  assert.match(chips, /agency <b>Office of the Comptroller<\/b>/);
  assert.match(chips, /about <b>education<\/b>/);
  assert.match(chips, /amount ≥ <b>\$100K<\/b>/);
  assert.match(chips, /due within <b>6 mo<\/b>/);
});

test("keyword-only watch: no other field is invented -- the filter carries exactly what was sent", () => {
  const watch = parseWatchParam(JSON.stringify({ lens: "property", filter: { keywords: ["environmental"] } }));
  assert.deepEqual(watch.filter, sanitizeDeepLinkFilter("property", { keywords: ["environmental"] }));
  assert.equal(watch.filter.agency, null);
});

test("malformed/truncated fragment fails soft to null -- the caller then renders the plain notice view, never a broken page", () => {
  assert.equal(parseWatchParam(null), null, "no ?w= at all");
  assert.equal(parseWatchParam(""), null, "empty string");
  assert.equal(parseWatchParam("{\"lens\":\"money\",\"filter\":{\"keywords\":[\"edu"), null, "truncated mid-JSON, unparseable");
  assert.equal(parseWatchParam("not json at all"), null, "not JSON");
  assert.equal(parseWatchParam("[]"), null, "a JSON array, not an object");
  assert.equal(parseWatchParam("null"), null, "JSON null");
  assert.equal(parseWatchParam(JSON.stringify({ filter: { keywords: ["x"] } })), null, "no lens named at all");
  assert.equal(parseWatchParam(JSON.stringify({ lens: "not-a-real-lens", filter: {} })), null, "unrecognized lens");
  assert.equal(parseWatchParam("x".repeat(2001)), null, "oversized -- length cap");
});

test("fragment with unexpected extra keys: known fields survive, unknown ones are silently dropped, not an error", () => {
  const raw = JSON.stringify({
    lens: "money",
    filter: { keywords: ["education"], __proto__: { polluted: true }, injectedSql: "'; DROP TABLE notices; --", randomField: 42 },
    unrelatedTopLevelKey: "should be ignored",
  });
  const watch = parseWatchParam(raw);
  assert.deepEqual(Object.keys(watch.filter).sort(), Object.keys(sanitizeDeepLinkFilter("money", {})).sort());
  assert.deepEqual(watch.filter.keywords, ["education"]);
  assert.equal(watch.filter.injectedSql, undefined);
  assert.equal(watch.filter.randomField, undefined);
});

test("an amount-only watch (no keywords) still carries real signal and gets no evidence chrome (nothing hidden to explain)", () => {
  const watch = parseWatchParam(JSON.stringify({ lens: "money", filter: { minAmount: 1000000 } }));
  const ev = matchEvidence(comptrollerRow.short_title, matchText(comptrollerRow), watch.filter.keywords || []);
  assert.equal(ev, null);
  assert.equal(digEvidenceHTML(ev), "");
  const chips = watchChipsFor("money", watch.filter).join(" ");
  assert.match(chips, /amount ≥ <b>\$1\.00M<\/b>/);
});

test("an entity watch renders no chips or evidence -- the agency/vendor name is already shown plainly on the notice, nothing hidden", () => {
  const watch = parseWatchParam(JSON.stringify({ lens: "entity", filter: { kind: "vendor", name: "Acme Corp" } }));
  assert.deepEqual(watchChipsFor(watch.lens, watch.filter), []);
});

// ---- applyHash()'s "#notice/<id>?w=<...>" routing (parseNoticeHashSegment) --------------------

test("before: a bare '#notice/<id>' with no ?w= at all -- the pre-w12-12 shape -- still routes with watch:null, unchanged", () => {
  assert.deepEqual(parseNoticeHashSegment("20260701099"), { id: "20260701099", watch: null });
});

test("after: '#notice/<id>?w=<encoded>' splits the id from the watch and reconstructs it", () => {
  const w = encodeURIComponent(JSON.stringify({ lens: "money", filter: { keywords: ["education"] } }));
  const { id, watch } = parseNoticeHashSegment(`20260701099?w=${w}`);
  assert.equal(id, "20260701099");
  assert.deepEqual(watch, { lens: "money", filter: sanitizeDeepLinkFilter("money", { keywords: ["education"] }) });
});

test("a malformed ?w= still yields the correct id and a null watch -- never a broken page", () => {
  const { id, watch } = parseNoticeHashSegment("20260701099?w=not-json-and-not-even-percent-encoded-properly%");
  assert.equal(id, "20260701099");
  assert.equal(watch, null);
});

test("a '?' with no w= param at all (some other query the link author added) also yields watch:null", () => {
  assert.deepEqual(parseNoticeHashSegment("20260701099?utm_source=email"), { id: "20260701099", watch: null });
});
