// The City Record has no award rows for several active authorities. The first NYCHA scout
// treated PIN 510394 as a hard match, but a live Checkbook lookup returned a 2012 purchase
// order for a solicitation published in 2025: NYCHA reuses short numeric PINs. Before this
// feature, external awards were absent; an unguarded implementation would have introduced a
// false award. After: authority profiles resolve to their official ABO feed, and NYCHA only
// surfaces an exact-PIN contract whose approval/start date does not predate the solicitation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
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

class FakeDoc {
  constructor(xml) { this.xml = xml; }
  querySelector(sel) {
    if (sel !== "response > status > result") return null;
    const m = this.xml.match(/<status>[\s\S]*?<result>([^<]*)<\/result>/);
    return m ? { textContent: m[1] } : null;
  }
  getElementsByTagName(tag) {
    if (tag !== "transaction") return [];
    return [...this.xml.matchAll(/<transaction>([\s\S]*?)<\/transaction>/g)].map((match) => ({
      getElementsByTagName(child) {
        const m = match[1].match(new RegExp(`<${child}>([^<]*)</${child}>`));
        return m ? [{ textContent: m[1] }] : [];
      },
    }));
  }
}
class FakeDOMParser { parseFromString(xml) { return new FakeDoc(xml); } }

const escXml = (s) => String(s).replace(/[<>&'\"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '\"': "&quot;" }[c]));

test("authorityAwardSource: resolves City Record agency names to official ABO datasets", () => {
  assert.deepEqual(authorityAwardSource("School Construction Authority"), {
    dataset: "8w5p-k45m",
    authority: "New York City School Construction Authority",
  });
  assert.deepEqual(authorityAwardSource("Economic Development Corporation"), {
    dataset: "d84c-dk28",
    authority: "New York City Economic Development Corporation",
  });
  assert.equal(authorityAwardSource("Housing Authority"), null, "NYCHA uses Checkbook, not ABO");
  assert.equal(authorityAwardSource("Sanitation"), null);
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

test("normalizeRecentAuthorityAwards: excludes future-dated source errors before display", () => {
  const current = { award_date: "2026-07-16T00:00:00.000", vendor_name: "CURRENT VENDOR" };
  const future = { award_date: "2029-01-01T00:00:00.000", vendor_name: "FUTURE VENDOR" };
  assert.deepEqual(normalizeRecentAuthorityAwards([future, current], "2026-07-16"), [
    normalizeAuthorityAward(current),
  ]);
});

test("loadAuthorityAwards: excludes future dates before limiting recent official rows", async () => {
  let query = null;
  const loadAuthorityAwards = new Function(
    "authorityAwardSource", "todayISO", "api", "normalizeRecentAuthorityAwards",
    extractFn("loadAuthorityAwards") + "\nreturn loadAuthorityAwards;",
  )(authorityAwardSource, () => "2026-07-16T00:00:00", async (_base, params) => {
    query = params;
    return [{ award_date: "2026-07-15T00:00:00.000", vendor_name: "CURRENT VENDOR" }];
  }, normalizeRecentAuthorityAwards);

  const rows = await loadAuthorityAwards("Brooklyn Navy Yard Development Corp.");
  assert.match(query.$where, /award_date <= '2026-07-16T23:59:59\.999'/);
  assert.equal(query.$order, "award_date DESC");
  assert.equal(query.$limit, "8");
  assert.equal(rows[0].vendor, "CURRENT VENDOR");
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

test("rankNychaAwardCandidates: rejects equal-date and non-agreement transactions", () => {
  const notice = { pin: "337474", start_date: "2025-01-10T00:00:00.000" };
  const equalDate = {
    id: "C00042", pin: "337474", approved: "2025-01-10T00:00:00.000", recordType: "Agreement",
  };
  const laterRelease = {
    id: "C00043", pin: "337474", approved: "2025-03-01", recordType: "Release",
  };
  assert.deepEqual(rankNychaAwardCandidates(notice, [equalDate, laterRelease]), []);
});

test("checkbookNychaByPin: paginates exact-PIN rows and keeps only agreements", async () => {
  const sentXml = [];
  const line = (id) => `<transaction><contract_id>${id}</contract_id><record_type>Line</record_type><pin>337474</pin></transaction>`;
  const firstPage = Array.from({ length: 24 }, (_, i) => line(`L${i}`)).join("")
    + `<transaction><contract_id>R00001</contract_id><record_type>Release</record_type><pin>337474</pin>
      <approved_date>2026-04-01</approved_date></transaction>`;
  const secondPage = `<transaction><contract_id>C00042</contract_id><record_type>Agreement</record_type><pin>337474</pin>
      <vendor>NELLIGAN WHITE ARCHITECTS PLLC</vendor><contract_current_amount>7310000.00</contract_current_amount>
      <approved_date>2025-03-01</approved_date><start_date>2025-02-15</start_date><award_method>SEALED BID</award_method>
      <purpose>DESIGN SERVICES</purpose></transaction>
    ${line("L25")}`;
  const checkbookNychaByPin = new Function(
    "API", "workerFetch", "DOMParser", "escXml",
    extractFn("checkbookNychaByPin") + "\nreturn checkbookNychaByPin;",
  )("https://api.crol-list.org", async (_path, opts) => {
    const xml = JSON.parse(opts.body).xml;
    sentXml.push(xml);
    const transactions = xml.includes("<records_from>1</records_from>") ? firstPage : secondPage;
    return { text: async () => `<response><status><result>success</result></status><contract_transactions>${transactions}</contract_transactions></response>` };
  }, FakeDOMParser, escXml);

  const rows = await checkbookNychaByPin("337474");
  assert.equal(sentXml.length, 2);
  assert.match(sentXml[0], /<type_of_data>Contracts_NYCHA<\/type_of_data>/);
  assert.match(sentXml[0], /<records_from>1<\/records_from>/);
  assert.match(sentXml[1], /<records_from>26<\/records_from>/);
  assert.match(sentXml[0], /<value>337474<\/value>/);
  assert.doesNotMatch(sentXml[0], /<name>record_type<\/name>/);
  assert.deepEqual(rows, [{
    id: "C00042", pin: "337474", vendor: "NELLIGAN WHITE ARCHITECTS PLLC",
    amount: 7310000, invoiced: 0, start: "2025-02-15", end: "", approved: "2025-03-01",
    method: "SEALED BID", purpose: "DESIGN SERVICES", recordType: "Agreement",
  }]);
});

test("checkbookNychaByPin: fails closed when the bounded page limit is exhausted", async () => {
  let calls = 0;
  const fullPage = Array.from({ length: 25 }, (_, i) =>
    `<transaction><contract_id>L${i}</contract_id><record_type>Line</record_type><pin>337474</pin></transaction>`
  ).join("");
  const checkbookNychaByPin = new Function(
    "API", "workerFetch", "DOMParser", "escXml",
    extractFn("checkbookNychaByPin") + "\nreturn checkbookNychaByPin;",
  )("https://api.crol-list.org", async () => {
    calls++;
    return { text: async () => `<response><status><result>success</result></status><contract_transactions>${fullPage}</contract_transactions></response>` };
  }, FakeDOMParser, escXml);

  assert.equal(await checkbookNychaByPin("337474"), null);
  assert.equal(calls, 8);
});

test("NYCHA award rendering keeps translated chrome outside the English vendor island", () => {
  assert.match(indexSrc, /<div class="vend">\$\{t\("awarded_to"\)\} <b lang="en" dir="ltr">/);
  assert.doesNotMatch(indexSrc, /<div class="vend" lang="en" dir="ltr">\$\{t\("awarded_to"\)\}/);
});

test("authorityAwardsHTML: marks only populated source values as English", () => {
  const authorityAwardsHTML = new Function(
    "authorityAwardSource", "fdate", "escUiHtml", "t", "money", "EXT_ATTRS", "extSR",
    extractFn("authorityAwardsHTML") + "\nreturn authorityAwardsHTML;",
  )(authorityAwardSource, (value) => value, (value) => String(value), (key) => ({ untitled_name: "بلا اسم", external_awards_heading: "العقود", external_awards_abo_note: "ملاحظة", external_awards_abo_source: "المصدر" }[key]), (value) => value ? `$${value}` : "", "", () => "");

  const fallback = authorityAwardsHTML("School Construction Authority", [{ date: "2026-01-01", amount: 0 }]);
  assert.match(fallback, /<span class="tlreason"><b>بلا اسم<\/b><\/span>/);
  assert.doesNotMatch(fallback, /lang="en"/);

  const populated = authorityAwardsHTML("School Construction Authority", [{ vendor: "SOURCE VENDOR", description: "SOURCE DESCRIPTION", process: "SOURCE PROCESS", date: "2026-01-01", amount: 10 }]);
  assert.match(populated, /<b lang="en" dir="ltr">SOURCE VENDOR<\/b>/);
  assert.match(populated, /<span lang="en" dir="ltr"> — SOURCE DESCRIPTION<\/span>/);
  assert.match(populated, /<span lang="en" dir="ltr">SOURCE PROCESS<\/span>/);
});

test("externalAwardForNotice: leaves translated purpose fallback in page language", async () => {
  let rows = [{ purpose: "", amount: 0, vendor: "", method: "" }];
  const externalAwardForNotice = new Function(
    "checkbookNychaByPin", "usablePin", "document", "rankNychaAwardCandidates", "t", "fdate", "escUiHtml", "money",
    extractFn("externalAwardForNotice") + "\nreturn externalAwardForNotice;",
  )(async () => rows, () => true, { contains: () => true }, (_notice, candidates) => candidates,
    (key) => ({ external_awards_heading: "العقود", mode_award: "منح", untitled: "بلا عنوان", awarded_to: "مُنح إلى", external_award_nycha_note_html: "ملاحظة" }[key]),
    (value) => value || "", (value) => String(value || ""), (value) => value ? `$${value}` : "");
  const notice = { agency_name: "Housing Authority", type_of_notice_description: "Solicitation", pin: "337474" };
  const el = { innerHTML: "" };

  await externalAwardForNotice(notice, el);
  assert.match(el.innerHTML, /<div class="bt">بلا عنوان<\/div>/);
  assert.doesNotMatch(el.innerHTML, /<div class="bt" lang="en" dir="ltr">بلا عنوان<\/div>/);

  rows = [{ purpose: "SOURCE PURPOSE", amount: 0, vendor: "", method: "" }];
  await externalAwardForNotice(notice, el);
  assert.match(el.innerHTML, /<div class="bt" lang="en" dir="ltr">SOURCE PURPOSE<\/div>/);
});
