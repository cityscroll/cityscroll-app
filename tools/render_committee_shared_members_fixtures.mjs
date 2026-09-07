#!/usr/bin/env node
/**
 * Render the real served output for the committee shared-membership read-back.
 *
 * `/committees/:id/` is produced by the edge request handler in
 * `site/pages_edge.mjs` against the committed committee graph and people
 * lookup. The bodies written here are that handler's own responses, not a
 * re-render, and they are laid out as the routes they answer so the capture can
 * walk between them the way a reader does.
 *
 * Positive and negative examples are both rendered: a subcommittee with
 * twenty-two linked committees, the linked committee that reports the same
 * connection back, one of the destinations, a committee whose roster is entirely
 * historical at this vintage, and a caucus. A failed asset read is rendered too,
 * because a document that cannot load its own graph must answer plainly rather
 * than paint half a section.
 *
 * Output is untracked build evidence.
 */

import { createReadStream, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import edgeWorker from "../site/pages_edge.mjs";
import { buildCommitteeSharedMembershipView } from "../site/committee_coservice.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "_site");
const OUT_DIR = join(ROOT, ".artifacts/committee-shared-members/fixtures");

const CONTENT_TYPES = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
}));

function assetsBinding({ failPaths = [] } = {}) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (failPaths.includes(url.pathname)) return new Response("unavailable", { status: 503 });
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const resolved = normalize(join(SITE, pathname));
      if (!resolved.startsWith(SITE) || !existsSync(resolved) || !statSync(resolved).isFile()) {
        return new Response("not found", { status: 404 });
      }
      const extension = resolved.slice(resolved.lastIndexOf("."));
      return new Response(readFileSync(resolved), {
        status: 200,
        headers: { "Content-Type": CONTENT_TYPES.get(extension) || "application/octet-stream" },
      });
    },
  };
}

const CASES = [
  {
    id: "committee-landmarks",
    route: "/committees/5309/",
    expectation: "lists the other committees its own members sit on, with the shared people behind each one",
  },
  {
    id: "committee-parks",
    route: "/committees/5106/",
    expectation: "reports the same connection back to the subcommittee, naming the same two members",
  },
  {
    id: "committee-finance",
    route: "/committees/11/",
    expectation: "is the destination a shared-committee link opens, and answers the same question from its own roster",
  },
  {
    id: "committee-historical-roster",
    route: "/committees/20/",
    expectation: "keeps its complete recorded roster and renders no connections section at this vintage",
  },
  {
    id: "committee-caucus",
    route: "/committees/5285/",
    expectation: "is a caucus, so it renders no committee-connection section at all",
  },
  {
    id: "official-marte",
    route: "/officials/7801/",
    expectation: "is the published record a shared-member link opens",
  },
  {
    id: "official-nurse",
    route: "/officials/7824/",
    expectation: "is the published record the reciprocal shared-member link opens",
  },
];

const FAILED_LOAD = {
  id: "committee-graph-unavailable",
  route: "/committees/5309/",
  failPaths: ["/data/committee_graph_lookup.json"],
  expectation: "answers plainly when its own graph asset cannot be read, painting no partial section",
};

/**
 * What the served page must show, taken from the projection rather than typed
 * into the capture. The committee snapshot is refreshed from the publisher, so
 * a population count written into a browser check becomes an outage the day the
 * source moves; the capture asserts the served DOM against this instead, and
 * records the numbers themselves as observed evidence.
 */
function expectationFor(graph, people, committeeId) {
  const view = buildCommitteeSharedMembershipView(graph, committeeId, {
    asOf: String(graph.generated_at || "").slice(0, 10) || null,
    people,
    limit: Number.MAX_SAFE_INTEGER,
  });
  if (view.state !== "matched") {
    return { state: view.state, committee_count: 0, rows: [] };
  }
  return {
    state: view.state,
    as_of: view.as_of,
    committee_count: view.committee_count,
    subject_member_count: view.subject_member_count,
    represented_officials: view.represented_official_count,
    excluded_caucus_bodies: view.excluded_caucus_body_count,
    rows: view.committees.map((row) => ({
      committee_id: row.committee_id,
      name: row.name,
      shared_member_count: row.shared_member_count,
      people: row.shared_members.map((member) => member.name).sort(),
      overlaps: row.shared_members.map((member) => [member.overlap_start, member.overlap_end]),
    })),
  };
}

function writeRoute(route, body, name = "index.html") {
  const directory = join(OUT_DIR, route.replace(/^\/+/, "").replace(/\/+$/, ""));
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, body);
  return file;
}

async function render(route, options = {}) {
  const request = new Request(`https://cityscroll.org${route}`, { method: "GET" });
  const response = await edgeWorker.fetch(request, { ASSETS: assetsBinding(options) });
  return { status: response.status, body: await response.text() };
}

async function main() {
  if (!existsSync(SITE)) {
    console.error("render_committee_shared_members_fixtures: _site is missing; run tools/prepare_functional_site.sh");
    process.exit(1);
  }
  const graph = JSON.parse(readFileSync(join(ROOT, "site/data/committee_graph_lookup.json"), "utf8"));
  const people = JSON.parse(readFileSync(join(ROOT, "site/data/person_hub_lookup.json"), "utf8"));
  const manifest = { generated_at: new Date().toISOString(), data_vintage: graph.generated_at, cases: [] };

  for (const testCase of CASES) {
    const { status, body } = await render(testCase.route);
    if (status !== 200) throw new Error(`${testCase.route} answered ${status}`);
    const file = writeRoute(testCase.route, body);
    const committeeId = testCase.route.match(/^\/committees\/(\d+)\/$/)?.[1] || null;
    manifest.cases.push({
      ...testCase,
      status,
      file: file.slice(ROOT.length + 1),
      ...(committeeId ? { expect: expectationFor(graph, people, committeeId) } : {}),
    });
  }

  const failed = await render(FAILED_LOAD.route, { failPaths: FAILED_LOAD.failPaths });
  const failedFile = writeRoute("/failed-load/committees/5309/", failed.body);
  manifest.cases.push({
    ...FAILED_LOAD,
    status: failed.status,
    route: "/failed-load/committees/5309/",
    served_route: FAILED_LOAD.route,
    file: failedFile.slice(ROOT.length + 1),
  });

  writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`rendered ${manifest.cases.length} committee shared-membership fixtures into ${OUT_DIR.slice(ROOT.length + 1)}`);
}

await main();
