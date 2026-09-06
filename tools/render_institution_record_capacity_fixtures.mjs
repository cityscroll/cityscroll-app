#!/usr/bin/env node
// Renders the real production record page for the retained contracts a
// capacity-labelled profile row links to, and prints {path: html} JSON to
// stdout. Used only by tools/capture_institution_record_capacity.py.
//
// `/procurements/:id` is served by the deployed runtime, not materialized into
// the static tree, so a browser capture of the profile → full page → Back
// journey has nothing to navigate to locally. This renders those pages with
// the real renderProcurementDocument() -- the exact function the production
// route calls -- over the real committed read-model rows, and the capture
// serves the result at the same paths the profile's own links address. Nothing
// here is a served route or a build artifact, and no production module is
// changed by running it.

import { readFileSync } from "node:fs";

import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { civicInstitutionIdForPartyValue } from "../site/civic_institution_party_spellings.mjs";
import { SBS_MASTER_SOURCE_REF } from "../site/civic_institution_development_specimens.mjs";

const browse = JSON.parse(readFileSync(new URL("../site/data/procurement_browse_rows.json", import.meta.url), "utf8"));

/**
 * The retained rows a reviewed party mapping resolves — the same selection the
 * profile builder makes, so the pages rendered here are exactly the records the
 * capacity rows link to.
 */
const partyRows = (browse.rows || []).filter((row) => (
  civicInstitutionIdForPartyValue("vendor_name", row?.vendor_name)
  && civicInstitutionIdForPartyValue("agency_name", row?.agency_name)
));

/**
 * The retained observation for one row. A row that names the PASSPort master
 * observation gets it; every other row cites its own retained reference, which
 * is what the role mapping reads.
 */
function observationsFor(row) {
  const refs = Array.isArray(row.source_observation_refs) ? row.source_observation_refs : [];
  if (!refs.includes(SBS_MASTER_SOURCE_REF)) return [];
  return [{
    source_observation_ref: SBS_MASTER_SOURCE_REF,
    source_system: "passport_public_contracts",
    ingested_at: row.start_date,
    snapshot: {
      epin: row.pin,
      agency: row.agency_name,
      vendor: row.vendor_name,
      title: row.short_title,
    },
  }];
}

const pages = {};
for (const row of partyRows) {
  const href = row.canonical_href || `/procurements/${encodeURIComponent(row.procurement_id)}`;
  const html = renderProcurementDocument(row, observationsFor(row), {
    currentHref: href,
    today: String(browse.generated_at || "").slice(0, 10) || null,
  });
  if (html) pages[href] = html;
}

process.stdout.write(`${JSON.stringify({ generated_at: browse.generated_at || null, pages }, null, 2)}\n`);
