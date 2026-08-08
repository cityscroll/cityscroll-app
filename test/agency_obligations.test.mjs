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
  assert.match(row.source.legistar_url, /LegislationDetail/);
  assert.doesNotMatch(JSON.stringify(row), /non-compliance|violat|missed filing/i);
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
  assert.match(view.follow_href, /lens=obligations/);
  assert.match(view.follow_href, /parks-and-recreation|Parks/);
});

test("committed lookup covers Parks with real backfill scale", () => {
  assert.ok(existsSync(LOOKUP_PATH), "agency_obligations_lookup.json must be committed");
  const lookup = JSON.parse(readFileSync(LOOKUP_PATH, "utf8"));
  assert.equal(lookup.schema, AGENCY_OBLIGATIONS_SCHEMA);
  assert.ok(lookup.summary.obligation_count >= 6000);
  assert.ok(lookup.by_agency[PARKS]?.count >= 20, "Parks must have real statutory duties");
  assert.equal(lookup.honesty.compliance.includes("not a compliance"), true);
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
  assert.equal(byId.obligations.method, AGENCY_OBLIGATIONS_METHOD);
  assert.equal(byId.obligations.certification_basis, AGENCY_OBLIGATIONS_CERTIFICATION);
  assert.match(byId.obligations.honesty, /statutory duties|deadlines from enacted/i);
  assert.ok(view.summary.matched_categories >= 5);

  const html = renderAgencyConstellationDocument(view);
  assert.match(html, /data-agency-constellation-category="obligations"/);
  assert.match(html, /Statutory obligations/);
  assert.match(html, /Source law/);
  assert.match(html, /Watch obligations and deadlines/);
  assert.match(html, /auto_certified_quote_verify_v1|auto-certified/);
  assert.doesNotMatch(html, /non-compliance|out of compliance|missed the deadline and failed/i);
  assert.doesNotMatch(html, /human review|clerk review|cairn/i);
});

test("compileSub obligations lens is a world-state transform, not SODA", () => {
  const q = compileSub({
    lens: "obligations",
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
  for (const row of rows.slice(0, 5)) {
    assert.ok(row.alert_id.startsWith("obligation:"));
    assert.equal(row.compliance_verdict, null);
    assert.match(row.honesty_note, /not a compliance/i);
  }
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
  assert.match(href, /lens=obligations/);
  assert.match(href, /agency_id/);
});
