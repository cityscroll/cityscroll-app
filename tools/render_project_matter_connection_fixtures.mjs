#!/usr/bin/env node
/**
 * Render the real served output for the project/matter connection read-back.
 *
 * Two surfaces answer the same connection from opposite ends, so the evidence
 * has to come from both of them as they actually run:
 *
 *  - `/matters/:id/` is produced by the edge request handler in
 *    `site/pages_edge.mjs` against the committed matter lookup. The bodies
 *    written here are that handler's own responses, not a re-render.
 *  - the land project detail is client-rendered from the payload the Worker
 *    read model returns, so what is written here is that payload, produced by
 *    `worker/src/project_connections.mjs`. The capture script then serves the
 *    built site and lets the real browser module render it.
 *
 * Positive and negative examples are both rendered: a project with three
 * matters, a project with one, a matter whose title resembles a project it does
 * not join, and a project whose source carries no application number.
 *
 * Output is untracked build evidence.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import edgeWorker from "../site/pages_edge.mjs";
import { attachProjectConnections } from "../worker/src/project_connections.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, ".artifacts/project-matter-connections/fixtures");
const MATTER_LOOKUP = join(ROOT, "site/data/legislative_matter_lookup.json");
const LINKS = join(ROOT, "site/data/council_land_matter_links.json");
const ZAP = join(ROOT, "site/data/zap_projects_warehouse_lookup.json");
// The matter document is a pure function of its arguments; the edge worker is
// the boundary that reads a day. Pinning it keeps this evidence reproducible.
const TODAY = "2026-09-06";

const MATTER_CASES = [
  {
    id: "matter-connected-companions",
    matter_id: "78872",
    expectation: "links back to its land use project and to its two companion matters",
  },
  {
    id: "matter-companion",
    matter_id: "78873",
    expectation: "is the companion the first matter links to, and returns to the same project",
  },
  {
    id: "matter-connected-single",
    matter_id: "79200",
    expectation: "links back to its land use project and states that no companion matter shares the application",
  },
  {
    id: "matter-resembling-title",
    matter_id: "78875",
    expectation: "renders no land use project section although its title names the same development",
  },
];

const PROJECT_CASES = [
  {
    id: "project-connected",
    project_id: "2024K0358",
    expectation: "lists the three Council matters that carry this project's retained application numbers",
  },
  {
    id: "project-no-application-number",
    project_id: "2026K0443",
    expectation: "lists no Council matter because the project source carries no application number",
  },
];

function assetEnv(lookup) {
  return {
    ASSETS: {
      async fetch(request) {
        if (new URL(request.url).pathname === "/data/legislative_matter_lookup.json") {
          return Response.json(lookup);
        }
        return new Response("missing", { status: 404 });
      },
    },
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const lookup = JSON.parse(readFileSync(MATTER_LOOKUP, "utf8"));
  const links = JSON.parse(readFileSync(LINKS, "utf8"));
  const zap = JSON.parse(readFileSync(ZAP, "utf8"));
  const manifest = {
    generated_for: "project and matter connection read-back",
    data_vintage: {
      council_land_matter_links_generated_at: links.generated_at,
      legislative_matter_lookup_generated_at: lookup.generated_at,
      zap_projects_warehouse_lookup_materialized_at: zap.materialized_at || null,
    },
    today: TODAY,
    matters: [],
    projects: [],
  };

  for (const scenario of MATTER_CASES) {
    const route = `/matters/${scenario.matter_id}/`;
    const response = await edgeWorker.fetch(
      new Request(`https://cityscroll.org${route}`),
      assetEnv(lookup),
    );
    if (response.status !== 200) throw new Error(`${route} returned ${response.status}`);
    const html = (await response.text())
      .replaceAll('href="/brand.css"', 'href="/site/brand.css"')
      .replaceAll('href="/civic-documents.css"', 'href="/site/civic-documents.css"')
      .replaceAll('href="/compact_calendar.css"', 'href="/site/compact_calendar.css"');
    const file = join(OUT_DIR, `${scenario.id}.html`);
    writeFileSync(file, html);
    manifest.matters.push({
      ...scenario,
      route,
      file: file.slice(ROOT.length + 1),
      land_project_section_rendered: html.includes('id="matter-land-project"'),
    });
    console.log(`wrote ${scenario.id} -> ${route}`);
  }

  for (const scenario of PROJECT_CASES) {
    const row = zap.rows.find((entry) => entry.project_id === scenario.project_id) || {};
    const record = await attachProjectConnections({
      project_id: scenario.project_id,
      project_name: row.project_name || null,
      primary_applicant: row.primary_applicant || null,
      join: { matched: true, method: "exact_project_id" },
      open_data: row,
      dispositions: [],
      documents: [],
      milestones: [],
      city_record_notices: [],
      approved_actions: [],
    });
    const group = record.project_connections.groups.find((entry) => entry.id === "council_matters");
    const file = join(OUT_DIR, `${scenario.id}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    manifest.projects.push({
      ...scenario,
      route: `/browse/zoning/#land/${scenario.project_id}`,
      file: file.slice(ROOT.length + 1),
      council_matter_status: group.status,
      council_matter_count: group.items.length,
      council_matter_ids: group.items.map((item) => item.ref),
    });
    console.log(`wrote ${scenario.id} -> ${group.status} (${group.items.length} matters)`);
  }

  writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

main();
