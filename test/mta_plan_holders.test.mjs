import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildFromRetained } from "../tools/build_mta_plan_holders.mjs";
import { recordsFromMtaOpportunityFixtures } from "../warehouse/lib/mta_opportunities.mjs";
import {
  MTA_PLAN_HOLDERS_SCHEMA,
  buildMtaPlanHolders,
  listingDate,
  pageUpdated,
  parsePlanHolderListing,
  planHolderListingLinks,
  reportTimestamp,
  sha256,
} from "../warehouse/lib/mta_plan_holders.mjs";

const retained = new URL("../warehouse/fixtures/authority-native-procurement/mta-plan-holders/", import.meta.url);
const page = readFileSync(new URL("current-opportunities.html", retained), "utf8");
const receipt = JSON.parse(readFileSync(new URL("retrieval.json", retained), "utf8"));
const layout = (id) => readFileSync(new URL(`fixtures/mta_plan_holders/listing-${id}.txt`, import.meta.url), "utf8");
const hasPdftotext = spawnSync("pdftotext", ["-v"]).status === 0;

test("the current-opportunities page links one plan-holder listing per open solicitation, with its stage", () => {
  assert.equal(receipt.page.sha256, sha256(page));
  assert.equal(pageUpdated(page), "2026-11-12");
  const links = planHolderListingLinks(page);
  assert.equal(links.length, 35);
  assert.deepEqual(Object.fromEntries(["active", "pre_qualification", "request_for_information"].map((s) => [s, links.filter((l) => l.stage === s).length])), { active: 30, pre_qualification: 4, request_for_information: 1 });
  const painting = links.find((l) => l.solicitation_number === "C35310");
  assert.equal(painting.listing_url, "https://www.mta.info/document/227111");
  assert.equal(links.find((l) => l.solicitation_number === "A37826").event_number, "0000527910");
  // A request for information carries no listing, and says so rather than borrowing one.
  assert.equal(links.find((l) => l.stage === "request_for_information").listing_url, null);
  assert.equal(links.filter((l) => l.listing_url).length, receipt.listings.length);
});

test("a listing gives its report date, bid number, opening date and every firm as printed", () => {
  const listing = parsePlanHolderListing(layout("227111"));
  assert.deepEqual([listing.report_at, listing.bid_number, listing.short_title, listing.open_date, listing.pages], ["2026-11-09T09:00", "C35310", "LINE STRUCTURE PAINTING", "2026-11-17", 2]);
  assert.equal(listing.holders.length, 30);
  assert.deepEqual(listing.holders[0], {
    name: "NORTHEAST STRUCTURAL STEEL INC", address: "661 HILLSIDE RD.", city: "PELHAM MANOR", state: "NY", zip: "10803",
    contact: "DAN MALLEN", email: "DMALLEN@NESTRUCTURALSTEEL.COM", phone: "9146999900", fax: "9146999922",
  });
  // A wrapped name keeps its second line; a zip printed off its column is still read.
  assert.equal(listing.holders.find((h) => h.name.startsWith("GCCOM")).name, "GCCOM CONSTRUCTION COMPANY INC");
  assert.deepEqual(["NJ", "07080"], ((h) => [h.state, h.zip])(listing.holders.find((h) => h.name === "AEIS LLC")));
  // Every e-mail line in the listing belongs to exactly one firm.
  assert.equal(listing.holders.filter((h) => h.email).length, (layout("227111").match(/\S+@\S+/g) || []).length);
});

test("fields are kept as printed, including a one-letter state and a wrapped address", () => {
  const wsp = parsePlanHolderListing(layout("227156")).holders.find((h) => h.name === "WSP USA INC");
  assert.deepEqual([wsp.state, wsp.zip], ["N", "10119"]);
  const tectonic = parsePlanHolderListing(layout("227211")).holders.find((h) => h.name.startsWith("TECTONIC"));
  assert.equal(tectonic.address, "GEOLOGISTS & LAND SURVEYORS,DP");
  assert.equal(listingDate("08-DEC-26"), "2026-12-08");
  assert.equal(reportTimestamp("NOV-09-26 11:05 AM"), "2026-11-09T11:05");
  assert.equal(reportTimestamp("NOV-09-26 01:05 PM"), "2026-11-09T13:05");
  assert.equal(listingDate("31-FOO-26"), null);
});

test("the artifact lists every solicitation, with its listing or an explicit state, and refuses an unreadable listing", () => {
  const listings = new Map(receipt.listings.filter((l) => ["227111", "227156", "227211"].some((id) => l.url.endsWith(id)))
    .map((l) => [l.url, { bytes: readFileSync(new URL(l.file, retained)), text: layout(l.url.split("/").pop()), retrieved_at: l.retrieved_at }]));
  const artifact = buildMtaPlanHolders({ page: { html: page }, listings, retrievedAt: receipt.page.retrieved_at });
  assert.equal(artifact.schema, MTA_PLAN_HOLDERS_SCHEMA);
  assert.deepEqual(artifact.counts, { solicitations: 35, listed: 3, no_listing: 1, not_retained: 31, holder_rows: 156 });
  const painting = artifact.solicitations.find((s) => s.solicitation_number === "C35310");
  assert.equal(painting.listing.listed_at, "2026-11-09T09:00");
  assert.equal(painting.listing.sha256, receipt.listings.find((l) => l.url.endsWith("227111")).sha256);
  assert.equal(artifact.solicitations.find((s) => s.stage === "request_for_information").listing_state, "no_listing");
  assert.match(artifact.limits[0], /not a list of bidders/);
  const broken = new Map([[[...listings.keys()][0], { bytes: Buffer.from("x"), text: "nothing here", retrieved_at: "2026-11-13T07:05:00Z" }]]);
  assert.throws(() => buildMtaPlanHolders({ page: { html: page }, listings: broken, retrievedAt: "x" }), /unreadable plan-holder listing/);
});

test("the MTA reader keeps a retained listing's link, date and size with the opportunity, and null without one", () => {
  const fixture = {
    id: "mta-c35310", source_system: "mta_current_opportunities", source_dataset: "mta-cd-current-opportunities", source_record_id: "mta-current:C35310",
    observation_type: "opportunity", publisher_institution_id: "mta", source_row: { solicitation_number: "C35310", title: "Line Structure Painting" },
    receipt: { url: receipt.page.url, raw_response_sha256: receipt.page.sha256 },
    plan_holders: { url: "https://www.mta.info/document/227111", listed_at: "2026-11-09T09:00", open_date: "2026-11-17", sha256: "fd73e0117dad1561ca0a76c6d99176c881d8192436be72849a0830641fa333dd", holders: parsePlanHolderListing(layout("227111")).holders },
  };
  const [withListing, without] = recordsFromMtaOpportunityFixtures({ fixtures: [fixture, { ...fixture, plan_holders: undefined }] }).map((r) => JSON.parse(r.normalized_snapshot));
  assert.equal(withListing.plan_holders_url, "https://www.mta.info/document/227111");
  assert.deepEqual(withListing.plan_holders, { url: "https://www.mta.info/document/227111", listed_at: "2026-11-09T09:00", open_date: "2026-11-17", holder_count: 30, sha256: "fd73e0117dad1561ca0a76c6d99176c881d8192436be72849a0830641fa333dd" });
  assert.equal(without.plan_holders, null);
  assert.equal(without.plan_holders_url, null);
});

test("the published artifact is the build of the retained page and listings", { skip: hasPdftotext ? false : "pdftotext (poppler-utils) is not installed" }, () => {
  const rebuilt = `${JSON.stringify(buildFromRetained(), null, 2)}\n`;
  assert.equal(readFileSync(new URL("../site/data/mta_plan_holders.json", import.meta.url), "utf8"), rebuilt);
  const artifact = JSON.parse(rebuilt);
  assert.deepEqual(artifact.counts, { solicitations: 35, listed: 34, no_listing: 1, not_retained: 0, holder_rows: 1366 });
});

test("retained bytes that no longer match their receipt are refused before anything is read", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mta-plan-holders-test-"));
  try {
    cpSync(fileURLToPath(retained), dir, { recursive: true });
    const file = path.join(dir, receipt.listings[0].file);
    const bytes = readFileSync(file); bytes[bytes.length - 10] ^= 1; writeFileSync(file, bytes);
    assert.throws(() => buildFromRetained(dir, { layoutText: () => { throw new Error("must not be reached"); } }), /bytes do not match retrieval\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
