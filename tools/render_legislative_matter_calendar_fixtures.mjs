#!/usr/bin/env node
/**
 * Render real `/matters/:id/` route HTML for CBICS-09 evidence capture.
 *
 * Drives the actual edge request handler (`site/pages_edge.mjs`) against four
 * committed-shape `cityscroll.legislative_matter_lookup.v1` fixtures — a
 * concentrated cluster, a dispersed history, a sparse history (the shape of
 * the one real committed matter today), and a concentrated cluster with no
 * proven vote or action — and writes each response body to disk so
 * `tools/capture_legislative_matter_calendar_evidence.py` can screenshot and
 * axe-scan it. No public route or fixture data ships; output is untracked.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import edgeWorker from "../site/pages_edge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/screenshots/legislative-matter-calendar/fixtures");
const TODAY = "2026-06-01";

function appearance({ requestId, eventId, date, name, bodyId = null, actions = [], outcome = null, votes = null, documents = [] }) {
  return {
    request_id: requestId,
    event: {
      event_id: eventId,
      name,
      date,
      url: `https://nyc.legistar.com/MeetingDetail.aspx?LEGID=${eventId}`,
      body_id: bodyId,
      documents,
    },
    actions,
    outcome,
    votes,
  };
}

function matter(id, { matterFile, title, appearances }) {
  return {
    matter_id: id,
    matter_file: matterFile,
    title,
    matter_type: "Land Use Application",
    matter_status: "In Committee",
    matter_href: `https://nyc.legistar.com/Gateway.aspx?M=L&ID=${id}`,
    appearances,
  };
}

const SCENARIOS = [
  {
    id: "concentrated",
    matterId: "78601",
    label: matter("78601", {
      matterFile: "LU 0091-2026",
      title: "Concentrated hearing cluster — 210 East Fordham Road Rezoning, Bronx",
      appearances: [
        appearance({
          requestId: "20260601001", eventId: "31001", date: "2026-03-04",
          name: "Subcommittee on Zoning and Franchises",
        }),
        appearance({
          requestId: "20260601002", eventId: "31002", date: "2026-03-11",
          name: "Committee on Land Use", bodyId: "34",
          actions: ["Hearing Held by Committee", "Approved by Committee"],
          outcome: "Approved by Committee",
          votes: {
            result: "Approved", yes: 8, no: 0, abstain: 1,
            by_person: [
              { person_id: "p1", person_name: "Farah N. Louis", vote_bucket: "Affirmative" },
              { person_id: "p2", person_name: "Kevin C. Riley", vote_bucket: "Affirmative" },
            ],
          },
        }),
        appearance({
          requestId: "20260601003", eventId: "31003", date: "2026-03-18",
          name: "Full Council Stated Meeting",
          actions: ["Approved by Council"], outcome: "Approved by Council",
        }),
      ],
    }),
  },
  {
    id: "dispersed",
    matterId: "78602",
    label: matter("78602", {
      matterFile: "LU 0092-2026",
      title: "Dispersed hearing history — Bay Ridge Waterfront Access Plan",
      appearances: [
        appearance({ requestId: "20260601011", eventId: "31011", date: "2026-01-06", name: "Subcommittee on Zoning and Franchises" }),
        appearance({ requestId: "20260601012", eventId: "31012", date: "2026-05-12", name: "Committee on Land Use" }),
        appearance({ requestId: "20260601013", eventId: "31013", date: "2026-09-22", name: "Full Council Stated Meeting" }),
      ],
    }),
  },
  {
    id: "sparse",
    matterId: "78603",
    label: matter("78603", {
      matterFile: "LU 0056-2026",
      title: "Sparse hearing history — 147-14 Northern Boulevard Rezoning, Queens",
      appearances: [
        appearance({ requestId: "20260408025", eventId: "22342", date: "2026-04-22", name: "Subcommittee on Zoning and Franchises", outcome: "Laid Over by Subcommittee" }),
        appearance({ requestId: "20260428021", eventId: "22375", date: "2026-05-19", name: "Subcommittee on Zoning and Franchises", outcome: "Approved by Subcommittee" }),
      ],
    }),
  },
  {
    id: "no-decision",
    matterId: "78604",
    label: matter("78604", {
      matterFile: "LU 0093-2026",
      title: "Concentrated hearings, no retained decision — Sunnyside Rail Yards Framework",
      appearances: [
        appearance({ requestId: "20260601021", eventId: "31021", date: "2026-03-05", name: "Subcommittee on Zoning and Franchises" }),
        appearance({ requestId: "20260601022", eventId: "31022", date: "2026-03-12", name: "Subcommittee on Zoning and Franchises" }),
        appearance({ requestId: "20260601023", eventId: "31023", date: "2026-03-26", name: "Subcommittee on Zoning and Franchises" }),
      ],
    }),
  },
];

function lookupFor(scenario) {
  return {
    schema: "cityscroll.legislative_matter_lookup.v1",
    generated_at: `${TODAY}T00:00:00.000Z`,
    matters: { [scenario.matterId]: scenario.label },
  };
}

function envFor(lookup) {
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
  const manifest = [];
  for (const scenario of SCENARIOS) {
    const lookup = lookupFor(scenario);
    const route = `/matters/${scenario.matterId}/`;
    const request = new Request(`https://cityscroll.org${route}`);
    const response = await edgeWorker.fetch(request, envFor(lookup));
    if (response.status !== 200) {
      throw new Error(`fixture ${scenario.id} (${route}) returned ${response.status}`);
    }
    // Rewrite root-relative asset links so the fixture renders correctly when
    // served locally from the repo root by the capture script's static
    // server (Cloudflare Pages serves `site/` itself as the site root).
    const html = (await response.text())
      .replace('href="/brand.css"', 'href="/site/brand.css"')
      .replace('href="/civic-documents.css"', 'href="/site/civic-documents.css"')
      .replace('href="/compact_calendar.css"', 'href="/site/compact_calendar.css"');
    const outPath = join(OUT_DIR, `${scenario.id}.html`);
    writeFileSync(outPath, html);
    manifest.push({
      id: scenario.id,
      matter_id: scenario.matterId,
      route,
      today: TODAY,
      rendered_calendar: html.includes("compact-month"),
      file: outPath.slice(ROOT.length + 1),
    });
    console.log(`wrote ${scenario.id} -> ${outPath} (calendar rendered: ${html.includes("compact-month")})`);
  }
  writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

main();
