import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

import {
  BROWSE_FACETS,
  BROWSE_GROUPS,
  buildBrowseLanding,
  buildBrowseView,
  browseActionTime,
  renderBrowseLanding,
  renderBrowseView,
} from "../site/browse_view.mjs";
import { BROWSE_CONCEPTS, buildBrowseConceptLanding, renderBrowseConceptLanding } from "../site/browse_concept_view.mjs";
import { forwardLegacyFragment } from "../site/legacy_hash_forward.mjs";
import edgeWorker, { edgeRequestKind, isMeetingDocumentHtml, renderEdgeNotice, browseRoute } from "../site/pages_edge.mjs";
import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";
import { encodeTraversalPath } from "../site/traversal_path.mjs";
import { primaryDocumentOutputs, sharedMeetingOutputs } from "../tools/build_primary_documents.mjs";
import { buildBrowseAliasDocument } from "../site/primary_document_view.mjs";
import { BROWSE_ROUTE_ALIASES } from "../site/browse_route_aliases.mjs";
import { handleStats } from "../worker/src/stats.mjs";
import { renderAgencyIndex } from "../tools/build_agency_documents.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

test("primary navigation is four real document links on every promoted shell", () => {
  for (const html of [read("../site/index.html"), read("../site/near-you/index.html"), read("../site/following/index.html")]) {
    assert.match(html, /aria-label="Primary"/);
    for (const route of ["/now/", "/near-you/", "/following/", "/browse/"]) {
      assert.match(html, new RegExp(`href="${route.replaceAll("/", "\\/")}"`));
    }
  }
  const root = read("../site/index.html");
  const routes = [
    ["contracts", "/browse/contracts/", "money"],
    ["people", "/browse/people/", "people"],
    ["land", "/browse/zoning/", "land"],
    ["rules", "/browse/rules/", "rules"],
    ["meetings", "/browse/meetings/", "meetings"],
    ["exams", "/browse/exams/", "exams"],
  ];
  assert.match(root, /class="browse-child-nav"/);
  assert.match(root, /Civic objects/);
  for (const [label, route, tab] of routes) {
    assert.match(root, new RegExp(`href="${route.replaceAll("/", "\\/")}"[^>]+data-tab="${tab}"`), `${label} keeps a canonical Browse destination`);
  }
  assert.match(root, /<section id="tab-exams" class="tabpane">[\s\S]*<div id="examsview">/);
  assert.doesNotMatch(root, /data-browse-stub="exams"|Coming soon/);
  assert.match(root, /Land/);
  assert.doesNotMatch(root, /href="\/browse\/places\//);
  assert.deepEqual(BROWSE_GROUPS.map((group) => group.label), [
    "Contracts",
    "People + organizations",
    "Land",
    "Rules",
    "Meetings",
    "Exams",
  ]);
  const peopleGroup = BROWSE_GROUPS.find((group) => group.id === "people-organizations");
  assert.equal(peopleGroup.children.find((child) => child.facet === "staffing").label, "Staffing");
  assert.deepEqual(peopleGroup.children.filter((child) => ["vendors", "committees"].includes(child.id)).map((child) => child.label), ["Vendors", "Committees"]);
  for (const [facet, config] of Object.entries(BROWSE_FACETS)) {
    const child = BROWSE_GROUPS.flatMap((group) => group.children).find((candidate) => candidate.facet === facet);
    assert.ok(child, `${facet} remains represented in the civic-object groups`);
    assert.equal(child.route || config.route, config.route, `${facet} keeps its existing destination`);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(BROWSE_CONCEPTS).map(([kind, config]) => [kind, config.route])), {
    people: "/browse/people/",
    places: "/browse/places/",
  });
});

test("Browse route matrix rejects retired and unknown facets instead of treating them as the home asset", () => {
  for (const [facet, config] of Object.entries(BROWSE_FACETS)) {
    assert.deepEqual(browseRoute(config.route), { kind: "facet", facet });
  }
  assert.equal(browseRoute("/browse/contracts/").kind, "facet");
  assert.deepEqual(browseRoute("/browse/land/"), { kind: "unknown", facet: "land" });
  assert.deepEqual(browseRoute("/browse/unknown/"), { kind: "unknown", facet: "unknown" });
  assert.deepEqual(browseRoute("/browse/"), { kind: "landing", facet: null });
  assert.deepEqual(browseRoute("/browse/people/"), { kind: "concept", concept: "people" });
  assert.deepEqual(browseRoute("/browse/places/"), { kind: "concept", concept: "places" });
  assert.deepEqual(browseRoute("/browse/exams/"), { kind: "object", object: "exams" });
});

test("canonical meeting routes resolve exact read-model rows and reject unknown ids", async () => {
  const cityRecordId = "meeting:city_record:20260713006";
  const communityBoardId = "meeting:community_board:https://cbbronx.cityofnewyork.us/cb6/event/transportation-health-committees-2/";
  const readModelOutput = sharedMeetingOutputs().find(([path]) => path.endsWith("shared_meeting_read_model.json"));
  assert.ok(readModelOutput, "the build must emit the shared meeting read model");
  const readModel = JSON.parse(readModelOutput[1]);
  assert.ok(readModel.rows.some((row) => row.meeting_id === cityRecordId), "City Record smoke meeting must be in the built read model");
  assert.ok(readModel.rows.some((row) => row.meeting_id === communityBoardId), "community-board smoke meeting must be in the built read model");

  const spaShell = `<!doctype html><html><head><title>CityScroll · track RFPs, rezonings, meetings</title></head><body><main id="app">Contracts</main></body></html>`;
  const requestedPaths = [];
  const env = {
    ASSETS: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        requestedPaths.push(path);
        if (path === "/data/shared_meeting_read_model.json") {
          return new Response(JSON.stringify(readModel), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(spaShell, { status: 200, headers: { "Content-Type": "text/html" } });
      },
    },
  };

  assert.equal(edgeRequestKind(`https://cityscroll.org/meetings/${encodeURIComponent(cityRecordId)}/`), "meeting");
  assert.equal(isMeetingDocumentHtml(spaShell, cityRecordId), false);
  assert.equal(
    isMeetingDocumentHtml(
      `<main data-civic-object-kind="meeting" data-meeting-id="${cityRecordId}">Meeting</main>`,
      cityRecordId,
    ),
    true,
  );
  assert.equal(
    isMeetingDocumentHtml(
      '<main data-civic-object-kind="meeting" data-meeting-id="meeting:community_board:https://example.test/a&amp;b">Meeting</main>',
      "meeting:community_board:https://example.test/a&b",
    ),
    true,
  );

  const missing = await edgeWorker.fetch(new Request("https://cityscroll.org/meetings/meeting%3Acity_record%3Aunknown/"), env);
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /track RFPs, rezonings, meetings|Contracts/);

  for (const meetingId of [cityRecordId, communityBoardId]) {
    const present = await edgeWorker.fetch(new Request(`https://cityscroll.org/meetings/${encodeURIComponent(meetingId)}/`), env);
    assert.equal(present.status, 200, meetingId);
    const presentBody = await present.text();
    assert.equal(isMeetingDocumentHtml(presentBody, meetingId), true, meetingId);
    assert.match(presentBody, new RegExp(`<h1>[^<]+</h1>`), meetingId);
  }

  const calendar = await edgeWorker.fetch(new Request(
    `https://cityscroll.org/meeting.ics?id=${encodeURIComponent(communityBoardId)}`,
  ), env);
  assert.equal(calendar.status, 200);
  assert.match(calendar.headers.get("content-type") || "", /text\/calendar/);
  assert.match(calendar.headers.get("content-disposition") || "", /attachment; filename="meeting-/);
  const calendarBody = await calendar.text();
  assert.match(calendarBody, /BEGIN:VCALENDAR/);
  assert.match(calendarBody, /DTSTART(?:;VALUE=DATE|;TZID=America\/New_York)?:20261015/);

  const cityRecordCalendar = await edgeWorker.fetch(new Request(
    `https://cityscroll.org/meeting.ics?id=${encodeURIComponent(cityRecordId)}`,
  ), env);
  assert.equal(cityRecordCalendar.status, 200);
  assert.match(cityRecordCalendar.headers.get("content-type") || "", /text\/calendar/);
  assert.match(await cityRecordCalendar.text(), /BEGIN:VCALENDAR/);

  const head = await edgeWorker.fetch(new Request(`https://cityscroll.org/meetings/${encodeURIComponent(communityBoardId)}/`, { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.deepEqual(requestedPaths.filter((path) => path.startsWith("/meetings/")), [], "edge resolution must not fetch an encoded per-id asset");
});

test("the built Meetings listing is covered by the shared read model", () => {
  const outputs = new Map(primaryDocumentOutputs());
  const listing = outputs.get([...outputs.keys()].find((path) => path.endsWith("site/browse/meetings/index.html")));
  const readModel = JSON.parse(sharedMeetingOutputs().find(([path]) => path.endsWith("site/data/shared_meeting_read_model.json"))[1]);
  const listedIds = [...listing.matchAll(/data-record-id="([^"]+)"/g)].map((match) => match[1]);
  const readableIds = new Set(readModel.rows.map((row) => row.meeting_id));
  const missing = listedIds.filter((id) => !readableIds.has(id));
  assert.ok(listedIds.length > 0, "the built Meetings listing must contain records");
  assert.deepEqual(missing, [], "every listed meeting must be present in the resolver catalog");
});

test("materialized City Record meetings resolve with notice richness and no request-time source fetch", async () => {
  const readModel = JSON.parse(sharedMeetingOutputs().find(([path]) => path.endsWith("shared_meeting_read_model.json"))[1]);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (request) => {
    const url = new URL(String(request.url || request));
    calls.push(url);
    throw new Error(`unexpected request-time meeting source fetch: ${url}`);
  };
  try {
    const env = {
      ASSETS: {
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/data/shared_meeting_read_model.json") {
            return new Response(JSON.stringify(readModel), { status: 200 });
          }
          return new Response("shell", { status: 200 });
        },
      },
    };
    for (const [requestId, expected] of [
      ["20260810053", /Design Commission Meeting Agenda/],
      ["20260713006", /DCWP NOH Rules Relating to Waitlist/],
    ]) {
      const meetingId = `meeting:city_record:${requestId}`;
      const row = readModel.rows.find((candidate) => candidate.meeting_id === meetingId);
      assert.ok(row, `${requestId} should be materialized`);
      assert.match(row.additional_description_1 || "", /./, `${requestId} should retain notice description`);
      assert.ok(row.street_address_1 || row.document_links?.length || row.source_links?.length, `${requestId} should retain a source-rich field`);
      const response = await edgeWorker.fetch(new Request(`https://cityscroll.org/meetings/${encodeURIComponent(meetingId)}/`), env);
      assert.equal(response.status, 200, requestId);
      const body = await response.text();
      assert.equal(isMeetingDocumentHtml(body, meetingId), true, requestId);
      assert.match(body, expected, requestId);
      assert.match(body, /Notice details/);
    }

    const unknownId = "meeting:city_record:20990101001";
    const unknown = await edgeWorker.fetch(new Request(`https://cityscroll.org/meetings/${encodeURIComponent(unknownId)}/`), env);
    assert.equal(unknown.status, 404);
    assert.equal(calls.length, 0, "meeting routes must not fetch the live hearings source");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("entity routes serve agency constellation documents when present, else the SPA shell", async () => {
  const home = "<title>CityScroll · track RFPs, rezonings, meetings</title><div id=\"entityview\">Agency profile</div>";
  const constellation = '<main data-civic-object-kind="agency-constellation" data-subject-ref="agency:id:housing-preservation-and-development"><h1>Housing Preservation and Development</h1><h2>Records by category</h2></main>';
  const env = {
    ASSETS: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
        if (path === "/agencies/housing-preservation-and-development" || path === "/agencies/parks-and-recreation") {
          return new Response(constellation, { headers: { "Content-Type": "text/html" } });
        }
        if (path.startsWith("/agencies/") && path !== "/agencies") {
          // Unknown agency ids fall through to the SPA shell.
          return new Response(home, { headers: { "Content-Type": "text/html" } });
        }
        return new Response(home, { headers: { "Content-Type": "text/html" } });
      },
    },
  };
  const entity = await edgeWorker.fetch(new Request("https://cityscroll.org/agencies/hpd/"), env);
  assert.equal(entity.status, 200);
  assert.match(await entity.text(), /id="entityview"/);
  const housingAlias = await edgeWorker.fetch(new Request(
    "https://cityscroll.org/agencies/n-y-c-housing-authority/?claim=staffing%3Aexam%3A1017",
  ), env);
  assert.equal(housingAlias.status, 308);
  assert.equal(
    housingAlias.headers.get("Location"),
    "https://cityscroll.org/agencies/housing-authority/?claim=staffing%3Aexam%3A1017",
  );
  const parks = await edgeWorker.fetch(new Request("https://cityscroll.org/agencies/parks-and-recreation/"), env);
  assert.equal(parks.status, 200);
  const parksBody = await parks.text();
  assert.match(parksBody, /data-civic-object-kind="agency-constellation"/);
  assert.match(parksBody, /Records by category/);
  const entityHead = await edgeWorker.fetch(new Request("https://cityscroll.org/agencies/hpd/", { method: "HEAD" }), env);
  assert.equal(entityHead.status, 200);
  assert.equal(await entityHead.text(), "");
  const interactive = await edgeWorker.fetch(new Request("https://cityscroll.org/agencies/parks-and-recreation/?tab=forecast"), env);
  assert.equal(interactive.status, 200);
  assert.match(await interactive.text(), /id="entityview"/);

  const agencyIndex = read("../site/agencies/index.html");
  assert.equal(agencyIndex, renderAgencyIndex());
  const links = [...agencyIndex.matchAll(/href="(\/agencies\/[^\"]+\/?)"/g)].map((match) => match[1]);
  assert.ok(links.length > 0, "agency index must not be hollow");
  for (const href of links.slice(0, 5)) {
    const response = await edgeWorker.fetch(new Request(`https://cityscroll.org${href}`), env);
    assert.equal(response.status, 200, href);
    const body = await response.text();
    assert.match(body, /id="entityview"|data-civic-object-kind="agency-constellation"/, href);
  }

  const land = await edgeWorker.fetch(new Request("https://cityscroll.org/browse/land/"), env);
  assert.equal(land.status, 302);
  assert.equal(land.headers.get("Location"), "https://cityscroll.org/browse/zoning/");

  const unknown = await edgeWorker.fetch(new Request("https://cityscroll.org/browse/unknown/"), env);
  assert.equal(unknown.status, 404);
  assert.doesNotMatch(await unknown.text(), /track RFPs, rezonings, meetings/);
});

test("generated agency pivots round-trip to content-bearing entity routes", async () => {
  const htmlFiles = readdirSync(new URL("../site/", import.meta.url), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(entry.parentPath || entry.path, entry.name));
  const hrefs = new Map();
  for (const path of htmlFiles) {
    const html = readFileSync(path, "utf8");
    for (const match of html.matchAll(/href="(\/agencies\/[^\"?#]+\/?)(?:\?[^\"]*)?"/g)) hrefs.set(match[1], path);
  }
  assert.ok(hrefs.size > 0, "generated surfaces must emit agency pivots");
  const home = "<main id=\"entityview\">Agency profile</main>";
  const env = {
    ASSETS: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
        if (path.startsWith("/agencies/") && path !== "/agencies") {
          const id = path.slice("/agencies/".length);
          return new Response(
            `<main data-civic-object-kind="agency-constellation" data-subject-ref="agency:id:${id}"><h2>Records by category</h2></main>`,
            { headers: { "Content-Type": "text/html" } },
          );
        }
        return new Response(home, { headers: { "Content-Type": "text/html" } });
      },
    },
  };
  for (const [href, source] of hrefs) {
    let response = await edgeWorker.fetch(new Request(`https://cityscroll.org${href}`), env);
    if (response.status === 308) {
      const location = response.headers.get("Location");
      assert.ok(location, `${source}: ${href} redirect has a target`);
      response = await edgeWorker.fetch(new Request(location), env);
    }
    assert.equal(response.status, 200, `${source}: ${href}`);
    const body = await response.text();
    assert.match(body, /id="entityview"|data-civic-object-kind="agency-constellation"|Records by category/, `${source}: ${href}`);
  }
});

test("Browse landing and every bounded child are exact build outputs with useful no-JS HTML", () => {
  const outputs = primaryDocumentOutputs();
  assert.equal(outputs.length, 11);
  for (const [path, generated] of outputs) {
    if (existsSync(path)) assert.equal(readFileSync(path, "utf8"), generated, `${path} is stale`);
    assert.match(generated, /<base href="\/">/);
    assert.match(generated, /data-document-rendered="true"/);
    assert.doesNotMatch(generated, /<link rel="canonical" href="https:\/\/cityscroll\.org\/">/);
  }
  const output = (suffix) => outputs.find(([path]) => path.endsWith(suffix))?.[1] || "";
  const now = output("/site/now/index.html");
  assert.match(now, /data-build-rendered="now"/);
  assert.match(now, /data-now-item=/);
  assert.match(now, /href="\/notices\/[A-Za-z0-9_-]+"/);
  assert.match(now, />Browse city topics<\/a>/);
  assert.doesNotMatch(now, /Browse every source/i);
  assert.doesNotMatch(now, /class="browse-child-nav"[^>]*>[\s\S]{0,300}data-tab=/);
  const landing = output("/site/browse/index.html");
  assert.match(landing, /data-build-rendered="browse-landing"/);
  assert.match(landing, /<h2[^>]*>Browse NYC’s public record<\/h2>/);
  assert.match(landing, /href="\/browse\/contracts\/"/);
  assert.match(landing, /40 open opportunities/);
  assert.match(landing, /228 civil-service exams/);
  assert.match(landing, /Pick a civic object\. Follow the edges between people, places, agencies, contracts, and decisions\./);
  const exams = output("/site/browse/exams/index.html");
  assert.match(exams, /data-browse-route-alias="exams"/);
  assert.match(exams, /id="tab-people" class="tabpane active"/);
  assert.match(exams, /id="career-guide"/);
  assert.match(exams, /id="career-results"/);
  assert.match(exams, /id="staffing-ledger" hidden/);
  assert.doesNotMatch(exams, /data-build-rendered="browse-exams"/);
  assert.doesNotMatch(exams, /data-browse-object-family="exams"/);
  assert.doesNotMatch(exams, /id="tab-exams"/);
  assert.doesNotMatch(exams, /Coming soon|data-browse-stub/);
  assert.match(landing, /<details class="browse-source-disclosure"><summary>Official data from…<\/summary>/);
  assert.doesNotMatch(landing, /every source|source view|source lenses/i);
  assert.deepEqual(detectNodePageCruft(landing), []);
  assert.doesNotMatch(landing, /data-browse-facet="contracts"/);
  for (const kind of Object.keys(BROWSE_CONCEPTS)) {
    const html = output(`/site/browse/${kind}/index.html`);
    assert.match(html, new RegExp(`data-browse-concept="${kind}"`));
    assert.match(html, /data-build-rendered="browse-concept"/);
    assert.match(html, kind === "people" ? /Officials/ : /Community boards/);
  }
  for (const facet of Object.keys(BROWSE_FACETS)) {
    const html = output(`/site/browse/${facet}/index.html`);
    assert.match(html, new RegExp(`data-browse-facet="${facet}"`));
    assert.match(html, /data-record-id=/);
    assert.doesNotMatch(html, /data-build-rendered="browse"[\s\S]{0,200}<span class="loading"/);
  }
});

test("People and Places landings use populated entity and geography indexes", () => {
  const people = buildBrowseConceptLanding("people", {
    people: { by_person_id: { "7801": { person_id: "7801", person_name: "Christopher Marte" } } },
    committees: {
      publication: "published",
      nodes: [{ id: "committee:1", type: "committee", name: "Committee on Housing" }],
      public_edges: [{ type: "member_of", from: "official:7801", to: "committee:1" }],
    },
    awards: { rows: [{ vendor_name: "ACME LLC" }] },
    places: {
      nodes: [{
        id: "community-board:bronx-cb-01",
        type: "community-board",
        name: "Bronx Community Board 1",
        properties: { borough: "Bronx", district: 1 },
      }],
      public_edges: [{ type: "covers", from: "community-board:bronx-cb-01", to: "community-district:X01" }],
    },
  });
  const peopleHtml = renderBrowseConceptLanding(people);
  assert.match(peopleHtml, /href="\/officials\/7801\/"/);
  assert.match(peopleHtml, /href="\/vendors\/ACME\/"/);
  assert.match(peopleHtml, /Committee on Housing/);
  assert.match(peopleHtml, /Bronx Community Board 1/);
  assert.match(peopleHtml, /href="\/community-boards\/bronx-cb-01\/"/);
  assert.match(peopleHtml, /data-body-id="bronx-cb-01"/);
  assert.match(peopleHtml, /District coverage · Published/);
  assert.match(peopleHtml, /Members · Unknown/);
  assert.match(peopleHtml, /Hosted meetings · Unknown/);
  assert.doesNotMatch(peopleHtml, /href="\/committees\//);

  const places = buildBrowseConceptLanding("places", {
    places: {
      nodes: [{ id: "community-board:bronx-cb-01", type: "community-board", name: "Bronx Community Board 1", properties: { borough: "Bronx", district: 1 } }],
      public_edges: [{ type: "covers", from: "community-board:bronx-cb-01", to: "community-district:X01" }],
    },
  });
  const placesHtml = renderBrowseConceptLanding(places);
  assert.doesNotMatch(placesHtml, /Bronx Community Board 1/);
  assert.match(placesHtml, /Open Near you for place discovery/);
  assert.doesNotMatch(placesHtml, /59/);
  assert.match(placesHtml, /\/community-boards\//);
  const placesDocument = primaryDocumentOutputs().find(([path]) => path.endsWith("/browse/places/index.html"));
  assert.ok(placesDocument, "the Places document is generated");
  assert.match(placesDocument[1], /id="tab-browse" class="tabpane active"/);
  assert.match(placesDocument[1], /data-browse-concept="places"/);
  assert.doesNotMatch(placesDocument[1], />Places<\/a>/);

  const examsDocument = primaryDocumentOutputs().find(([path]) => path.endsWith("/browse/exams/index.html"));
  assert.ok(examsDocument, "the Exams document is generated");
  assert.match(examsDocument[1], /<title>Exams · Browse · CityScroll<\/title>/);
  assert.match(examsDocument[1], /rel="canonical" href="https:\/\/cityscroll\.org\/browse\/exams\/"/);
  assert.match(examsDocument[1], /data-browse-route-alias="exams"/);
  assert.match(examsDocument[1], /id="tab-people" class="tabpane active"/);
  assert.match(examsDocument[1], /id="career-guide"/);
  assert.match(examsDocument[1], /id="staffing-ledger" hidden/);
  assert.doesNotMatch(examsDocument[1], /data-build-rendered="browse-exams"/);
  assert.doesNotMatch(examsDocument[1], /id="tab-exams" class="tabpane active"/);
});

test("Exams is one data-only alias to the Staffing guide", () => {
  assert.deepEqual(Object.keys(BROWSE_ROUTE_ALIASES), ["exams"]);
  const alias = BROWSE_ROUTE_ALIASES.exams;
  assert.deepEqual({
    route: alias.route,
    targetRoute: alias.targetRoute,
    targetFacet: alias.targetFacet,
    targetTab: alias.targetTab,
    defaultView: alias.defaultView,
    corpus: alias.corpus,
  }, {
    route: "/browse/exams/",
    targetRoute: "/browse/staffing/",
    targetFacet: "staffing",
    targetTab: "people",
    defaultView: "guide",
    corpus: "exams",
  });
  const shell = read("../site/index.html");
  const html = buildBrowseAliasDocument(shell, "exams", { notices: [] });
  assert.match(html, /id="career-guide"/);
  assert.match(html, /data-browse-route-alias="exams"/);
  assert.match(html, /id="staffing-ledger" hidden/);
  assert.doesNotMatch(html, /data-browse-object-family="exams"/);
});

test("Browse landing counts are labeled with source dates without coverage caveats", () => {
  const landing = buildBrowseLanding({
    contracts: { open_as_of: "2026-08-03", notices: Array.from({ length: 3 }, (_, i) => ({ request_id: String(i) })) },
    staffing: { generated_at: "2026-08-02T12:00:00Z", notices: Array.from({ length: 4 }, (_, i) => ({ request_id: String(i) })) },
    zoning: { generated_at: "2026-08-05T12:00:00Z", projects: [{ project_id: "P1" }] },
    property: { generated_at: "2026-08-02T12:00:00Z", property_rows: [{ request_id: "P" }] },
    rules: { retrieved_at: "2026-08-03T12:00:00Z", rows: [{ request_id: "R" }] },
    meetings: { retrieved_at: "2026-08-02T12:00:00Z", rows: [{ request_id: "M" }] },
  }, { staffingExamCount: 228, staffingExamAsOf: "2026-07-22" });
  assert.equal(landing.cards.length, 6);
  assert.equal(landing.cards[0].count, 3);
  assert.equal(landing.cards.find((card) => card.id === "people-organizations").secondaryCount, 228);
  const html = renderBrowseLanding(landing);
  assert.match(html, /Updated 2026-08-03/);
  assert.match(html, /class="ui-constellation-link browse-source-action"/);
  assert.match(html, /class="ui-static-fact browse-card-sources"/);
  assert.doesNotMatch(html, /Counts describe|full historical history|bounded|joined by parcel/i);
});

test("Browse landing hides objects without a positive primary count", () => {
  const landing = buildBrowseLanding({
    contracts: { open_as_of: "2026-08-03", notices: [{ request_id: "1" }] },
  });
  const html = renderBrowseLanding(landing);
  assert.match(html, /id="source-contracts"/);
  assert.doesNotMatch(html, /id="source-places"/);
  assert.doesNotMatch(html, />Places<\/h3>/);
  assert.equal(landing.cards.length, 6, "the six civic-object groups remain in the model");
});

test("Browse landing omits the empty card grid when no object is ready", () => {
  const html = renderBrowseLanding(buildBrowseLanding({}));
  assert.match(html, /data-build-rendered="browse-landing"/);
  assert.doesNotMatch(html, /browse-source-grid/);
  assert.doesNotMatch(html, /<article class="browse-source-card"/);
});

test("public identity copy describes a linked multi-source record", () => {
  const index = read("../site/index.html");
  const about = read("../site/about.html");
  for (const html of [index, about, read("../site/api.html"), read("../site/stats.html")]) {
    assert.doesNotMatch(html, /search interface over|searches the City Record Open Data|the City Record, made legible|The City Record, searchable/i);
  }
  assert.match(index, /NYC’s public record/);
  assert.match(index, /agencies, mandates, parcels, people, and processes/);
  assert.match(index, /City Record as one source among five/);
  assert.match(index, /August 5, 2026/);
  assert.match(about, /NYC’s public record, linked/);
});

test("Browse edge filtering is semantic and uses a copy-free live-filter loading state", () => {
  const payload = {
    open_as_of: "2026-08-05",
    notices: [
      { request_id: "1", short_title: "Queens bridge repair", agency_name: "DOT", due_date: "2026-08-09" },
      { request_id: "2", short_title: "Bronx tree care", agency_name: "Parks", due_date: "2026-09-30" },
    ],
  };
  const view = buildBrowseView("contracts", payload, new URLSearchParams("q=bridge&closing=week&mode=award"));
  assert.equal(view.total, 1);
  assert.deepEqual(view.liveOnlyFilters, ["mode"]);
  const html = renderBrowseView(view);
  assert.match(html, /class="ui-constellation-link browse-record-link"[^>]*href="\/notices\/1"/);
  assert.match(html, /class="ui-constellation-link browse-agency-link"/);
  assert.match(html, /class="note warn browse-filter-disclosure"[^>]+role="status"/);
  assert.doesNotMatch(html, /need the live Browse controls|bounded default|until the page is enhanced/i);
  assert.doesNotMatch(html, /Bronx tree care/);
});

test("Browse record cards lead with typed action time and keep undated rows title-led", () => {
  assert.deepEqual(
    browseActionTime("contracts", { due_date: "2026-08-09T10:30:00.000" }),
    { label: "Responses due", date: "2026-08-09T10:30:00.000" },
  );
  assert.deepEqual(
    browseActionTime("meetings", { type_of_notice_description: "Public Hearings", event_date: "2026-08-19T10:00:00.000" }),
    { label: "Hearing", date: "2026-08-19T10:00:00.000" },
  );
  assert.equal(browseActionTime("rules", { start_date: "2026-08-05" }), null);

  const html = renderBrowseView(buildBrowseView("contracts", {
    notices: [{ request_id: "1", short_title: "Bridge repair", due_date: "2026-08-09" }],
  }));
  assert.match(html, /class="browse-record-action"[^>]*>.*Responses due.*2026-08-09/s);
  assert.ok(html.indexOf("browse-record-action") < html.indexOf("Bridge repair"));
  assert.doesNotMatch(html, /Official data from/);
});

test("legacy fragments use a finite location.replace bridge and preserve language", () => {
  const calls = [];
  const location = {
    href: "https://cityscroll.org/?lang=es#notice/20240515016",
    pathname: "/",
    search: "?lang=es",
    hash: "#notice/20240515016",
    replace(value) { calls.push(value); },
  };
  assert.equal(forwardLegacyFragment(location), true);
  assert.deepEqual(calls, ["/notices/20240515016?lang=es"]);
  location.href = "https://cityscroll.org/#matter/84124P0003001";
  location.search = "";
  location.hash = "#matter/84124P0003001";
  assert.equal(forwardLegacyFragment(location), false);
  assert.equal(calls.length, 1);
});

test("notice response renderer supplies semantic HTML before the enhancement island", () => {
  const html = renderEdgeNotice({
    request_id: "20240515016",
    short_title: "Forest <management>",
    agency_name: "Parks & Recreation",
    type_of_notice_description: "Solicitation",
    due_date: "2026-08-20T00:00:00.000",
    pin: "PIN-1",
    additional_description_1: "Public notice text",
  }, "20240515016");
  assert.match(html, /data-edge-rendered="notice"/);
  assert.match(html, /Forest &lt;management&gt;/);
  assert.match(html, /<dt>Responses due<\/dt>/);
  assert.match(html, /RequestDetail\/20240515016/);
  assert.match(html, /class="ui-constellation-link notice-agency-link"[^>]*href="\/agencies\/parks-and-recreation\/"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /class="ui-official-source-link"[^>]*>Official record<span aria-hidden="true">↗<\/span>/);
  assert.doesNotMatch(html, /ui-official-source-link act primary|class="act primary"[^>]+a856-cityrecord/);
  assert.doesNotMatch(html, /class="loading"/);
});

test("notice back control consumes a carried walk path", () => {
  const walk = encodeTraversalPath({ hops: [{
    source: { kind: "agency", id: "parks-and-recreation", name: "Parks and Recreation", href: "/agencies/parks-and-recreation/" },
    relation: "hosted meeting",
    destination: { kind: "notice", id: "20240515016", name: "Forest management", href: "/notices/20240515016" },
  }] });
  const html = renderEdgeNotice({
    request_id: "20240515016",
    short_title: "Forest management",
    agency_name: "Parks & Recreation",
    type_of_notice_description: "Solicitation",
  }, "20240515016", null, null, {
    currentHref: `https://cityscroll.org/notices/20240515016?walk=${walk}`,
  });
  assert.match(html, /data-route-back="traversal"/);
  assert.match(html, /href="\/agencies\/parks-and-recreation\/"/);
  assert.doesNotMatch(html, /href="\/browse\/"[^>]*data-route-back/);
});

test("notice response renderer preserves an attachment-only notice affordance", () => {
  const html = renderEdgeNotice({
    request_id: "20180705102",
    short_title: "ACS FY19 regulatory agenda",
    agency_name: "Administration for Children's Services",
    type_of_notice_description: "Notice",
    section_name: "Agency Rules",
    document_links: {
      url: "https://a856-cityrecord.nyc.gov/Search/GetFile?SectionID=4&amp;RequestID=20180705102&amp;DocumentID=3423",
    },
  }, "20180705102");
  assert.match(html, /notice-attachment-fallback/);
  assert.match(html, /Read the attachment/);
  assert.match(html, /DocumentID=3423/);
  assert.doesNotMatch(html, /Notice text/);
});

test("notice agency facts link only to reviewed agency pages", () => {
  const nycha = renderEdgeNotice({
    request_id: "20260626002",
    short_title: "Housing authority notice",
    agency_name: "Housing Authority",
    type_of_notice_description: "Solicitation",
  }, "20260626002");
  assert.match(nycha, /class="ui-constellation-link notice-agency-link"[^>]*href="\/agencies\/housing-authority\/"/);
  assert.match(nycha, /<dt>Agency<\/dt><dd[^>]*>.*aria-hidden="true">◆<\/span>Housing Authority/);

  const unresolved = renderEdgeNotice({
    request_id: "20260626003",
    short_title: "Unresolved notice",
    agency_name: "Agency Without A Profile",
    type_of_notice_description: "Solicitation",
  }, "20260626003");
  assert.match(unresolved, /<dt>Agency<\/dt><dd[^>]*>Agency Without A Profile<\/dd>/);
  assert.doesNotMatch(unresolved, /href="\/agencies\/agency-without-a-profile\//);
});

test("notice edge first paint links an accepted vendor to its canonical profile", () => {
  const html = renderEdgeNotice({
    request_id: "20260806014",
    short_title: "Information technology services",
    agency_name: "Police Department",
    vendor_name: "General Dynamics Information Technology Inc",
    type_of_notice_description: "Award",
  }, "20260806014");
  assert.match(html, /<dt>Vendor<\/dt><dd[^>]*>.*href="\/vendors\/GENERAL%20DYNAMICS%20INFORMATION%20TECHNOLOGY\/"/);
  assert.match(html, /data-link-confidence="strong"/);
});

test("missing notice response is a CityScroll object shell with internal continuation", () => {
  const html = renderEdgeNotice(null, "20991231999");
  assert.match(html, /data-edge-rendered="notice-unavailable"/);
  assert.match(html, /data-notice-id="20991231999"/);
  assert.match(html, /<p class="ftype">Public record<\/p>/);
  assert.match(html, /<h2 class="rolename">CityScroll public record 20991231999<\/h2>/);
  assert.match(html, /ui-constellation-link act primary[^>]+href="\/browse\/"/);
  assert.match(html, /ui-constellation-link[^>]+href="\/following\/"/);
  assert.match(html, /ui-official-source-link[^>]+>Official record<span aria-hidden="true">↗<\/span>/);
  assert.doesNotMatch(html, /City Record notice|View City Record|ui-official-source-link act primary/);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("notice response renderer includes a known meeting outcome or honest absence", () => {
  const row = {
    request_id: "20260805001",
    short_title: "Community meeting",
    agency_name: "City Council",
    section_name: "Public Hearings and Meetings",
  };
  const html = renderEdgeNotice(row, row.request_id, {
    request_id: row.request_id,
    snapshot_state: "absent",
  });
  assert.match(html, /data-meeting-outcomes-first-paint="1"/);
  assert.match(html, /No decision documents published for this meeting\./);
  assert.doesNotMatch(html, /class="loading"/);
});

test("Pages edge routing is a narrow waist and explicitly excludes the public Stats document", () => {
  assert.equal(edgeRequestKind("https://cityscroll.org/browse/"), "asset");
  assert.equal(edgeRequestKind("https://cityscroll.org/notices/20240515016"), "notice");
  assert.equal(edgeRequestKind("https://cityscroll.org/browse/rules/?q=air"), "browse");
  assert.equal(edgeRequestKind("https://cityscroll.org/browse/people/"), "browse");
  assert.equal(edgeRequestKind("https://cityscroll.org/browse/places/"), "browse");
  assert.equal(edgeRequestKind("https://cityscroll.org/agencies/design-and-construction/"), "entity");
  assert.equal(edgeRequestKind("https://cityscroll.org/vendors/CAMBA/"), "entity");
  assert.equal(edgeRequestKind("https://cityscroll.org/officials/7801/"), "entity");
  assert.equal(edgeRequestKind("https://cityscroll.org/stats.html"), "asset");
  assert.equal(edgeRequestKind("https://api.cityscroll.org/stats"), "asset");
  const routes = JSON.parse(read("../site/_routes.json"));
  assert.deepEqual(routes.exclude, ["/stats.html"]);
  assert.ok(routes.include.includes("/meeting.ics"));
  assert.ok(!routes.exclude.includes("/meeting.ics"));
  assert.ok(routes.include.length <= 100, "Pages Functions route include limit");
  assert.ok(routes.include.includes("/notices/*"));
  assert.ok(routes.include.includes("/agencies/*"));
  assert.ok(routes.include.includes("/vendors/*"));
  assert.ok(routes.include.includes("/officials/*"));
  assert.ok(routes.include.includes("/browse/*"));
});

test("Stats document and API keep their exact public endpoints with the reduced coverage contract", async () => {
  const html = read("../site/stats.html");
  assert.match(html, /<link rel="canonical" href="https:\/\/cityscroll\.org\/stats\.html">/);
  assert.match(html, /https:\/\/api\.cityscroll\.org\/stats/);
  const worker = read("../worker/src/worker.mjs");
  assert.match(worker, /pathname === "\/stats"\) return handleStats/);
  const env = { ALERT_STATE: fakeKV(), NL_METER: fakeKV(), SUBS: fakeKV() };
  const response = await handleStats(new Request("https://api.cityscroll.org/stats"), env, { waitUntil() {} }, {
    now: "2026-08-05T12:00:00Z",
    fetchImpl: async () => Response.json([{
      notice_count: "1099194",
      first_notice_date: "2003-01-02T00:00:00.000",
      latest_notice_date: "2026-08-05T00:00:00.000",
    }]),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.schema, "public-stats.v2");
  assert.equal(body.city_record.notice_count, 1099194);
  assert.equal(body.sources.primary_system_count, 6);
  assert.equal(body.language_coverage.site_languages, 11);
  for (const privateField of ["subscriptions", "digests", "nl_search", "history", "usage"]) {
    assert.equal(Object.hasOwn(body, privateField), false, `${privateField} stays behind the desk`);
  }
});

test("client island recognizes promoted document routes without converting entity or matter pages", () => {
  const routing = read("../site/app/routing.mjs");
  const main = read("../site/app/main.mjs");
  assert.match(routing, /function documentRouteRaw\(\)/);
  assert.match(routing, /\^\\\/notices\\\//);
  assert.match(routing, /\^\\\/browse/);
  assert.match(main, /CrolRouteMigration = await import/);
  assert.doesNotMatch(routing, /pathname.*(?:entity|matter)/);
});

test("client island preserves static Browse concept documents", () => {
  const routing = read("../site/app/routing.mjs");
  const core = read("../site/app/core.mjs");
  assert.match(routing, /DOCUMENT_CONCEPT_ROUTES/);
  assert.match(routing, /browse-concept\//);
  assert.match(routing, /if\(raw\.startsWith\("browse-concept\/"\)\) return true/);
  assert.match(core, /if\(!document\.getElementById\(`tab-\$\{b\.dataset\.tab\}`\)\) return;/);
});
