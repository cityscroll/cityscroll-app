// Awards published outside the City Record. The registry (external_awards.js) drives the sweep,
// the join precision, and the coverage claim; the award DATA is precomputed server-side and served
// by GET /externalaward, so the client no longer fires a live SODA/Checkbook call per view. These
// tests pin the class boundaries from the client's side: an exact-key agency (NYCHA) renders a
// confident award box, a fuzzy-source agency renders a "possible" timeline, a verified-absent
// agency states the absence plainly, and a covered agency whose source turned up nothing says the
// site checked that source and found none. Before this feature external awards were absent; an
// unguarded implementation would have asserted a fuzzy vendor+date guess as a confirmed award.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  awardSourceFor,
  awardCoverage,
  authorityAwardSource,
  normalizeAuthorityAward,
  normalizeRecentAuthorityAwards,
  rankNychaAwardCandidates,
} from "../external_awards.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexSrc = readFileSync(join(ROOT, "index.html"), "utf8");

function extractFn(name) {
  const asyncStart = indexSrc.indexOf("async function " + name + "(");
  const start = asyncStart >= 0 ? asyncStart : indexSrc.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let depth = 0, seen = false;
  for (let j = indexSrc.indexOf("{", start); j < indexSrc.length; j++) {
    if (indexSrc[j] === "{") { depth++; seen = true; }
    else if (indexSrc[j] === "}" && --depth === 0 && seen) return indexSrc.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// Leaf helpers the render functions lean on (injected, so the test needs no DOM).
const T = (key, vars) => {
  const s = ({
    external_awards_heading: "Awards published elsewhere",
    external_awards_abo_source: "NYS Authorities Budget Office",
    external_awards_checkbook_source: "Checkbook NYC",
    external_awards_abo_note: "Official annual filing.",
    external_awards_possible_note: "Possible awards, matched by vendor and award date — not a confirmed City Record match.",
    external_awards_updated: "Source updated {date}.",
    external_award_none_note_html: "The site also checked {source} and found no matching award there either.",
    external_award_nycha_none_note: "The site checked Checkbook NYC for this notice's PIN and found no registered award there yet.",
    external_award_nycha_note_html: "Checkbook NYC award matched by exact PIN <code>{pin}</code>.",
    agency_awards_elsewhere_note: "This agency files its contract awards with {source}, not the City Record.",
    agency_awards_none_open_data: "This agency's contract awards are not published in any open dataset CROL-List knows of.",
    agency_awards_unavailable_note: "No contract awards from this agency appear in the City Record — some agencies publish awards elsewhere.",
    mode_award: "Award", awarded_to: "Awarded to", untitled: "(untitled)", untitled_name: "(no name)",
  }[key]) || key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : "")) : s;
};
const money = (v) => (v ? "$" + v : "");
const escUiHtml = (s) => String(s == null ? "" : s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" }[c]));
const fdate = (d) => String(d || "").slice(0, 10);
const usablePin = (p) => String(p || "").trim().length >= 4;
const EXT_ATTRS = 'target="_blank" rel="noopener noreferrer"';
const extSR = () => '<span class="sr-only"> (opens in new tab)</span>';

// Build externalAwardHTML() with its render helpers, all injected with the leaf deps above.
function buildExternalAwardHTML() {
  const src = [
    extractFn("aboSourceLink"),
    extractFn("sourceUpdatedHTML"),
    extractFn("aboAwardsTimelineHTML"),
    extractFn("nychaAwardBoxHTML"),
    extractFn("externalAwardHTML"),
  ].join("\n") + "\nreturn externalAwardHTML;";
  return new Function("t", "money", "escUiHtml", "fdate", "usablePin", "EXT_ATTRS", "extSR", src)(
    T, money, escUiHtml, fdate, usablePin, EXT_ATTRS, extSR,
  );
}

test("registry: NYCHA is an exact Checkbook key; ABO agencies are fuzzy; new sources are covered", () => {
  assert.equal(awardCoverage("Housing Authority"), "exact");
  assert.deepEqual(awardSourceFor("Housing Authority"), { kind: "checkbook-nycha", precision: "exact" });
  assert.equal(awardCoverage("School Construction Authority"), "fuzzy");
  assert.equal(awardCoverage("Hudson River Park Trust"), "fuzzy", "state-authorities source added this pass");
  assert.equal(awardCoverage("Water Board"), "fuzzy", "NYC Water Board via ABO local authorities");
  assert.equal(awardCoverage("Triborough Bridge and Tunnel Authority"), "absent", "MTA constituent, no per-constituent open data");
  assert.equal(awardCoverage("Public Library - Queens"), "absent", "independent library, no procurement open dataset");
  assert.equal(awardCoverage("Sanitation"), "unknown", "an agency that publishes awards in the City Record itself");
});

test("authorityAwardSource: back-compat ABO {dataset, authority}, null for exact/absent", () => {
  assert.deepEqual(authorityAwardSource("School Construction Authority"), {
    dataset: "8w5p-k45m", authority: "New York City School Construction Authority",
  });
  assert.deepEqual(authorityAwardSource("Hudson River Park Trust"), {
    dataset: "ehig-g5x3", authority: "Hudson River Park Trust",
  });
  assert.equal(authorityAwardSource("Housing Authority"), null, "NYCHA uses Checkbook, not ABO");
  assert.equal(authorityAwardSource("Tax Commission"), null, "verified-absent has no ABO source");
});

test("normalizeAuthorityAward: money and provenance survive the Socrata row shape", () => {
  assert.deepEqual(normalizeAuthorityAward({
    authority_name: "New York City School Construction Authority",
    vendor_name: "Roux Environmental Engineering & Geology, D.P.C.",
    procurement_description: "ERC IEH SVS IN CONN W HAZARDOUS MATERIAL",
    award_process: "Authority Contract - Competitive Bid",
    award_date: "2024-05-06T00:00:00.000",
    contract_amount: "$5,000,000.00",
  }), {
    authority: "New York City School Construction Authority",
    vendor: "Roux Environmental Engineering & Geology, D.P.C.",
    description: "ERC IEH SVS IN CONN W HAZARDOUS MATERIAL",
    process: "Authority Contract - Competitive Bid",
    date: "2024-05-06T00:00:00.000",
    amount: 5000000,
    source: "nys-abo",
  });
});

test("normalizeRecentAuthorityAwards: drops malformed dates and future-dated source errors", () => {
  const good = { award_date: "2026-07-15T00:00:00.000", vendor_name: "CURRENT VENDOR", contract_amount: "$10.00" };
  const future = { award_date: "2029-01-01T00:00:00.000", vendor_name: "FUTURE VENDOR" };
  const badDate = { award_date: "not-a-date", vendor_name: "BAD DATE VENDOR" };
  const noDate = { vendor_name: "NO DATE VENDOR" };
  assert.deepEqual(normalizeRecentAuthorityAwards([future, good, badDate, noDate], "2026-07-16"), [
    normalizeAuthorityAward(good),
  ]);
});

test("rankNychaAwardCandidates: rejects the real stale PIN-reuse false positive", () => {
  const notice = { pin: "510394", start_date: "2025-05-01T00:00:00.000" };
  const stale = [{
    id: "PO1228767", pin: "510394", vendor: "KHUSHI CONSTRUCTION, INC.",
    approved: "2012-12-05", start: "2012-12-05", amount: 2800, recordType: "Agreement",
  }];
  assert.deepEqual(rankNychaAwardCandidates(notice, stale), []);
});

test("rankNychaAwardCandidates: keeps and deduplicates a temporally valid exact-PIN contract", () => {
  const notice = { pin: "337474", start_date: "2025-01-10T00:00:00.000" };
  const agreement = {
    id: "C00042", pin: "337474", vendor: "NELLIGAN WHITE ARCHITECTS PLLC",
    approved: "2025-03-01", start: "2025-02-15", amount: 7310000, recordType: "Agreement",
  };
  const rows = [agreement, { ...agreement, amount: 0 }, { ...agreement, id: "C00043", approved: "2024-12-01" }];
  assert.deepEqual(rankNychaAwardCandidates(notice, rows), [agreement]);
});

test("agencyAwardsNote: registry-backed empty state — covered names the source, absent is plain", () => {
  const agencyAwardsNote = new Function(
    "awardCoverage", "awardSourceFor", "t",
    extractFn("agencyAwardsNote") + "\nreturn agencyAwardsNote;",
  )(awardCoverage, awardSourceFor, T);

  assert.match(agencyAwardsNote("School Construction Authority"), /files its contract awards with NYS Authorities Budget Office/);
  assert.match(agencyAwardsNote("Housing Authority"), /files its contract awards with Checkbook NYC/);
  assert.match(agencyAwardsNote("Tax Commission"), /not published in any open dataset/);
  assert.match(agencyAwardsNote("Sanitation"), /some agencies publish awards elsewhere/, "unknown agency keeps the soft hedge");
});

test("externalAwardHTML: exact NYCHA match renders a confident award box with the PIN", () => {
  const externalAwardHTML = buildExternalAwardHTML();
  const notice = { pin: "337474", type_of_notice_description: "Solicitation" };
  const resp = {
    coverage: "exact",
    matches: [{ id: "C00042", vendor: "NELLIGAN WHITE ARCHITECTS PLLC", amount: 7310000, approved: "2025-03-01", start: "2025-02-15", method: "SEALED BID", purpose: "DESIGN SERVICES" }],
  };
  const html = externalAwardHTML(resp, notice);
  assert.match(html, /class="box award"/, "exact match reads as a confident award, not a maybe");
  assert.match(html, /NELLIGAN WHITE ARCHITECTS PLLC/);
  assert.match(html, /exact PIN <code>337474<\/code>/);
  assert.doesNotMatch(html, /Possible awards/);
});

test("externalAwardHTML: fuzzy ABO awards render as a 'possible' timeline with dated provenance", () => {
  const externalAwardHTML = buildExternalAwardHTML();
  const resp = {
    coverage: "fuzzy",
    agencyAwards: [{ vendor: "VHB ENGINEERING", description: "Environmental Consulting Services", process: "Competitive Bid", date: "2024-01-10T00:00:00.000", amount: 195000 }],
    source: { kind: "abo", dataset: "ehig-g5x3", refreshed: "2025-12-01" },
  };
  const html = externalAwardHTML(resp, null);
  assert.match(html, /class="timeline"/, "fuzzy reads as a list, not a confident chain box");
  assert.doesNotMatch(html, /class="box award"/);
  assert.match(html, /Possible awards/, "fuzzy result is verbally hedged as possible");
  assert.match(html, /data\.ny\.gov\/resource\/ehig-g5x3/);
  assert.match(html, /Source updated 2025-12-01/);
});

test("externalAwardHTML: covered ABO source with zero rows says the site checked it", () => {
  const externalAwardHTML = buildExternalAwardHTML();
  const resp = { coverage: "fuzzy", agencyAwards: [], source: { kind: "abo", dataset: "d84c-dk28", refreshed: "2025-12-01" } };
  const html = externalAwardHTML(resp, null);
  assert.match(html, /also checked/);
  assert.match(html, /data\.ny\.gov\/resource\/d84c-dk28/);
  assert.match(html, /Source updated 2025-12-01/);
});

test("externalAwardHTML: NYCHA with no match, but a usable PIN, says it checked Checkbook", () => {
  const externalAwardHTML = buildExternalAwardHTML();
  const eligible = { type_of_notice_description: "Solicitation", pin: "510394" };
  assert.match(externalAwardHTML({ coverage: "exact", matches: [] }, eligible), /checked Checkbook NYC/);
  // A NYCHA notice with no usable PIN can't have been searched — say nothing rather than imply it.
  const noPin = { type_of_notice_description: "Solicitation", pin: "N/A" };
  assert.equal(externalAwardHTML({ coverage: "exact", matches: [] }, noPin), "");
});

test("externalAwardForNotice: absent/unknown agencies fetch nothing (claim lives in the note)", async () => {
  let fetched = false;
  const externalAwardForNotice = new Function(
    "awardCoverage", "loadExternalAward", "document", "externalAwardHTML",
    extractFn("externalAwardForNotice") + "\nreturn externalAwardForNotice;",
  )(awardCoverage, async () => { fetched = true; return null; }, { contains: () => true }, () => "X");

  const el = { innerHTML: "" };
  await externalAwardForNotice({ agency_name: "Tax Commission", request_id: "1" }, el);
  assert.equal(fetched, false, "verified-absent agency triggers no worker fetch");
  await externalAwardForNotice({ agency_name: "Sanitation", request_id: "1" }, el);
  assert.equal(fetched, false, "unknown agency triggers no worker fetch either");
});

test("externalAwardForNotice: covered agency fetches once and renders the response", async () => {
  let calls = 0;
  const externalAwardForNotice = new Function(
    "awardCoverage", "loadExternalAward", "document", "externalAwardHTML",
    extractFn("externalAwardForNotice") + "\nreturn externalAwardForNotice;",
  )(awardCoverage, async () => { calls++; return { coverage: "exact", matches: [] }; },
    { contains: () => true }, () => "<rendered/>");

  const el = { innerHTML: "" };
  await externalAwardForNotice({ agency_name: "Housing Authority", request_id: "20250501001" }, el);
  assert.equal(calls, 1);
  assert.equal(el.innerHTML, "<rendered/>");
});
