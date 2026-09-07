#!/usr/bin/env node
/**
 * Render the real served output for the hearing-agenda project-group read-back.
 *
 * One agenda is shown by two different renderers, and the whole point of the
 * grouping is that they agree, so the evidence has to come from both of them as
 * they actually run:
 *
 *  - the notice document is the shared shell with the edge body that
 *    `site/pages_edge.mjs` produces for `/notices/:id/`, which is what a reader
 *    sees before any script runs;
 *  - the client-rendered outcome list is the same agenda handed to the shipped
 *    browser module through the read model's `/meeting-outcomes` payload.
 *
 * The agenda content in both is the committed retained record: the notice's own
 * entry in `site/data/meeting_outcomes_snapshot.json`, and the accepted project
 * assignments in `site/data/council_land_matter_links.json`. The read-model
 * payload is projected from that same snapshot entry rather than fetched, so the
 * capture reads one source through two renderers and nothing crosses to a
 * publisher. The notice's own City Record chrome (agency, section, title) is not
 * in this repository's committed data; a minimal row carrying the retained
 * event's own name and date stands in for it, and no assertion in the capture
 * depends on it.
 *
 * Positive and negative examples are both rendered: an agenda whose matters
 * group into several projects, an agenda whose one matter groups into one
 * project, and an agenda the accepted bridge joined nothing on.
 *
 * Output is untracked build evidence.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgendaProjectGroups } from "../site/agenda_project_groups.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, ".artifacts/agenda-project-groups/fixtures");
const SNAPSHOT_PATH = join(ROOT, "site/data/meeting_outcomes_snapshot.json");
const LINKS_PATH = join(ROOT, "site/data/council_land_matter_links.json");
const MATTER_LOOKUP_PATH = join(ROOT, "site/data/legislative_matter_lookup.json");

const NOTICE_CASES = [
  {
    id: "agenda-four-projects",
    request_id: "20260512045",
    expectation: "groups its Council matters into the land use projects the accepted bridge joined them to, and still lists every original agenda item",
  },
  {
    id: "agenda-one-project",
    request_id: "20260707022",
    expectation: "reads in the singular when the agenda's matters all belong to one project",
  },
  {
    id: "agenda-no-project",
    request_id: "20260428021",
    expectation: "renders no project group at all, because the bridge joined none of its matters",
  },
];

/** The exact edge body `/notices/:id/` returns, produced by the shipped renderer. */
function edgeNoticeMarkup(row, requestId, meetingOutcome) {
  const script = 'import { renderEdgeNotice } from "./site/pages_edge.mjs";'
    + `process.stdout.write(renderEdgeNotice(${JSON.stringify(row)}, ${JSON.stringify(requestId)}, `
    + `${JSON.stringify(meetingOutcome)}));`;
  return execFileSync("node", ["--input-type=module", "--eval", script], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The shared shell, with the Notice pane active and the edge body in place. */
function noticeDocument(markup) {
  const html = readFileSync(join(ROOT, "site/index.html"), "utf8")
    .replace('class="tabpane active"', 'class="tabpane"')
    .replace('id="tab-notice" class="tabpane"', 'id="tab-notice" class="tabpane active"');
  return html.replace(
    /<div id="noticeview" translate="no">[\s\S]*?<\/div>\s*<!-- permalink views/,
    `<div id="noticeview" translate="no">${markup}</div><!-- permalink views`,
  );
}

/** The published matter history a grouped row links to, from the same handler. */
function matterDocument(matterId) {
  const script = 'import edge from "./site/pages_edge.mjs";'
    + 'import { readFileSync } from "node:fs";'
    + 'const lookup = JSON.parse(readFileSync("site/data/legislative_matter_lookup.json", "utf8"));'
    + "const env = { ASSETS: { async fetch(request) {"
    + '  if (new URL(request.url).pathname === "/data/legislative_matter_lookup.json") return Response.json(lookup);'
    + '  return new Response("missing", { status: 404 });'
    + "} } };"
    + `const response = await edge.fetch(new Request("https://cityscroll.org/matters/${matterId}/"), env);`
    + 'if (response.status !== 200) throw new Error("matter " + response.status);'
    + "process.stdout.write(await response.text());";
  return execFileSync("node", ["--input-type=module", "--eval", script], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The read model's per-notice payload, projected from the same committed
 * snapshot entry the served notice reads. One agenda item per retained matter,
 * which is the shape `worker/src/lib/meeting_outcomes.mjs` materializes.
 */
function readModelPayload(record) {
  return {
    ok: true,
    generated_at: record.generated_at || null,
    source: "committed meeting-outcome snapshot",
    record: {
      request_id: record.request_id,
      join: { matched: true, method: "exact_date_body_tokens", reason: null },
      notice: { request_id: record.request_id },
      council_event: {
        event_id: record.event.event_id,
        body_name: record.event.name,
        event_date: record.event.date,
        start_time: record.event.date,
        event_url: record.event.url,
        documents: record.event.documents || [],
      },
      agenda_items: (record.matters || []).map((matter, index) => ({
        agenda_number: String(index + 1),
        title: matter.title,
        matters: [{
          matter_id: matter.matter_id,
          matter_file: matter.matter_file,
          matter_url: matter.matter_url,
          title: matter.title,
          outcome: matter.outcome,
          documents: matter.documents || [],
          votes: matter.votes,
        }],
      })),
    },
  };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const links = JSON.parse(readFileSync(LINKS_PATH, "utf8"));
  const matterLookup = JSON.parse(readFileSync(MATTER_LOOKUP_PATH, "utf8"));
  const manifest = {
    generated_for: "hearing agenda project-group read-back",
    data_vintage: {
      council_land_matter_links_generated_at: links.generated_at,
      meeting_outcomes_snapshot_generated_at: snapshot.generated_at,
      legislative_matter_lookup_generated_at: matterLookup.generated_at,
    },
    notices: [],
    matters: [],
  };

  const matterIds = new Set();
  for (const scenario of NOTICE_CASES) {
    const record = snapshot.by_notice?.[scenario.request_id];
    if (!record || record.snapshot_state !== "present") {
      throw new Error(`notice ${scenario.request_id} is not a present snapshot record`);
    }
    const row = {
      request_id: scenario.request_id,
      short_title: `${record.event.name} — ${record.event.date}`,
      agency_name: "City Council",
      section_name: "Public Hearings and Meetings",
      type_of_notice_description: "Public Hearings",
      start_date: record.event.date,
      event_date: record.event.date,
    };
    const document = noticeDocument(edgeNoticeMarkup(row, scenario.request_id, record));
    const file = join(OUT_DIR, `${scenario.id}.html`);
    writeFileSync(file, document);
    const payloadFile = join(OUT_DIR, `${scenario.id}.read-model.json`);
    writeFileSync(payloadFile, `${JSON.stringify(readModelPayload(record), null, 2)}\n`);
    const view = buildAgendaProjectGroups(record.matters);
    for (const group of view?.groups || []) {
      for (const matter of group.matters) {
        if (matter.availability === "local_history") matterIds.add(matter.matter_id);
      }
    }
    manifest.notices.push({
      ...scenario,
      route: `/notices/${scenario.request_id}/`,
      file: file.slice(ROOT.length + 1),
      read_model_file: payloadFile.slice(ROOT.length + 1),
      event_id: record.event.event_id,
      event_date: record.event.date,
      agenda_matter_ids: record.matters.map((matter) => matter.matter_id),
      expected: view
        ? {
          group_count: view.group_count,
          linked_matter_count: view.linked_matter_count,
          unlinked_matter_count: view.unlinked_matter_count,
          agenda_matter_count: view.agenda_matter_count,
          groups: view.groups.map((group) => ({
            project_id: group.project_id,
            matter_ids: group.matters.map((matter) => matter.matter_id),
          })),
        }
        : null,
    });
    const groups = view ? view.group_count : 0;
    console.log(`wrote ${scenario.id} -> ${groups} project group(s)`);
  }

  // Only the destinations a grouped row actually offers, so the journey step
  // navigates to a page the published generation really carries.
  for (const matterId of [...matterIds].sort()) {
    const file = join(OUT_DIR, `matter-${matterId}.html`);
    writeFileSync(file, matterDocument(matterId));
    manifest.matters.push({
      matter_id: matterId,
      route: `/matters/${matterId}/`,
      file: file.slice(ROOT.length + 1),
    });
  }
  console.log(`wrote ${manifest.matters.length} matter document(s)`);

  writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

main();
