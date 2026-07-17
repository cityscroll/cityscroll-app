// Awards published outside the City Record. The registry (external_awards.js) drives the sweep,
// the join precision, and the coverage claim; the award DATA is precomputed server-side and served
// by GET /externalaward, so the client no longer fires a live SODA/Checkbook call per view. These
// tests pin the class boundaries from the client's side: an exact-key agency (NYCHA) renders a
// confident award box, a fuzzy-source agency renders a "possible" timeline, a verified-absent
// agency states the absence plainly, and a covered agency whose source turned up nothing says the
// site checked that source and found none. Before this feature external awards were absent; an
// unguarded implementation would have asserted a fuzzy vendor+date guess as a confirmed award.
//
// crol-awardlink-w6: every one of those notes used to name its source as plain text with no way
// to go look — "affordances imply capability" was the site owner's framing. These tests now also
// pin that each note carries a working, scoped link: NYCHA's exact match links straight to the
// matched contract on Checkbook NYC (verified live 2026-07-17 — contract detail resolves purely
// by contract id, e.g. https://www.checkbooknyc.com/nycha_contract_details/agency/162/datasource/
// checkbook_nycha/contract/PO1125076 renders real PIN-340881 data regardless of the year segment);
// ABO's fuzzy match/none-found links to the authority-filtered SODA view (verified live — Socrata
// accepts a plain `authority_name=` filter on the dataset's own /resource/<id>.json endpoint); a
// verified-absent agency links to about.html's own provenance doc; and malformed/missing registry
// data (no dataset/authority, no contract id) fails soft to unlinked source-name text, never a
// broken href.

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

function extractConst(name) {
  const m = indexSrc.match(new RegExp(`^const ${name} = [^;]*;`, "m"));
  assert.ok(m, `const ${name} not found`);
  return m[0];
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
    external_award_nycha_none_note_html: "The site checked {link} for this notice's PIN and found no registered award there yet.",
    external_award_nycha_note_html: "{link} award matched by exact PIN <code>{pin}</code>.",
    agency_awards_elsewhere_note: "This agency files its contract awards with {source}, not the City Record.",
    agency_awards_none_open_data_html: "This agency's contract awards are not published in any open dataset CROL-List knows of. <a href=\"about.html#external-awards-sources\">See what we checked</a>.",
    agency_awards_unavailable_note_html: "No contract awards from this agency appear in the City Record — some agencies publish awards elsewhere. <a href=\"about.html#external-awards-sources\">See what we checked</a>.",
    mode_award: "Award", awarded_to: "Awarded to", untitled: "(untitled)", untitled_name: "(no name)",
    award_watch_offer_btn: "Email me when the award registers",
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
    extractConst("CHECKBOOK_NYCHA_AGENCY_ID"),
    extractFn("aboSourceLink"),
    extractFn("checkbookNychaLink"),
    extractFn("checkbookNychaContractsLink"),
    extractFn("sourceUpdatedHTML"),
    extractFn("aboAwardsTimelineHTML"),
    extractFn("nychaAwardBoxHTML"),
    extractFn("awardWatchOfferHTML"),
    extractFn("externalAwardHTML"),
  ].join("\n") + "\nreturn externalAwardHTML;";
  return new Function("t", "money", "escUiHtml", "fdate", "usablePin", "EXT_ATTRS", "extSR", src)(
    T, money, escUiHtml, fdate, usablePin, EXT_ATTRS, extSR,
  );
}
function buildAgencyAwardsNote() {
  const src = [
    extractConst("CHECKBOOK_NYCHA_AGENCY_ID"),
    extractFn("aboSourceLink"),
    extractFn("checkbookNychaLink"),
    extractFn("checkbookNychaContractsLink"),
    extractFn("agencyAwardsNote"),
  ].join("\n") + "\nreturn agencyAwardsNote;";
  return new Function("awardCoverage", "awardSourceFor", "t", "EXT_ATTRS", "extSR", src)(
    awardCoverage, awardSourceFor, T, EXT_ATTRS, extSR,
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

test("agencyAwardsNote: registry-backed empty state — before crol-awardlink-w6 every branch named its source as plain text with no way to go look; now each carries a working scoped link", () => {
  const agencyAwardsNote = buildAgencyAwardsNote();

  // Fuzzy ABO agency: source name links to the authority-filtered SODA view (real dataset id).
  const sca = agencyAwardsNote("School Construction Authority");
  assert.match(sca, /files its contract awards with/);
  assert.match(sca, /<a href="https:\/\/data\.ny\.gov\/resource\/8w5p-k45m\.json\?\$order=award_date%20DESC&authority_name=New%20York%20City%20School%20Construction%20Authority"[^>]*>NYS Authorities Budget Office/);

  // Exact NYCHA agency, agency-level (no single notice/PIN in scope): links to NYCHA's whole
  // Checkbook contracts view — the agency-scoped fallback (verified live 2026-07-17).
  const nycha = agencyAwardsNote("Housing Authority");
  assert.match(nycha, /files its contract awards with/);
  assert.match(nycha, /<a href="https:\/\/www\.checkbooknyc\.com\/nycha_contracts\/datasource\/checkbook_nycha\/agency\/162"[^>]*>Checkbook NYC/);

  // Verified-absent: the honest affordance is transparency, not a dead source name — links to
  // the site's own provenance doc instead of naming a source with nowhere to click.
  const absent = agencyAwardsNote("Tax Commission");
  assert.match(absent, /not published in any open dataset/);
  assert.match(absent, /<a href="about\.html#external-awards-sources">/);

  // Unknown (agency not in the registry at all) keeps the soft hedge, also now linked to the
  // same provenance doc rather than left as a bare unfulfilled "elsewhere" claim.
  const unknown = agencyAwardsNote("Sanitation");
  assert.match(unknown, /some agencies publish awards elsewhere/, "unknown agency keeps the soft hedge");
  assert.match(unknown, /<a href="about\.html#external-awards-sources">/);
});

test("agencyAwardsNote: an authority name that needs URL-encoding still produces a valid, correctly-scoped href", () => {
  const agencyAwardsNote = buildAgencyAwardsNote();
  // "The Mayor's Fund to Advance New York City" — encodeURIComponent leaves the apostrophe
  // bare (it's in its unreserved set) rather than percent-encoding it; verified live
  // 2026-07-17 that Socrata's authority_name= filter matches correctly either way, with a
  // literal apostrophe in the query string.
  const html = agencyAwardsNote("Mayor's Fund to Advance New York City");
  assert.match(html, /authority_name=The%20Mayor's%20Fund%20to%20Advance%20New%20York%20City/);
});

test("externalAwardHTML: exact NYCHA match renders a confident award box with the PIN, linked to the exact matched contract", () => {
  // Real fixture, live-verified 2026-07-17: NYCHA PIN 340881 (Checkbook contract PO1125076,
  // "RESIDENT WATCH AWARDS DINNER", vendor TAVARES RESTAURANT #2). Before this pass, the note
  // said "matched by exact PIN" with no link at all — the reader had no way to go see the
  // contract Checkbook actually matched.
  const externalAwardHTML = buildExternalAwardHTML();
  const notice = { pin: "340881", type_of_notice_description: "Solicitation" };
  const resp = {
    coverage: "exact",
    matches: [{ id: "PO1125076", vendor: "TAVARES RESTAURANT #2", amount: 488, approved: "2011-10-28", start: "2011-10-28", method: "SMALL PURCHASE", purpose: "RESIDENT WATCH AWARDS DINNER" }],
  };
  const html = externalAwardHTML(resp, notice);
  assert.match(html, /class="box award"/, "exact match reads as a confident award, not a maybe");
  assert.match(html, /TAVARES RESTAURANT #2/);
  assert.match(html, /exact PIN <code>340881<\/code>/);
  assert.doesNotMatch(html, /Possible awards/);
  assert.match(html, /<a href="https:\/\/www\.checkbooknyc\.com\/nycha_contract_details\/agency\/162\/datasource\/checkbook_nycha\/contract\/PO1125076"[^>]*>Checkbook NYC/);
});

test("externalAwardHTML: fuzzy ABO awards (real SCA fixture) render as a 'possible' timeline, source-linked to the authority-filtered dataset view", () => {
  // Real fixture, live-verified 2026-07-17: data.ny.gov's 8w5p-k45m dataset filtered to
  // authority_name=New York City School Construction Authority returns real SCA awards
  // (e.g. Roux Environmental Engineering, awarded 2024-05-06). Before this pass the "NYS
  // Authorities Budget Office" source name here was plain text with no href at all.
  const externalAwardHTML = buildExternalAwardHTML();
  const resp = {
    coverage: "fuzzy",
    agencyAwards: [{ vendor: "VHB ENGINEERING", description: "Environmental Consulting Services", process: "Competitive Bid", date: "2024-01-10T00:00:00.000", amount: 195000 }],
    source: { kind: "abo", dataset: "8w5p-k45m", authority: "New York City School Construction Authority", refreshed: "2025-12-01" },
  };
  const html = externalAwardHTML(resp, null);
  assert.match(html, /class="timeline"/, "fuzzy reads as a list, not a confident chain box");
  assert.doesNotMatch(html, /class="box award"/);
  assert.match(html, /Possible awards/, "fuzzy result is verbally hedged as possible");
  assert.match(html, /<a href="https:\/\/data\.ny\.gov\/resource\/8w5p-k45m\.json\?\$order=award_date%20DESC&authority_name=New%20York%20City%20School%20Construction%20Authority"[^>]*>NYS Authorities Budget Office/);
  assert.match(html, /Source updated 2025-12-01/);
});

test("externalAwardHTML: covered ABO source with zero rows says the site checked it, linked and dated — the ongoing weekly-cron capability reads as a live process, not a dead end", () => {
  const externalAwardHTML = buildExternalAwardHTML();
  const resp = { coverage: "fuzzy", agencyAwards: [], source: { kind: "abo", dataset: "d84c-dk28", authority: "New York City Economic Development Corporation", refreshed: "2025-12-01" } };
  const html = externalAwardHTML(resp, null);
  assert.match(html, /also checked/);
  assert.match(html, /<a href="https:\/\/data\.ny\.gov\/resource\/d84c-dk28\.json\?\$order=award_date%20DESC&authority_name=New%20York%20City%20Economic%20Development%20Corporation"[^>]*>NYS Authorities Budget Office/);
  assert.match(html, /Source updated 2025-12-01/, "the precomputed source-refresh date is reused, so \"nothing yet\" reads as a live process");
});

test("externalAwardHTML: NYCHA with no match, but a usable PIN, says it checked Checkbook — linked to NYCHA's contracts view, since there's no single matched contract to point at yet", () => {
  const externalAwardHTML = buildExternalAwardHTML();
  const eligible = { type_of_notice_description: "Solicitation", pin: "510394" };
  const html = externalAwardHTML({ coverage: "exact", matches: [] }, eligible);
  assert.match(html, /checked/);
  assert.match(html, /<a href="https:\/\/www\.checkbooknyc\.com\/nycha_contracts\/datasource\/checkbook_nycha\/agency\/162"[^>]*>Checkbook NYC/);
});

test("externalAwardHTML: a NYCHA notice with no usable PIN renders nothing here (can't have been searched) — the agency-scoped fallback still surfaces via agencyAwardsNote/noticeAgencyBar", () => {
  const externalAwardHTML = buildExternalAwardHTML();
  const noPin = { type_of_notice_description: "Solicitation", pin: "N/A" };
  assert.equal(externalAwardHTML({ coverage: "exact", matches: [] }, noPin), "");
});

test("externalAwardHTML / aboSourceLink: malformed registry data (missing authority) fails soft to unlinked source-name text, never a broken href", () => {
  const externalAwardHTML = buildExternalAwardHTML();
  const resp = { coverage: "fuzzy", agencyAwards: [], source: { kind: "abo", dataset: "8w5p-k45m", refreshed: "2025-12-01" } };
  const html = externalAwardHTML(resp, null);
  assert.doesNotMatch(html, /<a /, "no authority to scope the link to — render plain text, not a broken/unscoped href");
  assert.match(html, /NYS Authorities Budget Office/);
});

test("externalAwardForNotice: absent/unknown agencies fetch nothing (claim lives in the note)", async () => {
  let fetched = false;
  const externalAwardForNotice = new Function(
    "awardCoverage", "loadExternalAward", "document", "externalAwardHTML",
    extractFn("externalAwardForNotice") + "\nreturn externalAwardForNotice;",
  )(awardCoverage, async () => { fetched = true; return null; }, { contains: () => true }, () => "X");

  const el = { innerHTML: "", querySelector: () => null };
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

  const el = { innerHTML: "", querySelector: () => null };
  await externalAwardForNotice({ agency_name: "Housing Authority", request_id: "20250501001" }, el);
  assert.equal(calls, 1);
  assert.equal(el.innerHTML, "<rendered/>");
});
