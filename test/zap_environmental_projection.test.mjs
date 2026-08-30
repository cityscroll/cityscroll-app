/**
 * Cutoff-aware ZAP CEQR / environmental projection.
 *
 *   node --test test/zap_environmental_projection.test.mjs
 */
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  overlayZapEnvironmentalSourceFields,
  projectZapEnvironmentalFields,
  stampZapEnvironmentalProjection,
  summarizeZapEnvironmentalProjection,
  zapEnvironmentalProjectionFindings,
  ZAP_ENVIRONMENTAL_PROJECTION_SCHEMA,
  ZAP_ENVIRONMENTAL_STATUS_GAP,
} from "../warehouse/lib/zap_environmental_projection.mjs";
import { buildMaterializationDoc, rowToSodaShape } from "../warehouse/lib/zap_lookup.mjs";
import { shapeZapLookupRow } from "../worker/src/lib/zap_projects_lookup_kv.mjs";
import {
  lookupZapFromWarehouseMaterialization,
  resetZapWarehouseIndexCache,
} from "../worker/src/lib/zap_warehouse_lookup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOLD = join(ROOT, "test/fixtures/zap_environmental_projection/gold.v1.json");
const LOOKUP = join(ROOT, "site/data/zap_projects_warehouse_lookup.json");
const LOOKUP_WORKER = join(ROOT, "worker/src/data/zap_projects_warehouse_lookup.json");
const LAND_DEFAULT = join(ROOT, "site/data/land_default_ulurp.json");
const RECEIPT = join(
  ROOT,
  "warehouse/receipts/proof/zap_environmental_projection_latest.json",
);

const gold = JSON.parse(readFileSync(GOLD, "utf8"));

function projectCase(entry) {
  return projectZapEnvironmentalFields(entry.row, {
    asOf: gold.as_of,
    cutoff: entry.cutoff || gold.cutoff,
  });
}

describe("ZAP environmental projection gold", () => {
  it("covers a source-backed project and each supported field", () => {
    const positive = gold.cases.find((entry) => entry.id === "positive-source-backed");
    const fields = projectCase(positive).fields;
    for (const name of [
      "ceqr_number",
      "ceqr_type",
      "ceqr_lead_agency",
      "environmental_review_type",
      "environmental_milestone",
      "environmental_milestone_date",
    ]) {
      assert.equal(fields[name].presence, "present", name);
      assert.ok(fields[name].value, name);
      assert.ok(fields[name].source_field, name);
    }
    const projection = projectCase(positive);
    assert.equal(projection.source_dataset_id, "hgx4-8ukb");
    assert.equal(projection.source_record_id, "2024K0240");
    assert.equal(projection.as_of, gold.as_of);
  });

  for (const entry of gold.cases) {
    it(`fixture ${entry.id}`, () => {
      const projection = projectCase(entry);
      assert.equal(projection.schema, ZAP_ENVIRONMENTAL_PROJECTION_SCHEMA);
      assert.equal(projection.source_record_id, entry.row.project_id);
      for (const [field, expected] of Object.entries(entry.expect)) {
        const cell = projection.fields[field];
        assert.ok(cell, field);
        assert.equal(cell.presence, expected.presence, `${entry.id}.${field}.presence`);
        assert.equal(cell.value, expected.value ?? null, `${entry.id}.${field}.value`);
        if (expected.source_field) {
          assert.equal(cell.source_field, expected.source_field, `${entry.id}.${field}.source_field`);
        }
      }
    });
  }

  it("does not invent environmental_status and records the source gap", () => {
    const projection = projectCase(gold.cases[0]);
    assert.equal(projection.fields.environmental_status.presence, "source_field_absent");
    assert.equal(projection.fields.environmental_status.value, null);
    assert.equal(projection.fields.environmental_status.gap, ZAP_ENVIRONMENTAL_STATUS_GAP);
  });
});

describe("ZAP environmental projection invariants", () => {
  it("never fills CEQR from a land-use milestone or action code", () => {
    const projection = projectZapEnvironmentalFields({
      project_id: "NOINFER",
      actions: "UK; ZM; ZR; EAS",
      current_milestone: "EAS - Community Board Referral",
      project_name: "26DCP139X rezoning",
    }, { asOf: gold.as_of, cutoff: gold.cutoff });
    assert.equal(projection.fields.ceqr_number.presence, "title_only");
    assert.equal(projection.fields.ceqr_number.value, null);
    assert.equal(projection.fields.environmental_review_type.value, null);
  });

  it("overlay copies only environmental source columns", () => {
    const base = {
      project_id: "2025K0305",
      project_name: "Westshore LSGD Mapping Actions",
      actions: "MM",
      current_milestone: "MM - Review Filed Land Use Application",
    };
    const merged = overlayZapEnvironmentalSourceFields(base, {
      ceqr_number: "26DCP046K",
      actions: "ZM",
      project_name: "should not win",
    });
    assert.equal(merged.project_name, "Westshore LSGD Mapping Actions");
    assert.equal(merged.actions, "MM");
    assert.equal(merged.ceqr_number, "26DCP046K");
  });

  it("row shaping keeps existing keys and stamps provenance", () => {
    const shaped = rowToSodaShape({
      project_id: "2024K0240",
      borough: "Brooklyn",
      cc_district: "33",
      actions: "ZM; ZR",
      ceqr_number: "26DCP046K",
      ceqr_leadagency: "DCP",
      eas_eis: "EAS",
    }, { asOf: gold.as_of, cutoff: gold.cutoff });
    assert.equal(shaped.project_id, "2024K0240");
    assert.equal(shaped.cc_district, "33");
    assert.equal(shaped.actions, "ZM; ZR");
    assert.equal(shaped.ceqr_number, "26DCP046K");
    assert.equal(shaped.ceqr_lead_agency, "DCP");
    assert.equal(shaped.environmental_review_type, "EAS");
    assert.equal(shaped.environmental_status, null);
    assert.equal(shaped.environmental_projection.fields.ceqr_number.source_field, "ceqr_number");
  });

  it("worker lookup shaping matches the warehouse row contract", () => {
    const shaped = shapeZapLookupRow({
      project_id: "2022M0258",
      ceqr_number: "22HPD059M",
      ceqr_type: "Type I",
      ceqr_leadagency: "HPD",
    }, { asOf: gold.as_of });
    assert.equal(shaped.ceqr_number, "22HPD059M");
    assert.equal(shaped.ceqr_lead_agency, "HPD");
    assert.equal(shaped.environmental_review_type, null);
    assert.equal(typeof shaped.environmental_projection, "object");
  });

  it("warehouse index preserves the envelope object", () => {
    resetZapWarehouseIndexCache();
    const doc = buildMaterializationDoc([
      {
        project_id: "ENVOBJ1",
        project_name: "Envelope object",
        ceqr_number: "22HPD059M",
        ceqr_leadagency: "HPD",
      },
    ], { mode: "test", now: gold.as_of });
    const hit = lookupZapFromWarehouseMaterialization("ENVOBJ1", doc);
    assert.equal(hit.hit, true);
    assert.equal(typeof hit.row.environmental_projection, "object");
    assert.equal(hit.row.environmental_projection.schema, ZAP_ENVIRONMENTAL_PROJECTION_SCHEMA);
    assert.equal(hit.row.ceqr_lead_agency, "HPD");
    resetZapWarehouseIndexCache();
  });
});

describe("committed ZAP lookup + first-paint boundary", () => {
  it("twins carry environmental projection without dropping identity keys", () => {
    assert.ok(existsSync(LOOKUP));
    assert.ok(existsSync(LOOKUP_WORKER));
    const site = JSON.parse(readFileSync(LOOKUP, "utf8"));
    const worker = JSON.parse(readFileSync(LOOKUP_WORKER, "utf8"));
    assert.deepEqual(site.rows, worker.rows);
    assert.equal(zapEnvironmentalProjectionFindings(site).join("\n"), "");
    const unknown = site.rows.find((row) => row.project_id === "2025K0305");
    assert.ok(unknown, "2025K0305 remains in the lookup");
    assert.equal(unknown.actions, "MM");
    assert.equal(unknown.ulurp_numbers, "250308MMK");
    assert.equal(unknown.environmental_projection.fields.ceqr_number.presence, "absent");
    const positive = site.rows.find((row) => row.ceqr_number);
    assert.ok(positive, "at least one retained CEQR identifier");
    assert.equal(positive.environmental_projection.fields.ceqr_number.presence, "present");
  });

  it("keeps environmental depth off the Land default first-paint snapshot", () => {
    const land = JSON.parse(readFileSync(LAND_DEFAULT, "utf8"));
    assert.equal(land.count, 40);
    for (const project of land.projects || []) {
      assert.equal("environmental_projection" in project, false, project.project_id);
      assert.equal("ceqr_number" in project, false, project.project_id);
    }
    const landGzip = gzipSync(readFileSync(LAND_DEFAULT)).length;
    const lookupGzip = gzipSync(readFileSync(LOOKUP)).length;
    assert.ok(landGzip > 0);
    assert.ok(lookupGzip > 0);
    if (existsSync(RECEIPT)) {
      const receipt = JSON.parse(readFileSync(RECEIPT, "utf8"));
      assert.equal(receipt.schema, ZAP_ENVIRONMENTAL_PROJECTION_SCHEMA);
      assert.equal(receipt.first_paint.land_default_has_environmental_projection, false);
      assert.ok(receipt.first_paint.growth_pct <= receipt.first_paint.threshold_pct);
      assert.equal(summarizeZapEnvironmentalProjection(JSON.parse(readFileSync(LOOKUP, "utf8")).rows).counts.row_count, receipt.coverage.counts.row_count);
    }
  });
});
