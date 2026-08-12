import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgencyVendorRollups } from "../site/agency_vendor_rollup.mjs";
import { renderAgencyTopVendorsSection } from "../site/agency_constellation_sections/vendors.mjs";
import { buildAgencyConstellationView, renderAgencyConstellationDocument } from "../site/agency_constellation.mjs";

test("12-month agency vendor rollup groups normalized identities and applies award honesty rules", () => {
  const rollup = buildAgencyVendorRollups([
    { agency_name: "Police Department", type_of_notice_description: "Award", start_date: "2026-08-11", vendor_name: "General Dynamics Information Technology Inc", contract_amount: "100" },
    { agency_name: "POLICE DEPARTMENT", type_of_notice_description: "Award", start_date: "2026-08-10", vendor_name: "GENERAL DYNAMICS INFORMATION TECHNOLOGY, INC.", contract_amount: "50" },
    { agency_name: "Police Department", type_of_notice_description: "Award", start_date: "2025-08-11", vendor_name: "Old Vendor LLC", contract_amount: "999" },
    { agency_name: "Police Department", type_of_notice_description: "Solicitation", start_date: "2026-08-09", vendor_name: "Solicitation Vendor", contract_amount: "200" },
    { agency_name: "Police Department", type_of_notice_description: "Award", start_date: "2026-08-09", vendor_name: "Over Cap Corp", contract_amount: "10000000000" },
    { agency_name: "Police Department", type_of_notice_description: "Award", start_date: "2026-08-09", vendor_name: "Missing Amount Corp", contract_amount: null },
  ], { asOf: "2026-08-12", limit: 8 });

  assert.equal(rollup.schema, "cityscroll.agency_vendor_rollup.v1");
  assert.equal(rollup.window_start, "2025-08-12");
  const rows = rollup.by_id["police-department"];
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    subject_ref: "vendor:stem:GENERAL%20DYNAMICS%20INFORMATION%20TECHNOLOGY",
    label: "General Dynamics Information Technology Inc",
    award_count: 2,
    award_total: 150,
    href: "/vendors/GENERAL%20DYNAMICS%20INFORMATION%20TECHNOLOGY/",
  });
});

test("top-vendor section renders bounded rollup rows as diamond entity nodes", () => {
  const html = renderAgencyTopVendorsSection({
    id: "vendors",
    label: "Top vendors by award $ (last 12 mo)",
    status: "matched",
    window_start: "2025-08-12",
    as_of: "2026-08-12",
    view_all_href: "/browse/contracts/",
    items: [{
      subject_ref: "vendor:stem:GENERAL%20DYNAMICS%20INFORMATION%20TECHNOLOGY",
      label: "General Dynamics Information Technology Inc",
      confidence: "strong",
      relation: "top_vendor_by_award_12mo",
      award_count: 2,
      award_total: 150,
    }],
  });
  assert.match(html, /Top vendors by award \$ \(last 12 mo\)/);
  assert.match(html, /href="\/vendors\/GENERAL%20DYNAMICS%20INFORMATION%20TECHNOLOGY\/"/);
  assert.match(html, /aria-hidden="true">◆<\/span>/);
  assert.match(html, /\$150/);
  assert.match(html, /Open all agency contracts/);
});

test("vendor category composes into the agency model and ordered document", () => {
  const rollup = buildAgencyVendorRollups([
    { agency_name: "Police Department", type_of_notice_description: "Award", start_date: "2026-08-11", vendor_name: "General Dynamics Information Technology Inc", contract_amount: "150" },
  ], { asOf: "2026-08-12" });
  const view = buildAgencyConstellationView("police-department", { vendor_rollups: rollup });
  const vendorCategory = view.categories.find((category) => category.id === "vendors");
  assert.equal(vendorCategory.status, "matched");
  assert.equal(vendorCategory.items[0].award_total, 150);
  const html = renderAgencyConstellationDocument(view);
  assert.ok(html.indexOf('data-agency-constellation-category="contracts"')
    < html.indexOf('data-agency-constellation-category="vendors"'));
  assert.match(html, /Top vendors by award \$ \(last 12 mo\)/);
  assert.match(html, /href="\/vendors\/GENERAL%20DYNAMICS%20INFORMATION%20TECHNOLOGY\/"/);
});
