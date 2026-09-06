#!/usr/bin/env node
/**
 * Render the retained Parks, DOT, and Services notices through the shipped
 * pursuit snapshot plus buyer-history comparison href.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buyerHistoryComparisonFromSolicitation } from "../site/buyer_history_pursuit_comparison.mjs";
import { buildPursuitSnapshot, renderPursuitSnapshotHtml } from "../site/procurement_pursuit_snapshot.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] || join(ROOT, ".artifacts/buyer-history-pursuit"));

const NOTICES = {
  parks: {
    request_id: "20260608045",
    agency_name: "Parks and Recreation",
    type_of_notice_description: "Solicitation",
    category_description: "Construction/Construction Services",
    selection_method_description: "Competitive Sealed Bids",
    short_title: "MG-40550-117MA Mannahatta Park Recon",
    due_date: "2026-07-10T10:30:00.000",
  },
  dot: {
    request_id: "20260720022",
    agency_name: "Transportation",
    type_of_notice_description: "Solicitation",
    category_description: "Construction Related Services",
    selection_method_description: "Competitive Sealed Proposals",
    short_title: "Resident Engineering Inspection Services for Component Rehabilitation of 9 Bridges",
    due_date: "2026-08-26T14:00:00.000",
  },
  services: {
    request_id: "20251118032",
    agency_name: "Investigation",
    type_of_notice_description: "Solicitation",
    category_description: "Services (other than human services)",
    selection_method_description: "M/WBE Noncompetitive Small Purchase",
    short_title: "OpenText eDOCS Support Renewal",
    due_date: "2025-12-04T14:00:00.000",
  },
};

mkdirSync(outDir, { recursive: true });
for (const [name, row] of Object.entries(NOTICES)) {
  const comparison = buyerHistoryComparisonFromSolicitation(row, { registration_fiscal_year: 2026 });
  const snapshot = buildPursuitSnapshot(row, {
    cityscroll_url: `/notices/${row.request_id}`,
    buyer_history_href: comparison.href,
  });
  const body = renderPursuitSnapshotHtml(snapshot);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${row.short_title}</title><link rel="stylesheet" href="/procurement_pursuit_snapshot.css"></head><body>${body}</body></html>\n`;
  writeFileSync(join(outDir, `${name}-${row.request_id}.html`), html);
}
console.log(`buyer history pursuit fixtures: ${outDir}`);
