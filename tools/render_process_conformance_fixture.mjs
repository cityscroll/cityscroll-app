#!/usr/bin/env node
/** Render the deterministic five-category Process Conformance visual fixture. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  MANDATE_CONFORMANCE_STYLE,
  OBSERVATION_STATUS,
  PROCESS_CONFORMANCE_METHOD,
  PROCESS_CONFORMANCE_SCHEMA,
  renderMandatesConformanceSection,
} from "../site/process_conformance.mjs";
import {
  buildMandateCategoryConformance,
  mergeMandateCategoryConformance,
} from "../site/mandate_category_conformance.mjs";

const output = process.argv[2];
if (!output) throw new Error("usage: node tools/render_process_conformance_fixture.mjs <output.html>");

const agency = "parks-and-recreation";
const asOf = "2026-08-12";
const law = (id) => `https://legistar.council.nyc.gov/LegislationDetail.aspx?ID=${id}`;
const base = {
  schema: PROCESS_CONFORMANCE_SCHEMA,
  method: PROCESS_CONFORMANCE_METHOD,
  agency_id: agency,
  agency_name: "Parks and Recreation",
  status: "matched",
  as_of: asOf,
  share_path: `/agencies/${agency}/#mandates-conformance`,
  counts: { total: 2, observed: 2, detectable: 2 },
  candidate_corpus: { size: 2, sources: ["rules", "reports"], sample: [] },
  items: [
    {
      mandate_id: "parks-rule",
      duty_text: "Adopt rules for permits in city parks.",
      deliverable_type: "rulemaking",
      citation: "Administrative Code § 18-142",
      source_href: law(101),
      observation: {
        status: OBSERVATION_STATUS.OBSERVED,
        label: "Appeared",
        expected_event: { kind: "rule_filing", label: "Rule filing", deadline_date: "2026-07-01" },
        observed_record: {
          label: "Rules for special event permits",
          href: "/notices/20260514002",
          when: "2026-05-18",
        },
      },
    },
    {
      mandate_id: "parks-report",
      duty_text: "Publish an annual report on park safety.",
      deliverable_type: "report",
      citation: "Administrative Code § 18-150",
      source_href: law(102),
      observation: {
        status: OBSERVATION_STATUS.OBSERVED,
        label: "Appeared",
        expected_event: { kind: "report_or_study", label: "Report publication", deadline_date: "2026-06-30" },
        observed_record: {
          label: "Annual park safety report",
          href: "/notices/20260630001",
          when: "2026-06-30",
        },
      },
    },
  ],
};

const categorySpecs = [
  ["meetings", "requires_public_hearing", "public_hearing", "Public meeting or hearing", "meeting:city-record:20260716009", "Dining Out NYC public hearing"],
  ["contracts", "implemented_by_contract", "procurement_contract", "Contract award or registration", "contract:CT1-846-20261234567", "Contract CT1-846-20261234567"],
  ["zoning", "requires_land_use_action", "land_use_action", "Land-use or zoning action", "project:2026M0001", "Park access and site plan review"],
];
const groups = categorySpecs.map(([category, edgeType, kind, expectedLabel, targetRef, targetLabel], index) => {
  const claimId = `mandate-${category}:parks-${category}:${targetRef}`;
  const inspectHref = `/agencies/${agency}/?claim=${encodeURIComponent(claimId)}`;
  return buildMandateCategoryConformance({
    category,
    edgeType,
    expectedKind: kind,
    expectedLabel,
    asOf,
    sourceAvailable: true,
    mandates: [{
      obligation_id: `parks-${category}`,
      duty_text: `${expectedLabel} for the covered parks program.`,
      deadline: { computed_date: `2026-0${index + 6}-30` },
      citation: `Administrative Code § 18-${160 + index}`,
      source: { legistar_url: law(103 + index) },
    }],
    edges: [{
      mandate_id: `parks-${category}`,
      edge: { type: edgeType, from: `mandate:parks-${category}`, to: targetRef },
      target: { subject_ref: targetRef, label: targetLabel, href: inspectHref, when: asOf },
      claim: {
        claim_id: claimId,
        inspect_href: inspectHref,
        how: { warrant_class: "exact" },
      },
    }],
  });
});
const view = mergeMandateCategoryConformance(base, groups, { asOf });
const section = renderMandatesConformanceSection(view);
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Mandate conformance categories · CityScroll</title>
  <link rel="stylesheet" href="/brand.css">
  <link rel="stylesheet" href="/civic-documents.css">
  <style>${MANDATE_CONFORMANCE_STYLE}
  .visual-fixture .mandates-conformance-scroll { block-size: auto; max-block-size: none; }
  </style>
</head>
<body>
  <header class="document-mast civic-object-mast"><div class="document-mast-inner">
    <a class="document-brand brand-lockup home" href="/">CityScroll</a>
  </div></header>
  <main class="node-document civic-object-document visual-fixture" data-node-document="1">
    <header class="node-hero civic-object-hero">
      <p class="node-kicker civic-object-kicker">Agency constellation</p>
      <h1>Parks and Recreation</h1>
      <p class="node-lede">Expected events and connected public records across mandate categories.</p>
    </header>
    ${section}
  </main>
</body>
</html>`;

const target = resolve(output);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, html);
console.log(`wrote ${output}`);
