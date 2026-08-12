import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AGENCY_OBLIGATIONS_CERTIFICATION,
  AGENCY_OBLIGATIONS_METHOD,
  AGENCY_OBLIGATIONS_SCHEMA,
  agencyObligationsFollowHref,
  buildAgencyObligationsLookup,
  buildAgencyObligationsView,
  legistarMatterUrl,
  normalizeObligationRow,
  obligationDigestRowsForAgency,
  resolveStatuteActorAgency,
} from "../site/agency_obligations.mjs";
import { compileSub } from "../worker/src/lib/compile.mjs";
import {
  AGENCY_CONSTELLATION_CATEGORIES,
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOOKUP_PATH = join(ROOT, "site/data/agency_obligations_lookup.json");
const FIXTURE_PATH = join(ROOT, "test/fixtures/agency_obligations/our_sample.json");
const PARKS = "parks-and-recreation";

test("statute actor aliases resolve Parks and HPD", () => {
  assert.equal(resolveStatuteActorAgency("Department of Parks and Recreation").agency_id, PARKS);
  assert.equal(resolveStatuteActorAgency("DPR").agency_id, PARKS);
  assert.equal(resolveStatuteActorAgency("HPD").agency_id, "housing-preservation-and-development");
  assert.equal(resolveStatuteActorAgency("the department").matched, false);
  assert.equal(resolveStatuteActorAgency("City of New York").matched, false);
});

test("legistarMatterUrl uses Gateway M=L for matter ids (not broken LegislationDetail G=S)", () => {
  assert.equal(
    legistarMatterUrl("48909"),
    "https://nyc.legistar.com/Gateway.aspx?M=L&ID=48909",
  );
  assert.equal(legistarMatterUrl("not-a-number"), null);
  assert.equal(legistarMatterUrl(""), null);
  // Detail id + GUID only when both are known; matter_id alone is not a detail id.
  assert.equal(
    legistarMatterUrl("48909", {
      detailId: "1130243",
      matterGuid: "AE183CB9-0C63-4385-B885-67C0AAEDB007",
    }),
    "https://nyc.legistar.com/LegislationDetail.aspx?ID=1130243&GUID=AE183CB9-0C63-4385-B885-67C0AAEDB007",
  );
  // GUID without detail id still uses Gateway — wrong detail id + GUID is invalid.
  assert.equal(
    legistarMatterUrl("48909", { matterGuid: "AE183CB9-0C63-4385-B885-67C0AAEDB007" }),
    "https://nyc.legistar.com/Gateway.aspx?M=L&ID=48909",
  );
});

test("committed obligations source-law URLs never use invalid LegislationDetail G=S", () => {
  assert.ok(existsSync(LOOKUP_PATH));
  const lookup = JSON.parse(readFileSync(LOOKUP_PATH, "utf8"));
  const sample = lookup.by_agency[PARKS]?.obligations?.[0];
  assert.ok(sample?.source?.legistar_url);
  assert.match(sample.source.legistar_url, /^https:\/\/nyc\.legistar\.com\/Gateway\.aspx\?M=L&ID=\d+$/);
  assert.doesNotMatch(JSON.stringify(lookup).slice(0, 500_000), /LegislationDetail\.aspx\?ID=\d+&G=S/);
});

test("normalizeObligationRow never asserts compliance", () => {
  const row = normalizeObligationRow({
    mandate_id: "1-001",
    matter_id: "1",
    agency: "Department of Parks and Recreation",
    duty_text: "Publish an annual report.",
    deliverable_type: "report",
    deadline: { kind: "fixed_date", computed_date: "2020-01-01", text: "by January 1, 2020" },
    recurrence: "annual",
    citation: "Admin. Code § 1-1",
    quote_verified: true,
  });
  assert.equal(row.deadline.is_compliance_verdict, false);
  assert.equal(row.observation.status, "not_adjudicated");
  assert.equal(row.certification.status, "auto_certified");
  assert.equal(row.certification.basis, AGENCY_OBLIGATIONS_CERTIFICATION);
  assert.match(row.source.legistar_url, /Gateway\.aspx\?M=L&ID=1/);
  assert.doesNotMatch(row.source.legistar_url, /G=S|LegislationDetail\.aspx\?ID=1&G=S/);
  assert.doesNotMatch(JSON.stringify(row), /non-compliance|violat|missed filing/i);
});

test("law-envelope temporal anchors remain strict machine provenance", () => {
  const mandateRow = {
    mandate_id: "temporal-001",
    matter_id: "temporal-law",
    agency: "Department of Parks and Recreation",
    duty_text: "Hold recurring public meetings on park access.",
    deliverable_type: "other",
    deadline: { kind: "none" },
    recurrence: "ongoing",
    quote_verified: true,
  };
  const lookup = buildAgencyObligationsLookup({
    laws: [{
      matter_id: "temporal-law",
      enactment_date: "2024-01-15",
      effective_date: "2024-02-01",
    }],
    mandates: [mandateRow],
  }, { generatedAt: "2026-08-09T12:00:00Z" });
  const row = lookup.by_agency[PARKS].obligations[0];
  assert.equal(row.enactment_date, "2024-01-15");
  assert.equal(row.effective_date, "2024-02-01");
  assert.equal(row.temporal_anchor_method, "law_envelope_strict_iso_v1");

  const malformed = buildAgencyObligationsLookup({
    laws: [{
      matter_id: "temporal-law",
      enactment_date: "2024-02-30",
      effective_date: "not-a-date",
    }],
    mandates: [mandateRow],
  });
  const malformedRow = malformed.by_agency[PARKS].obligations[0];
  assert.equal(malformedRow.enactment_date, null);
  assert.equal(malformedRow.effective_date, null);
  assert.equal(malformedRow.temporal_anchor_method, "law_envelope_strict_iso_v1");
});

test("fixture materialization yields Parks duties with provenance", () => {
  assert.ok(existsSync(FIXTURE_PATH), "fixture sample must exist");
  const payload = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const lookup = buildAgencyObligationsLookup(payload);
  assert.equal(lookup.schema, AGENCY_OBLIGATIONS_SCHEMA);
  assert.equal(lookup.method, AGENCY_OBLIGATIONS_METHOD);
  assert.equal(lookup.certification_basis, AGENCY_OBLIGATIONS_CERTIFICATION);
  assert.ok(lookup.by_agency[PARKS]?.count >= 1);
  const view = buildAgencyObligationsView(PARKS, lookup);
  assert.equal(view.status, "matched");
  assert.ok(view.items[0].duty_text);
  assert.ok(view.items[0].href || view.items[0].source?.legistar_url);
  assert.match(view.follow_href, /lens=mandates/);
  assert.match(view.follow_href, /parks-and-recreation|Parks/);
});

test("committed lookup covers Parks with real backfill scale", () => {
  assert.ok(existsSync(LOOKUP_PATH), "agency_obligations_lookup.json must be committed");
  const lookup = JSON.parse(readFileSync(LOOKUP_PATH, "utf8"));
  assert.equal(lookup.schema, AGENCY_OBLIGATIONS_SCHEMA);
  assert.ok(lookup.summary.obligation_count >= 6000);
  assert.ok(lookup.by_agency[PARKS]?.count >= 20, "Parks must have real statutory duties");
  assert.match(lookup.honesty.compliance, /statutory timed event/i);
  // Auto-certified path only — no human-review gate fields.
  assert.doesNotMatch(JSON.stringify(lookup.honesty), /clerk review|cairn|verdicts-file/i);
  const sample = lookup.by_agency[PARKS].obligations[0];
  assert.ok(sample.source.legistar_url);
  assert.ok(["auto_certified", "auto_candidate"].includes(sample.certification.status));
});

test("constellation folds obligations as rules→obligations facet for Parks", () => {
  const intelligence = JSON.parse(readFileSync(join(ROOT, "site/data/entity_intelligence_lookup.json"), "utf8"));
  const certification = JSON.parse(readFileSync(join(ROOT, "site/data/exam_certification_constellation.json"), "utf8"));
  const obligations = JSON.parse(readFileSync(LOOKUP_PATH, "utf8"));
  const view = buildAgencyConstellationView(PARKS, { intelligence, certification, obligations });
  assert.deepEqual(
    view.categories.map((category) => category.id),
    AGENCY_CONSTELLATION_CATEGORIES.map((category) => category.id),
  );
  const byId = Object.fromEntries(view.categories.map((category) => [category.id, category]));
  assert.equal(byId.obligations.status, "matched");
  assert.ok(byId.obligations.count >= 20);
  assert.ok(byId.obligations.items.length >= 1);
  assert.ok(
    byId.obligations.method === AGENCY_OBLIGATIONS_METHOD
      || byId.obligations.method === "mandate_expected_vs_observed_v1",
  );
  assert.equal(byId.obligations.certification_basis, AGENCY_OBLIGATIONS_CERTIFICATION);
  assert.match(byId.obligations.honesty, /mandate|City Record|statutory/i);
  assert.ok(view.summary.matched_categories >= 5);

  const html = renderAgencyConstellationDocument(view);
  assert.doesNotMatch(html, /id="mandates-conformance"/);
  assert.match(html, /main:not\(:has\(#mandates-conformance\)\) a\[href\$="#mandates-conformance"\]/);
  assert.match(html, /Mandates/);
  assert.match(html, /Source law/);
  assert.match(html, /Watch mandates and deadlines|Watch obligations and deadlines/);
  assert.match(html, /auto_certified_quote_verify_v1|auto-certified|expected vs evidence|expected vs observed/i);
  assert.doesNotMatch(html, /non-compliance|out of compliance|missed the deadline and failed/i);
  assert.doesNotMatch(html, /human review|clerk review|cairn/i);
});

test("compileSub obligations lens is a world-state transform, not SODA", () => {
  const q = compileSub({
    lens: "mandates",
    filter: { agency_id: PARKS, agency: "Parks and Recreation" },
  }, "2026-08-07");
  assert.ok(q);
  assert.equal(q.kind, "obligation");
  assert.equal(q.idField, "alert_id");
  assert.match(q.url, /agency_obligations_lookup\.json$/);
  assert.equal(typeof q.transformRows, "function");

  const lookup = JSON.parse(readFileSync(LOOKUP_PATH, "utf8"));
  const rows = q.transformRows(lookup);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1, "Parks free-watch should surface standing or dated mandates");
  for (const row of rows.slice(0, 5)) {
    assert.ok(row.alert_id.startsWith("obligation:"));
    assert.equal(row.compliance_verdict, null);
    // Product rows state facts only — no honesty_note disclaimer hedges.
    assert.equal(row.honesty_note, undefined);
    assert.equal(row.observation_status, "not_adjudicated");
    assert.ok(row.duty_text);
  }
});

test("compileSub mandate_id filters the lookup by exact obligation id", () => {
  const lookup = JSON.parse(readFileSync(LOOKUP_PATH, "utf8"));
  const sample = lookup.by_agency?.["homeless-services"]?.obligations
    ?.find((row) => row.obligation_id === "66056-006");
  assert.ok(sample, "fixture obligation 66056-006 must exist for exact-id compile");

  const agencyWide = compileSub({
    lens: "mandates",
    filter: { agency_id: "homeless-services", agency: "Homeless Services" },
  }, "2026-08-07");
  const agencyRows = agencyWide.transformRows(lookup);
  assert.ok(agencyRows.length >= 1);

  const exact = compileSub({
    lens: "mandates",
    filter: {
      agency_id: "homeless-services",
      agency: "Homeless Services",
      mandate_id: "66056-006",
    },
  }, "2026-08-07");
  const exactRows = exact.transformRows(lookup);
  assert.equal(exactRows.length, 1);
  assert.equal(exactRows[0].obligation_id, "66056-006");
  assert.match(exactRows[0].duty_text, /renegotiate existing shelter contracts/i);
  // Exact id is not free-text matching on duty language.
  const miss = compileSub({
    lens: "mandates",
    filter: {
      agency_id: "homeless-services",
      mandate_id: "does-not-exist-999",
    },
  }, "2026-08-07");
  assert.deepEqual(miss.transformRows(lookup), []);
});

test("obligationDigestRowsForAgency labels past dates without compliance", () => {
  const lookup = {
    by_agency: {
      [PARKS]: {
        agency_id: PARKS,
        obligations: [{
          obligation_id: "x-001",
          matter_id: "x",
          agency_id: PARKS,
          agency_name: "Parks and Recreation",
          duty_text: "File a report",
          deliverable_type: "report",
          deadline: { computed_date: "2020-01-01", text: null },
          recurrence: "one-time",
          citation: "§1",
          source: { legistar_url: "https://example.test/law" },
          certification: { status: "auto_certified" },
          alert_id: "obligation:x-001:2020-01-01",
        }],
      },
    },
  };
  const rows = obligationDigestRowsForAgency(lookup, PARKS, { todayISO: "2026-08-07", pastDays: 4000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deadline_band, "past_date");
  assert.equal(rows[0].compliance_verdict, null);
});

test("follow href is free obligations watch", () => {
  const href = agencyObligationsFollowHref(PARKS);
  assert.match(href, /\/following/);
  assert.match(href, /lens=mandates/);
  assert.match(href, /agency_id/);
});

test("follow href can narrow to one exact mandate_id", () => {
  const href = agencyObligationsFollowHref("homeless-services", { mandateId: "66056-006" });
  assert.match(href, /lens=mandates/);
  assert.match(href, /mandate_id/);
  const filter = JSON.parse(decodeURIComponent(new URL(href).searchParams.get("filter")));
  assert.equal(filter.mandate_id, "66056-006");
  assert.equal(filter.agency_id, "homeless-services");
});
